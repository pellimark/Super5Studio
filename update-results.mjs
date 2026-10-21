import { appendFile, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { nextScheduledDraw } from "./next-draw.js";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const archivePath = path.join(projectRoot, "data", "super5-draws.json");
const logPath = path.join(projectRoot, "data", "results-update.log");
const sourceUrl = "https://lottery.mt/super5/results/history/";
const fallbackSourceUrl = "https://stats247.com/lotto/malta-super-5";
const timeoutMs = 20_000;
const formatBoundary = 259;
const monthNumbers = new Map([
  ["jan", 1], ["january", 1], ["feb", 2], ["february", 2],
  ["mar", 3], ["march", 3], ["apr", 4], ["april", 4],
  ["may", 5], ["jun", 6], ["june", 6], ["jul", 7], ["july", 7],
  ["aug", 8], ["august", 8], ["sep", 9], ["september", 9],
  ["oct", 10], ["october", 10], ["nov", 11], ["november", 11],
  ["dec", 12], ["december", 12]
]);

function fail(message) {
  throw new Error(message);
}

export function validateDraw(draw, label = "Draw") {
  if (!draw || !Number.isSafeInteger(draw.draw) || draw.draw < 1) {
    fail(`${label}: draw number must be a positive integer.`);
  }
  if (typeof draw.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(draw.date)) {
    fail(`${label}: date must use YYYY-MM-DD.`);
  }
  const parsedDate = new Date(`${draw.date}T00:00:00.000Z`);
  if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== draw.date) {
    fail(`${label}: ${draw.date} is not a real calendar date.`);
  }
  if (!Array.isArray(draw.numbers) || draw.numbers.length !== 5) {
    fail(`${label}: exactly five numbers are required.`);
  }
  if (draw.numbers.some((number) => !Number.isSafeInteger(number))) {
    fail(`${label}: all five numbers must be integers.`);
  }
  if (new Set(draw.numbers).size !== 5) {
    fail(`${label}: the five numbers must be unique.`);
  }
  const maximum = draw.draw < formatBoundary ? 45 : 49;
  if (draw.numbers.some((number) => number < 1 || number > maximum)) {
    fail(`${label}: draw ${draw.draw} must use numbers from 1 to ${maximum}.`);
  }
  return parsedDate;
}

export function validateArchive(archive) {
  if (!archive || !Array.isArray(archive.draws) || archive.draws.length === 0) {
    fail("The local archive is missing its draws array.");
  }
  if (!archive.coverage || !Array.isArray(archive.formats)) {
    fail("The local archive is missing its coverage or format metadata.");
  }

  let previous = null;
  const drawNumbers = new Set();
  const drawDates = new Set();
  for (const draw of archive.draws) {
    const date = validateDraw(draw, "Local archive");
    if (drawNumbers.has(draw.draw) || drawDates.has(draw.date)) {
      fail(`The local archive contains a duplicate draw number or date at draw ${draw.draw}.`);
    }
    if (previous && (draw.draw <= previous.draw || date <= previous.date)) {
      fail("The local archive must be ordered by increasing draw number and date.");
    }
    drawNumbers.add(draw.draw);
    drawDates.add(draw.date);
    previous = { draw: draw.draw, date };
  }

  const first = archive.draws[0];
  const last = archive.draws.at(-1);
  if (archive.coverage.firstDraw !== first.draw || archive.coverage.firstDate !== first.date ||
      archive.coverage.lastDraw !== last.draw || archive.coverage.lastDate !== last.date ||
      archive.coverage.drawCount !== archive.draws.length) {
    fail("The local archive coverage metadata does not match its draws.");
  }
  if (!archive.formats.some((format) => format.name === "5/45") ||
      !archive.formats.some((format) => format.name === "5/49")) {
    fail("The local archive must retain its 5/45 and 5/49 format metadata.");
  }
  return archive;
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;|&#160;|&#x0*a0;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;|&#x0*27;/gi, "'")
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value)))
    .replace(/&#x([\da-f]+);/gi, (_, value) => String.fromCodePoint(parseInt(value, 16)));
}

function visibleTextFromHtml(html) {
  return decodeEntities(html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export function parseOfficialHistory(html) {
  const text = visibleTextFromHtml(html);
  const cardPattern = /\b(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s*,?\s*)?(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{4})\s+Draw\s*:\s*(\d+)\b/gi;
  const cards = [...text.matchAll(cardPattern)];
  if (cards.length === 0) {
    fail("The official history page did not contain any recognizable draw cards. No archive changes were made.");
  }

  const parsed = [];
  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index];
    const day = Number(card[1]);
    const month = monthNumbers.get(card[2].toLowerCase());
    const year = Number(card[3]);
    const draw = Number(card[4]);
    const dateValue = new Date(Date.UTC(year, month - 1, day));
    if (dateValue.getUTCFullYear() !== year || dateValue.getUTCMonth() !== month - 1 || dateValue.getUTCDate() !== day) {
      fail(`The official history page has an invalid date for draw ${draw}. No archive changes were made.`);
    }
    const date = `${year.toString().padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const segmentEnd = cards[index + 1]?.index ?? text.length;
    const segment = text.slice(card.index + card[0].length, segmentEnd);
    const prizeButtonIndex = segment.search(/View Prize Breakdown/i);
    const ballText = prizeButtonIndex >= 0 ? segment.slice(0, prizeButtonIndex) : segment;
    const numbers = [...ballText.matchAll(/\b\d{1,2}\b/g)].map((match) => Number(match[0]));
    const result = { draw, date, numbers };
    validateDraw(result, "Official history page");
    parsed.push(result);
  }

  const seen = new Map();
  for (const draw of parsed) {
    const previous = seen.get(draw.draw);
    if (previous && (previous.date !== draw.date || previous.numbers.join(",") !== draw.numbers.join(","))) {
      fail(`The official history page gives conflicting details for draw ${draw.draw}. No archive changes were made.`);
    }
    seen.set(draw.draw, draw);
  }
  return [...seen.values()];
}

export async function fetchOfficialResults() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(sourceUrl, {
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-GB,en;q=0.9",
        referer: "https://lottery.mt/super5/",
        "user-agent": "Super5Studio/0.1 (+https://github.com/pellimark/Super5Studio)"
      }
    });
    if (!response.ok) {
      fail(`The official results page returned HTTP ${response.status}.`);
    }
    if (new URL(response.url).hostname !== "lottery.mt") {
      fail("The official results page redirected away from lottery.mt.");
    }
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("text/html")) {
      fail(`The official results page returned an unexpected content type: ${contentType || "unknown"}.`);
    }
    return parseOfficialHistory(await response.text());
  } catch (error) {
    if (error?.name === "AbortError") {
      fail(`The official results page did not respond within ${timeoutMs / 1000} seconds.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function parseStats247History(html) {
  const pageText = visibleTextFromHtml(html);
  const headingIndex = pageText.search(/\bSuper 5 Lottery Results\b/i);
  if (headingIndex < 0) {
    fail("Stats247 did not show its Super 5 results table. No archive changes were made.");
  }
  const resultsStart = html.search(/Super 5 Lottery Results/i);
  const laterHeadings = [...html.slice(resultsStart).matchAll(/Hot\s*&(?:amp;)?\s*Cold Numbers/gi)];
  const resultsEnd = laterHeadings.length ? resultsStart + laterHeadings[0].index : -1;
  if (resultsEnd < 0) {
    fail("Stats247's results section could not be bounded safely. No archive changes were made.");
  }

  const sectionHtml = html.slice(resultsStart, resultsEnd);
  const rows = [...sectionHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)];
  const parsed = [];
  for (const row of rows) {
    const text = visibleTextFromHtml(row[1]);
    const dateMatch = text.match(/\b(\d{2})-(\d{2})-(\d{4})\b/);
    if (!dateMatch) continue;

    const day = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const year = Number(dateMatch[3]);
    const dateValue = new Date(Date.UTC(year, month - 1, day));
    if (dateValue.getUTCFullYear() !== year || dateValue.getUTCMonth() !== month - 1 || dateValue.getUTCDate() !== day) {
      fail(`Stats247 has an invalid draw date (${dateMatch[0]}). No archive changes were made.`);
    }
    const date = `${year.toString().padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const numbers = [...text.slice(dateMatch.index + dateMatch[0].length).matchAll(/\b\d{1,2}\b/g)]
      .map((match) => Number(match[0]));
    if (numbers.length !== 5) {
      fail(`Stats247's row for ${date} did not contain exactly five result numbers. No archive changes were made.`);
    }
    parsed.push({ date, numbers });
  }

  if (parsed.length === 0) {
    fail("Stats247 did not contain any recognizable result rows. No archive changes were made.");
  }

  const seen = new Map();
  for (const result of parsed) {
    const previous = seen.get(result.date);
    if (previous && previous.numbers.join(",") !== result.numbers.join(",")) {
      fail(`Stats247 gives conflicting numbers for ${result.date}. No archive changes were made.`);
    }
    seen.set(result.date, result);
  }
  return [...seen.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export async function fetchStats247Results(archive) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(fallbackSourceUrl, {
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-GB,en;q=0.9",
        "user-agent": "Super5Studio/0.1 (+https://github.com/pellimark/Super5Studio)"
      }
    });
    if (!response.ok) {
      fail(`Stats247 returned HTTP ${response.status}.`);
    }
    if (new URL(response.url).hostname !== "stats247.com") {
      fail("Stats247 redirected away from stats247.com.");
    }
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("text/html")) {
      fail(`Stats247 returned an unexpected content type: ${contentType || "unknown"}.`);
    }

    const rows = parseStats247History(await response.text());
    const latest = archive.draws.at(-1);
    const latestIndex = rows.findIndex((draw) => draw.date === latest.date);
    if (latestIndex < 0) {
      fail(`Stats247 does not show the saved latest draw date ${latest.date}; it may be stale or incomplete. No archive changes were made.`);
    }
    if (rows[latestIndex].numbers.join(",") !== latest.numbers.join(",")) {
      fail(`Stats247's result for ${latest.date} differs from the saved archive. No archive changes were made.`);
    }

    const sourceDraws = [{ ...latest }];
    let previous = latest;
    for (const row of rows.slice(latestIndex + 1)) {
      const expected = nextScheduledDraw(previous, new Date(`${previous.date}T12:00:00.000Z`));
      if (row.date !== expected.date) {
        fail(`Stats247 skips or has an unexpected draw date after ${previous.date}; expected ${expected.date}. No archive changes were made.`);
      }
      const draw = { draw: previous.draw + 1, date: row.date, numbers: row.numbers };
      validateDraw(draw, "Stats247 fallback");
      sourceDraws.push(draw);
      previous = draw;
    }
    return sourceDraws;
  } catch (error) {
    if (error?.name === "AbortError") {
      fail(`Stats247 did not respond within ${timeoutMs / 1000} seconds.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchResultsWithFallback(archive) {
  try {
    return {
      draws: await fetchOfficialResults(),
      sourceName: "official",
      sourceUrl
    };
  } catch (officialError) {
    try {
      return {
        draws: await fetchStats247Results(archive),
        sourceName: "stats247",
        sourceUrl: fallbackSourceUrl,
        fallbackReason: officialError.message || "the official source could not be read"
      };
    } catch (fallbackError) {
      fail(`Official source failed (${officialError.message || "unknown error"}); Stats247 fallback also failed (${fallbackError.message || "unknown error"}).`);
    }
  }
}

function maltaDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Malta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function mergeResults(archive, sourceDraws, retrievedAt = new Date(), sourceLabel = "Official history page") {
  const localByNumber = new Map(archive.draws.map((draw) => [draw.draw, draw]));
  for (const sourceDraw of sourceDraws) {
    const localDraw = localByNumber.get(sourceDraw.draw);
    if (localDraw && (localDraw.date !== sourceDraw.date || localDraw.numbers.join(",") !== sourceDraw.numbers.join(","))) {
      fail(`${sourceLabel} draw ${sourceDraw.draw} differs from the saved archive. No archive changes were made.`);
    }
  }

  const latest = archive.draws.at(-1);
  if (!sourceDraws.some((draw) => draw.draw === latest.draw)) {
    fail(`${sourceLabel} does not show the saved latest draw ${latest.draw}; it may be stale or incomplete. No archive changes were made.`);
  }

  const additions = sourceDraws.filter((draw) => draw.draw > latest.draw).sort((a, b) => a.draw - b.draw);
  if (additions.length === 0) return null;
  let expectedDraw = latest.draw + 1;
  let previousDate = new Date(`${latest.date}T00:00:00.000Z`);
  for (const draw of additions) {
    if (draw.draw !== expectedDraw) {
      fail(`${sourceLabel} skips draw ${expectedDraw}; the archive was left untouched.`);
    }
    const date = validateDraw(draw, sourceLabel);
    if (date <= previousDate) {
      fail(`${sourceLabel} draw ${draw.draw} does not advance the saved draw date; the archive was left untouched.`);
    }
    expectedDraw += 1;
    previousDate = date;
  }

  const draws = [...archive.draws, ...additions];
  const last = draws.at(-1);
  const formats = archive.formats.map((format) => {
    if (format.name === "5/45") {
      const lastClassicDraw = draws.filter((draw) => draw.draw < formatBoundary).at(-1);
      return lastClassicDraw
        ? { ...format, throughDraw: lastClassicDraw.draw, throughDate: lastClassicDraw.date }
        : format;
    }
    if (format.name === "5/49") {
      const lastCurrentDraw = draws.filter((draw) => draw.draw >= formatBoundary).at(-1);
      return lastCurrentDraw
        ? { ...format, throughDraw: lastCurrentDraw.draw, throughDate: lastCurrentDraw.date }
        : format;
    }
    return format;
  });

  return {
    ...archive,
    retrievedAt: maltaDate(retrievedAt),
    coverage: {
      ...archive.coverage,
      lastDraw: last.draw,
      lastDate: last.date,
      drawCount: draws.length
    },
    formats,
    draws
  };
}

export async function atomicWriteArchive(archive, targetPath = archivePath) {
  const temporaryPath = path.join(path.dirname(targetPath), `.super5-draws-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, "wx");
    await handle.writeFile(`${JSON.stringify(archive, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, targetPath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

export function formatRefreshMessage(result) {
  const outcome = result.added
    ? `Added ${result.added} draw${result.added === 1 ? "" : "s"}; archive now ends at draw ${result.archive.coverage.lastDraw} (${result.archive.coverage.lastDate}).`
    : `Archive is already current at draw ${result.archive.coverage.lastDraw}; no file changes were made.`;
  if (result.sourceName !== "stats247") return outcome;
  const reason = result.fallbackReason ? ` Official source failed: ${result.fallbackReason}` : "";
  return `Used Stats247 as a third-party fallback.${reason} ${outcome}`;
}

export async function refreshArchive({ targetPath = archivePath, fetchResults = fetchResultsWithFallback, now = () => new Date() } = {}) {
  const archive = validateArchive(JSON.parse(await readFile(targetPath, "utf8")));
  const fetched = await fetchResults(archive);
  const sourceDraws = Array.isArray(fetched) ? fetched : fetched.draws;
  if (!Array.isArray(sourceDraws)) {
    fail("The results source did not return a draw list. No archive changes were made.");
  }
  const sourceName = Array.isArray(fetched) ? "official" : fetched.sourceName;
  const usedSourceUrl = Array.isArray(fetched) ? sourceUrl : fetched.sourceUrl;
  const sourceLabel = sourceName === "stats247" ? "Stats247 fallback" : "Official history page";
  const checkedAt = now();
  const updatedArchive = mergeResults(archive, sourceDraws, checkedAt, sourceLabel);
  if (!updatedArchive) {
    return {
      archive,
      added: 0,
      checkedAt: checkedAt.toISOString(),
      sourceName,
      sourceUrl: usedSourceUrl,
      fallbackReason: Array.isArray(fetched) ? undefined : fetched.fallbackReason
    };
  }
  updatedArchive.lastUpdateSource = {
    name: sourceName === "stats247" ? "Stats247 (third-party fallback)" : "Official Malta National Lottery",
    url: usedSourceUrl,
    checkedAt: checkedAt.toISOString()
  };
  validateArchive(updatedArchive);
  await atomicWriteArchive(updatedArchive, targetPath);
  return {
    archive: updatedArchive,
    added: updatedArchive.coverage.lastDraw - archive.coverage.lastDraw,
    checkedAt: checkedAt.toISOString(),
    sourceName,
    sourceUrl: usedSourceUrl,
    fallbackReason: Array.isArray(fetched) ? undefined : fetched.fallbackReason
  };
}

async function report(message, isError = false) {
  const line = `${new Date().toISOString()} ${isError ? "ERROR" : "INFO"} ${message}`;
  (isError ? console.error : console.log)(line);
  await appendFile(logPath, `${line}\n`, "utf8").catch((error) => {
    console.error(`Could not append ${path.relative(projectRoot, logPath)}: ${error.message}`);
  });
}

async function main() {
  const checkStatePath = path.join(projectRoot, "data", "results-check.json");
  let result;
  try {
    result = await refreshArchive();
  } catch (error) {
    const { writeCheckState } = await import("./results-check-state.mjs");
    await writeCheckState(checkStatePath, { checkedAt: new Date().toISOString(), status: "error", message: error.message }).catch(() => {});
    await report(`${error.message} The archive was left untouched.`, true);
    process.exitCode = 1;
    return;
  }
  const message = formatRefreshMessage(result);
  const { writeCheckState } = await import("./results-check-state.mjs");
  await writeCheckState(checkStatePath, { checkedAt: result.checkedAt, status: "success", message })
    .catch((error) => report(`Archive refresh completed, but its check time could not be saved: ${error.message}`, true));
  await report(message);
}

const isDirectRun = typeof process !== "undefined" && process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) await main();
