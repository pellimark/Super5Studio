import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createResultsService } from "../results-service.mjs";
import { nextScheduledDraw } from "../next-draw.js";
import { parseOfficialHistory, refreshArchive } from "../update-results.mjs";

const archivePath = new URL("../data/super5-draws.json", import.meta.url);
const fixturePath = (name) => new URL("./fixtures/" + name, import.meta.url);

async function fixture(name) {
  return parseOfficialHistory(await readFile(fixturePath(name), "utf8"));
}

async function temporaryArchive(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "super5-refresh-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const targetPath = path.join(directory, "super5-draws.json");
  const source = await readFile(archivePath, "utf8");
  await writeFile(targetPath, source, "utf8");
  return { directory, targetPath, source };
}

test("a current official-history fixture leaves the saved archive byte-for-byte unchanged", async (t) => {
  const saved = await temporaryArchive(t);
  const result = await refreshArchive({
    targetPath: saved.targetPath,
    fetchResults: () => fixture("history-current.html"),
    now: () => new Date("2026-10-21T12:00:00.000Z")
  });
  assert.equal(result.added, 0);
  assert.equal(result.archive.coverage.lastDraw, 393);
  assert.equal(await readFile(saved.targetPath, "utf8"), saved.source);
});

test("one new draw is appended and archive metadata is preserved", async (t) => {
  const saved = await temporaryArchive(t);
  const result = await refreshArchive({
    targetPath: saved.targetPath,
    fetchResults: () => fixture("history-one-new.html"),
    now: () => new Date("2026-10-21T22:30:00.000Z")
  });
  const previous = JSON.parse(saved.source);
  const updated = JSON.parse(await readFile(saved.targetPath, "utf8"));
  assert.equal(result.added, 1);
  assert.deepEqual(updated.draws.slice(-2).map(({ draw }) => draw), [393, 394]);
  assert.equal(updated.draws.at(-1).date, "2026-10-21");
  assert.equal(updated.source, previous.source);
  assert.equal(updated.sourceUrl, previous.sourceUrl);
  assert.equal(updated.coverage.firstDraw, previous.coverage.firstDraw);
  assert.equal(updated.coverage.firstDate, previous.coverage.firstDate);
  assert.equal(updated.coverage.lastDraw, 394);
  assert.equal(updated.coverage.drawCount, previous.coverage.drawCount + 1);
  assert.equal(updated.formats.find(({ name }) => name === "5/45").throughDraw, 258);
  assert.equal(updated.formats.find(({ name }) => name === "5/49").throughDraw, 394);
  assert.equal(updated.retrievedAt, "2026-10-22");
});

test("multiple new draws are ordered by draw number even when the fixture is newest first", async (t) => {
  const saved = await temporaryArchive(t);
  const result = await refreshArchive({
    targetPath: saved.targetPath,
    fetchResults: () => fixture("history-multiple-new.html"),
    now: () => new Date("2026-10-23T12:00:00.000Z")
  });
  const updated = JSON.parse(await readFile(saved.targetPath, "utf8"));
  assert.equal(result.added, 2);
  assert.deepEqual(updated.draws.slice(-3).map(({ draw }) => draw), [393, 394, 395]);
  assert.deepEqual(updated.draws.slice(-2).map(({ date }) => date), ["2026-10-21", "2026-10-23"]);
});

for (const [name, expectedError] of [
  ["history-missing-draw.html", /skip draw 394/i],
  ["history-invalid-date.html", /invalid date/i],
  ["history-invalid-numbers.html", /numbers from 1 to 49/i],
  ["history-changed-history.html", /differs from the saved archive/i],
  ["history-stale.html", /does not show the saved latest draw 393/i]
]) {
  test(name + " is rejected without changing the saved archive", async (t) => {
    const saved = await temporaryArchive(t);
    await assert.rejects(refreshArchive({
      targetPath: saved.targetPath,
      fetchResults: () => fixture(name),
      now: () => new Date("2026-10-24T12:00:00.000Z")
    }), expectedError);
    assert.equal(await readFile(saved.targetPath, "utf8"), saved.source);
  });
}

test("only Wednesday and Friday schedule dates are shown, using Malta's calendar date", () => {
  const latest = { draw: 393, date: "2026-10-16" };
  assert.deepEqual(nextScheduledDraw(latest, new Date("2026-10-21T09:00:00.000Z")), {
    draw: 394, date: "2026-10-21"
  });
  // UTC is still Wednesday here, while Malta has crossed into Thursday.
  assert.deepEqual(nextScheduledDraw(latest, new Date("2026-10-21T22:30:00.000Z")), {
    draw: 394, date: "2026-10-23"
  });
  // UTC is still Friday, while Malta has crossed into Saturday.
  assert.deepEqual(nextScheduledDraw(latest, new Date("2026-10-23T22:30:00.000Z")), {
    draw: 394, date: "2026-10-28"
  });
  assert.deepEqual(nextScheduledDraw({ draw: 394, date: "2026-10-21" }, new Date("2026-10-21T09:00:00.000Z")), {
    draw: 395, date: "2026-10-23"
  });
});

test("concurrent snapshot requests share one background refresh and return the saved archive immediately", async (t) => {
  const saved = await temporaryArchive(t);
  let resolveSource;
  const blockedSource = new Promise((resolve) => { resolveSource = resolve; });
  let resolveFetchStarted;
  const fetchStarted = new Promise((resolve) => { resolveFetchStarted = resolve; });
  let fetchCount = 0;
  const service = createResultsService({
    archivePath: saved.targetPath,
    checkStatePath: path.join(saved.directory, "results-check.json"),
    refreshIntervalMs: 60_000,
    now: () => new Date("2026-10-21T12:00:00.000Z"),
    fetchResults: () => { fetchCount += 1; resolveFetchStarted(); return blockedSource; }
  });

  const [first, second] = await Promise.all([service.getSnapshot(), service.getSnapshot()]);
  assert.equal(first.archive.coverage.lastDraw, 393);
  assert.equal(second.archive.coverage.lastDraw, 393);
  assert.equal(first.refreshing, true);
  assert.equal(second.refreshing, true);
  await fetchStarted;
  assert.equal(fetchCount, 1);
  resolveSource(await fixture("history-one-new.html"));
  await service.waitForRefresh();
  assert.equal((await service.getSnapshot()).archive.coverage.lastDraw, 394);
  assert.equal(fetchCount, 1);
});

test("a recently completed refresh is not repeated", async (t) => {
  const saved = await temporaryArchive(t);
  let fetchCount = 0;
  const service = createResultsService({
    archivePath: saved.targetPath,
    checkStatePath: path.join(saved.directory, "results-check.json"),
    refreshIntervalMs: 60_000,
    now: () => new Date("2026-10-21T12:00:00.000Z"),
    fetchResults: async () => {
      fetchCount += 1;
      return fixture("history-current.html");
    }
  });

  assert.equal((await service.getSnapshot()).refreshing, true);
  await service.waitForRefresh();
  const next = await service.getSnapshot();
  assert.equal(next.refreshing, false);
  assert.equal(next.lastCheck.status, "success");
  assert.equal(fetchCount, 1);
});
