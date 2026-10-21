import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { buildPositionModel, predictOutcomes } from "../position-predictor.js";

const SETTINGS = { closest: 4, balanced: 3, varied: 2 };
const sharedNumbers = (a, b) => a.filter((number) => b.includes(number)).length;

function assertValidSet(lines, max, cap) {
  assert.equal(new Set(lines.map((line) => line.join(","))).size, lines.length);
  for (const [index, line] of lines.entries()) {
    assert.equal(line.length, 5);
    assert.ok(line.every((number, position) => Number.isInteger(number) && number >= 1 && number <= max &&
      (position === 0 || number > line[position - 1])));
    for (const other of lines.slice(0, index)) {
      assert.ok(sharedNumbers(line, other) <= cap, `${line} and ${other} exceed the cap of ${cap}`);
    }
  }
}

// Independent reference: enumerate and rank the entire small space, then scan
// it for each selection. No score bounds or production search helpers involved.
function rankedCombinations(model, max) {
  const all = [];
  function enumerate(numbers, next) {
    if (numbers.length === 5) {
      all.push({ numbers, score: numbers.reduce((sum, number, index) => sum + Math.log(model[index].scores[number]), 0) });
      return;
    }
    for (let value = next; value <= max; value += 1) enumerate([...numbers, value], value + 1);
  }
  enumerate([], 1);
  all.sort((a, b) => b.score - a.score || a.numbers.reduce((difference, number, index) => difference || number - b.numbers[index], 0));
  return all.map(({ numbers }) => numbers);
}

function selectReference(ranked, count, cap) {
  const selected = [];
  for (const line of ranked) {
    if (selected.every((other) => sharedNumbers(line, other) <= cap)) selected.push(line);
    if (selected.length === count) break;
  }
  return selected;
}

test("learns what follows each position instead of pooling all five balls", () => {
  const a = [1, 4, 7, 10, 13];
  const b = [2, 5, 8, 11, 14];
  const draws = Array.from({ length: 41 }, (_, index) => ({ numbers: index % 2 ? b : a }));
  const model = buildPositionModel(draws, 15);
  assert.deepEqual(predictOutcomes(model, 15, 1), [b]);
  assert.ok(model.every((position) => position.transitionCount === 20));
});

test("falls back to positional frequency when no follow-ups exist", () => {
  const numbers = [2, 5, 9, 12, 14];
  const model = buildPositionModel([{ numbers }], 15);
  assert.ok(model.every((position) => position.transitionCount === 0));
  assert.deepEqual(predictOutcomes(model, 15, 1), [numbers]);
  assert.ok(model.every((position) => Math.abs(position.scores.reduce((sum, value) => sum + value, 0) - 1) < 1e-12));
});

test("each setting chooses the highest-ranked compatible lines from the entire space", () => {
  const model = buildPositionModel([
    { numbers: [1, 3, 4, 7, 9] }, { numbers: [2, 4, 5, 6, 8] },
    { numbers: [1, 2, 3, 5, 6] }, { numbers: [1, 3, 4, 7, 9] }
  ], 9);
  const ranked = rankedCombinations(model, 9);
  assert.equal(ranked.length, 126);
  assert.deepEqual(predictOutcomes(model, 9, 10, "closest"), ranked.slice(0, 10));
  for (const [setting, cap] of Object.entries(SETTINGS)) {
    const actual = predictOutcomes(model, 9, 10, setting);
    assert.deepEqual(actual, selectReference(ranked, 10, cap));
    assertValidSet(actual, 9, cap);
  }
  assert.deepEqual(predictOutcomes(model, 9, 10), predictOutcomes(model, 9, 10, "balanced"));
});

test("ties are deterministic and increasing the count preserves the prefix", () => {
  // Include nonzero logs to exercise score-bound addition and exact score ties.
  for (const score of [1, 1 / 9]) {
    const model = Array.from({ length: 5 }, () => ({ scores: new Array(10).fill(score) }));
    const ranked = rankedCombinations(model, 9);
    for (const [setting, cap] of Object.entries(SETTINGS)) {
      const ten = predictOutcomes(model, 9, 10, setting);
      assert.deepEqual(ten[0], [1, 2, 3, 4, 5]);
      assert.deepEqual(ten, selectReference(ranked, 10, cap));
      for (let count = 1; count <= 10; count += 1) {
        assert.deepEqual(predictOutcomes(model, 9, count, setting), ten.slice(0, count));
      }
    }
  }
});

test("diversity counts shared values even when they move to different positions", () => {
  const model = Array.from({ length: 5 }, () => ({ scores: new Array(10).fill(1) }));
  const closest = predictOutcomes(model, 9, 2, "closest");
  assert.deepEqual(closest[1], [1, 2, 3, 4, 6]);
  const balanced = predictOutcomes(model, 9, 3, "balanced");
  assert.deepEqual(balanced, [[1, 2, 3, 4, 5], [1, 2, 3, 6, 7], [1, 2, 3, 8, 9]]);
  // [1,2,3,7,8] matches only three positions in line 2 but shares FOUR numbers.
  assert.ok(!balanced.some((line) => line.join() === "1,2,3,7,8"));
});

test("reaches beyond a clustered top ten without relaxing diversity", () => {
  const model = buildPositionModel(Array.from({ length: 60 }, () => ({ numbers: [2, 5, 9, 12, 14] })), 15);
  const closest = predictOutcomes(model, 15, 10, "closest");
  assert.ok(closest.slice(1).every((line) => sharedNumbers(line, closest[0]) === 4));
  for (const setting of ["balanced", "varied"]) {
    const lines = predictOutcomes(model, 15, 10, setting);
    assert.equal(lines.length, 10);
    assert.deepEqual(lines[0], closest[0]);
    assertValidSet(lines, 15, SETTINGS[setting]);
    assert.ok(lines.slice(1).every((line) => !closest.some((other) => line.join() === other.join())));
  }
});

test("returns fewer lines when none remain compatible, without relaxing the cap", () => {
  const model = buildPositionModel([{ numbers: [1, 2, 3, 4, 5] }], 6);
  assert.equal(predictOutcomes(model, 6, 10, "closest").length, 6);
  for (const setting of ["balanced", "varied"]) {
    assert.deepEqual(predictOutcomes(model, 6, 10, setting), [[1, 2, 3, 4, 5]]);
  }
});

test("sorts copies and rejects invalid draws or outcome counts", () => {
  const draws = [{ numbers: [14, 2, 9, 5, 12] }];
  const original = structuredClone(draws);
  buildPositionModel(draws, 15);
  assert.deepEqual(draws, original);
  assert.throws(() => buildPositionModel([], 49), RangeError);
  assert.throws(() => buildPositionModel([{ numbers: [1, 2, 3, 4, 4] }], 49), RangeError);
  assert.throws(() => buildPositionModel([{ numbers: [1, 2, 3, 4, 46] }], 45), RangeError);
  const model = buildPositionModel(draws, 15);
  for (const count of [0, 11, 2.5, NaN]) assert.throws(() => predictOutcomes(model, 15, count), RangeError);
  for (const setting of ["unknown", "toString", null, 3]) {
    assert.throws(() => predictOutcomes(model, 15, 5, setting), RangeError);
  }
});

test("both eras produce ten diverse, deterministic lines within a practical generation budget", async (t) => {
  const archive = JSON.parse(await readFile(new URL("../data/super5-draws.json", import.meta.url), "utf8"));
  for (const max of [45, 49]) {
    const draws = archive.draws.filter((draw) => max === 45 ? draw.draw <= 258 : draw.draw >= 259);
    const model = buildPositionModel(draws, max);
    const original = structuredClone(model);
    const anchor = predictOutcomes(model, max, 1, "closest");
    for (const [setting, cap] of Object.entries(SETTINGS)) {
      const started = performance.now();
      const lines = predictOutcomes(model, max, 10, setting);
      const elapsed = performance.now() - started;
      t.diagnostic(`5/${max} ${setting}: ${elapsed.toFixed(1)} ms for ten lines`);
      assert.ok(elapsed < 2000, `5/${max} ${setting} took ${elapsed.toFixed(1)} ms`);
      assert.equal(lines.length, 10);
      assertValidSet(lines, max, cap);
      assert.deepEqual(lines.slice(0, 1), anchor);
      assert.deepEqual(predictOutcomes(buildPositionModel(draws, max), max, 10, setting), lines);
      for (const count of [1, 5, 9]) {
        assert.deepEqual(predictOutcomes(model, max, count, setting), lines.slice(0, count));
      }
    }
    assert.deepEqual(model, original, "selection must not mutate the position model");
  }
});
