import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createResultsService } from "./results-service.mjs";
import { validateArchive } from "./update-results.mjs";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml"
};

const FORMAT_BOUNDARY = 259;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[character]);
}

function formatDrawDate(isoDate, short = false) {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: short ? undefined : "long",
    day: "2-digit",
    month: short ? "short" : "long",
    year: "numeric",
    timeZone: "UTC"
  }).format(new Date(isoDate + "T12:00:00Z"));
}

function renderBalls(numbers) {
  return numbers.map((number) => `<span class="mini-ball">${escapeHtml(number)}</span>`).join("");
}

function renderDrawRows(draws, type) {
  return draws.map((draw) => {
    const numberLabel = escapeHtml(draw.draw);
    const date = escapeHtml(draw.date);
    const balls = `<div class="mini-balls">${renderBalls(draw.numbers)}</div>`;
    if (type === "recent") {
      return `<div class="recent-row"><span class="recent-draw-id">NO. ${numberLabel}</span>${balls}<time class="recent-date" datetime="${date}">${escapeHtml(formatDrawDate(draw.date, true))}</time></div>`;
    }
    return `<article class="archive-row"><span class="archive-row-id">NO. ${numberLabel}</span><time class="archive-row-date" datetime="${date}">${escapeHtml(formatDrawDate(draw.date, true).toUpperCase())}</time>${balls}</article>`;
  }).join("");
}

function renderInitialResults(html, archive) {
  const currentDraws = archive.draws.filter((draw) => draw.draw >= FORMAT_BOUNDARY);
  const latest = archive.draws.at(-1);
  const maxNumber = latest.draw >= FORMAT_BOUNDARY ? 49 : 45;
  const counts = new Array(maxNumber + 1).fill(0);
  currentDraws.forEach((draw) => draw.numbers.forEach((number) => { counts[number] += 1; }));
  const highest = Math.max(...counts.slice(1));
  const lowest = Math.min(...counts.slice(1));
  const leaders = Array.from({ length: maxNumber }, (_, index) => index + 1)
    .sort((left, right) => counts[right] - counts[left] || left - right)
    .slice(0, 8);
  const frequencyBoard = counts.slice(1).map((count, index) => {
    const number = index + 1;
    const intensity = highest === lowest ? 0 : (count - lowest) / (highest - lowest);
    const tone = intensity > .72 ? " is-high" : intensity < .18 ? " is-low" : "";
    return `<div class="frequency-cell${tone}" title="Number ${number}: drawn ${count} times in this era"><strong>${String(number).padStart(2, "0")}</strong><span>${count}&times;</span></div>`;
  }).join("");
  const frequencyLeaders = leaders.map((number) => {
    const width = highest ? Math.max(5, counts[number] / highest * 100) : 0;
    return `<div class="leader-row"><span class="leader-number">${String(number).padStart(2, "0")}</span><span class="leader-track"><span class="leader-fill" style="width:${width}%"></span></span><span class="leader-count">${counts[number]}</span></div>`;
  }).join("");
  const topFrequencySummary = leaders.map((number) => `${String(number).padStart(2, "0")} (${counts[number]})`).join(", ");
  const archiveRows = currentDraws.slice(-14).reverse();
  const average = currentDraws.length * 5 / maxNumber;
  const latestEra = latest.draw < FORMAT_BOUNDARY ? "5 / 45" : "5 / 49";
  const coverage = `${formatDrawDate(archive.coverage.firstDate, true).toUpperCase()}—${formatDrawDate(archive.coverage.lastDate, true).toUpperCase()}`;
  const replacements = {
    "<!--SSR_LATEST_DRAW-->": escapeHtml(latest.draw),
    "<!--SSR_LATEST_DATE-->": escapeHtml(formatDrawDate(latest.date)),
    "<!--SSR_LATEST_BALLS-->": renderBalls(latest.numbers),
    "<!--SSR_LATEST_ERA-->": `${latestEra} FORMAT`,
    "<!--SSR_RECENT_DRAWS-->": renderDrawRows(currentDraws.slice(-5).reverse(), "recent"),
    "<!--SSR_FREQUENCY_SUMMARY-->": `Current format frequency leaders (draw count): ${escapeHtml(topFrequencySummary)}. Historical counts do not affect future odds.`,
    "<!--SSR_COVERAGE-->": `OFFICIAL RESULTS · ${coverage}`,
    "<!--SSR_STATS_RANGE-->": `01—${String(maxNumber).padStart(2, "0")}`,
    "<!--SSR_STATS_DRAWS-->": currentDraws.length,
    "<!--SSR_STATS_AVERAGE-->": average.toFixed(1),
    "<!--SSR_STATS_EXPECTED-->": average.toFixed(1),
    "<!--SSR_FREQUENCY_BOARD-->": frequencyBoard,
    "<!--SSR_FREQUENCY_LEADERS-->": frequencyLeaders,
    "<!--SSR_ARCHIVE_SUMMARY-->": `${archive.coverage.drawCount} results saved locally.`,
    "<!--SSR_ARCHIVE_COUNT-->": `SHOWING ${archiveRows.length} OF ${currentDraws.length} DRAWS`,
    "<!--SSR_ARCHIVE_ROWS-->": renderDrawRows(archiveRows, "archive"),
    "<!--SSR_SNAPSHOT_DATE-->": `ARCHIVE UPDATED ${formatDrawDate(archive.retrievedAt, true).toUpperCase()}.`
  };
  return Object.entries(replacements).reduce((result, [marker, value]) => result.replace(marker, String(value)), html);
}

export function createAppServer({ root = projectRoot, resultsService: providedResultsService } = {}) {
  const resultsService = providedResultsService || createResultsService({
    archivePath: path.join(root, "data", "super5-draws.json"),
    checkStatePath: path.join(root, "data", "results-check.json"),
    logPath: path.join(root, "data", "results-update.log")
  });
  return createServer(async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }

    let pathname;
    try {
      pathname = new URL(request.url || "/", "http://localhost").pathname;
    } catch {
      response.writeHead(400);
      response.end("Bad request");
      return;
    }

    if (pathname === "/api/results") {
      if (request.method === "HEAD") {
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        response.end();
        return;
      }
      try {
        const snapshot = await resultsService.getSnapshot();
        response.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff"
        });
        response.end(JSON.stringify(snapshot));
      } catch (error) {
        response.writeHead(503, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff"
        });
        response.end(JSON.stringify({ error: error.message || "Results are temporarily unavailable." }));
      }
      return;
    }

    let requestedPath;
    try {
      requestedPath = decodeURIComponent(pathname);
    } catch {
      response.writeHead(400);
      response.end("Bad request");
      return;
    }

    const relativePath = requestedPath === "/" ? "index.html" : requestedPath.slice(1);
    const filePath = path.resolve(root, relativePath);
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    try {
      let body = await readFile(filePath);
      if (requestedPath === "/" || requestedPath === "/index.html") {
        try {
          const archive = validateArchive(JSON.parse(await readFile(path.join(root, "data", "super5-draws.json"), "utf8")));
          body = Buffer.from(renderInitialResults(body.toString("utf8"), archive), "utf8");
        } catch {
          // Keep the static shell usable if the archive is temporarily unavailable.
        }
      }
      response.writeHead(200, {
        "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch (error) {
      response.writeHead(error && error.code === "ENOENT" ? 404 : 500);
      response.end(error && error.code === "ENOENT" ? "Not found" : "Could not read file");
    }
  });
}

const isDirectRun = typeof process !== "undefined" && process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const port = Number(process.env.PORT || 4173);
  createAppServer().listen(port, "0.0.0.0", () => {
    process.stdout.write("Super5 Studio is ready at http://localhost:" + port + "\n");
  });
}
