"use strict";

import { buildPositionModel, DIVERSITY_SETTINGS, predictOutcomes } from "./position-predictor.js";
import { nextScheduledDraw } from "./next-draw.js";

const RESULTS_PATH = "/api/results";
const ERA_RULES = {
  current: { max: 49, firstDraw: 259, format: "5 / 49", label: "CURRENT FORMAT" },
  classic: { max: 45, firstDraw: 1, lastDraw: 258, format: "5 / 45", label: "ARCHIVE FORMAT" }
};
const MODE_LABELS = {
  uniform: "YOUR QUICK PICK",
  recent: "RECENT FAVOURITES",
  long: "LONG VIEW",
  overdue: "OVERDUE LIST",
  predict: "POSITION PREDICTOR"
};
const MODE_CAPTIONS = {
  uniform: "A random line. Every valid line is equally likely.",
  recent: "Most common in the last 30 draws.",
  long: "Most common in this format.",
  overdue: "Longest gap in this format.",
  predict: "Candidate line. Every valid line has the same odds."
};

let archive = null;
let activeView = "pick";
let selectedEra = "current";
let selectedMode = "uniform";
let generatedNumbers = null;
let generatedCount = 0;
let firstQuickPick = null;
let orbitRevealVersion = 0;
let orbitRevealTimer = null;
let predictedLines = [];
let positionModel = null;
let archiveLimit = 14;
let resultsRequestInFlight = false;
let resultsPollTimer = null;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function currentRules() {
  return ERA_RULES[selectedEra];
}

function eraDraws() {
  const { firstDraw, lastDraw = Infinity } = currentRules();
  return archive.draws.filter((draw) => draw.draw >= firstDraw && draw.draw <= lastDraw);
}

function prettyDate(isoDate, options = {}) {
  const format = new Intl.DateTimeFormat("en-GB", {
    weekday: options.short ? undefined : "long",
    day: "2-digit",
    month: options.short ? "short" : "long",
    year: "numeric",
    timeZone: "UTC"
  });
  return format.format(new Date(isoDate + "T12:00:00Z"));
}

function prettyMaltaTimestamp(isoTimestamp) {
  const date = new Date(isoTimestamp);
  if (!Number.isFinite(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    timeZone: "Europe/Malta", timeZoneName: "short"
  }).format(date);
}

function randomIndex(max) {
  if (window.crypto && window.crypto.getRandomValues) {
    const span = 0x100000000;
    const limit = span - (span % max);
    const value = new Uint32Array(1);
    do {
      window.crypto.getRandomValues(value);
    } while (value[0] >= limit);
    return value[0] % max;
  }
  return Math.floor(Math.random() * max);
}

function shuffled(values) {
  const copy = values.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomIndex(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function frequencyCounts(draws, max) {
  const counts = new Array(max + 1).fill(0);
  draws.forEach((draw) => draw.numbers.forEach((number) => { counts[number] += 1; }));
  return counts;
}

function pickLine(mode) {
  const draws = eraDraws();
  const max = currentRules().max;
  if (mode === "uniform") return shuffled(Array.from({ length: max }, (_, i) => i + 1)).slice(0, 5).sort((a, b) => a - b);

  const source = mode === "recent" ? draws.slice(-30) : draws;
  const counts = frequencyCounts(source, max);
  const lastSeen = new Array(max + 1).fill(-1);
  draws.forEach((draw, index) => draw.numbers.forEach((number) => { lastSeen[number] = index; }));
  const tieOrder = shuffled(Array.from({ length: max }, (_, i) => i + 1));
  const tieRank = new Map(tieOrder.map((number, index) => [number, index]));

  const ranked = tieOrder.slice().sort((a, b) => {
    if (mode === "overdue") return (draws.length - lastSeen[b]) - (draws.length - lastSeen[a]) || tieRank.get(a) - tieRank.get(b);
    return counts[b] - counts[a] || tieRank.get(a) - tieRank.get(b);
  });
  return ranked.slice(0, 5).sort((a, b) => a - b);
}

function setBallRow(container, numbers, small = false, animate = false) {
  container.replaceChildren();
  numbers.forEach((number, index) => {
    const ball = document.createElement("span");
    ball.className = small ? "mini-ball" : "number-ball";
    if (number === null) ball.classList.add("is-empty");
    if (animate) {
      ball.classList.add("is-new");
      ball.style.setProperty("--i", String(index));
    }
    ball.textContent = number === null ? "–" : String(number);
    container.append(ball);
  });
}

function rememberFirstQuickPick(numbers) {
  if (!firstQuickPick) firstQuickPick = numbers.slice();
}

function renderFirstQuickPick() {
  if (!firstQuickPick) return;
  setBallRow($("#first-quick-pick-balls"), firstQuickPick, true);
  $("#first-quick-pick-card").hidden = false;
}

function cancelOrbitReveal() {
  if (orbitRevealTimer !== null) window.clearTimeout(orbitRevealTimer);
  orbitRevealTimer = null;
  orbitRevealVersion += 1;
}

function resetOrbitNumbers() {
  cancelOrbitReveal();
  $$(".orbit-ball").forEach((ball) => {
    ball.textContent = "";
    ball.classList.remove("is-revealed");
    ball.classList.add("is-waiting");
  });
  $("#heading-art").setAttribute("aria-label", "Your current line is waiting to be drawn");
  renderFirstQuickPick();
}

function revealOrbitNumbers(numbers, mode, onComplete) {
  cancelOrbitReveal();
  const revealVersion = orbitRevealVersion;
  const balls = $$(".orbit-ball");
  balls.forEach((ball) => {
    ball.textContent = "";
    ball.classList.remove("is-revealed");
    ball.classList.add("is-waiting");
  });

  const finish = () => {
    if (revealVersion !== orbitRevealVersion) return;
    orbitRevealTimer = null;
    const pickName = mode === "uniform" ? "quick pick" : "line";
    $("#heading-art").setAttribute("aria-label", "Your " + pickName + " is " + numbers.join(", "));
    onComplete();
  };
  const reveal = (index) => {
    if (revealVersion !== orbitRevealVersion) return;
    const ball = balls[index];
    ball.textContent = String(numbers[index]);
    ball.classList.remove("is-waiting");
    ball.classList.add("is-revealed");
    if (index === balls.length - 1) {
      finish();
      return;
    }
    orbitRevealTimer = window.setTimeout(() => reveal(index + 1), 150);
  };

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    numbers.forEach((number, index) => {
      balls[index].textContent = String(number);
      balls[index].classList.remove("is-waiting");
      balls[index].classList.add("is-revealed");
    });
    finish();
    return;
  }
  orbitRevealTimer = window.setTimeout(() => reveal(0), 100);
}

function updateLine() {
  const predicting = selectedMode === "predict";
  const line = $("#generated-line");
  const numbers = generatedNumbers || [null, null, null, null, null];
  setBallRow(line, numbers, false, Boolean(generatedNumbers));
  $("#line-title").textContent = MODE_LABELS[selectedMode];
  $("#line-caption").textContent = generatedNumbers ? MODE_CAPTIONS[selectedMode] : "Press spin to generate using this style.";
  $("#line-seq").textContent = predicting && predictedLines.length
    ? "OUTCOME 01 / " + String(predictedLines.length).padStart(2, "0")
    : generatedNumbers ? "LINE " + String(generatedCount).padStart(2, "0") : "LINE 01";
  $("#heading-line-title").textContent = selectedMode === "uniform" ? "YOUR QUICK PICK" : "YOUR LINE";
  $("#heading-line-seq").textContent = !generatedNumbers
    ? "BALLS IN MOTION"
    : predicting ? "OUTCOME 01" : "LINE " + String(generatedCount).padStart(2, "0");
  $("#copy-line").disabled = !generatedNumbers;
  $("#copy-line").textContent = "↗ COPY";
  $("#copy-all-outcomes").textContent = "↗ COPY ALL";
  $("#copy-all-outcomes").hidden = !predicting || predictedLines.length < 2;
  $("#prediction-controls").hidden = !predicting;
  $("#position-labels").hidden = !predicting;
  $("#prediction-results").hidden = !predicting || !generatedNumbers;
  $("#generate-label").textContent = predicting ? "Build outcomes" : "Spin a line";
  renderPredictions();
}

function generateSelection() {
  const mode = selectedMode;
  let numbers;
  if (mode === "predict") {
    positionModel = buildPositionModel(eraDraws(), currentRules().max);
    const diversity = $("#outcome-diversity").value;
    const setting = DIVERSITY_SETTINGS[diversity];
    $("#diversity-rule").textContent = setting.label + ": any two lines share at most " + setting.maxShared + " numbers.";
    predictedLines = predictOutcomes(positionModel, currentRules().max, Number($("#outcome-count").value), diversity);
    numbers = predictedLines[0];
  } else {
    predictedLines = [];
    positionModel = null;
    numbers = pickLine(mode);
  }
  if (mode === "uniform") rememberFirstQuickPick(numbers);
  generatedNumbers = null;
  updateLine();
  $("#line-caption").textContent = "Drawing your five numbers…";
  $("#line-seq").textContent = "DRAWING";
  revealOrbitNumbers(numbers, mode, () => {
    generatedNumbers = numbers;
    generatedCount += 1;
    renderFirstQuickPick();
    updateLine();
  });
}

async function copyNumbers(button, lines) {
  const content = lines.map((numbers) => numbers.join(" · ")).join("\n");
  const label = button.id === "copy-all-outcomes" ? "↗ COPY ALL" : "↗ COPY";
  try {
    await navigator.clipboard.writeText(content);
    button.textContent = "COPIED ✓";
    window.setTimeout(() => {
      if (button.textContent === "COPIED ✓") button.textContent = label;
    }, 1300);
  } catch {
    $("#copy-fallback").hidden = false;
    $("#copy-fallback-text").value = content;
    $("#copy-fallback-text").focus();
    $("#copy-fallback-text").select();
  }
}

function renderPredictions() {
  const host = $("#prediction-outcomes");
  host.replaceChildren();
  $("#copy-fallback").hidden = true;
  if (selectedMode !== "predict" || !positionModel || !generatedNumbers) return;

  $("#prediction-summary").textContent = predictedLines.length + (predictedLines.length === 1 ? " candidate" : " candidates") +
    " · " + DIVERSITY_SETTINGS[$("#outcome-diversity").value].label +
    " · " + eraDraws().length + " draws in the " + currentRules().format + " era";
  $("#prediction-limit-note").hidden = predictedLines.length >= Number($("#outcome-count").value);
  $("#prediction-alternatives").hidden = predictedLines.length < 2;
  predictedLines.slice(1).forEach((numbers, index) => {
    const row = document.createElement("li");
    row.className = "prediction-row";
    const label = document.createElement("span");
    label.className = "prediction-index";
    label.textContent = String(index + 2).padStart(2, "0");
    const balls = document.createElement("div");
    balls.className = "mini-balls";
    setBallRow(balls, numbers, true);
    const copy = document.createElement("button");
    copy.className = "copy-button";
    copy.type = "button";
    copy.textContent = "↗ COPY";
    copy.setAttribute("aria-label", "Copy outcome " + (index + 2));
    copy.addEventListener("click", () => { void copyNumbers(copy, [numbers]); });
    row.append(label, balls, copy);
    host.append(row);
  });
}

function renderLatest() {
  const draws = eraDraws();
  const latest = archive.draws.at(-1);
  $("#latest-draw-number").textContent = latest.draw;
  $("#latest-draw-date").textContent = prettyDate(latest.date);
  setBallRow($("#latest-draw-balls"), latest.numbers, true);
  $("#latest-era-label").textContent = (latest.draw < 259 ? "5 / 45" : "5 / 49") + " FORMAT";
  $("#era-draw-count").textContent = String(draws.length);
  $("#picker-edition").textContent = "5 FROM " + currentRules().max;
  $("#rule-description").textContent = "Five numbers from 1 to " + currentRules().max;
}

function renderResultsStatus(snapshot) {
  const latest = archive.draws.at(-1);
  const scheduled = nextScheduledDraw(latest);
  $("#scheduled-draw-number").textContent = String(scheduled.draw);
  $("#scheduled-draw-date").textContent = prettyDate(scheduled.date);
  $("#scheduled-draw-date").dateTime = scheduled.date;

  const lastCheck = snapshot.lastCheck;
  $("#source-check-time").textContent = lastCheck?.checkedAt
    ? prettyMaltaTimestamp(lastCheck.checkedAt)
    : "Not checked yet";
  const status = $("#refresh-state");
  status.classList.toggle("is-error", lastCheck?.status === "error" && !snapshot.refreshing);
  status.textContent = snapshot.refreshing
    ? "Checking results sources…"
    : lastCheck?.status === "error"
      ? "Last check could not verify results: " + lastCheck.message
      : lastCheck?.message || "The saved archive is ready.";
}

function renderRecent() {
  const host = $("#recent-draws");
  host.replaceChildren();
  eraDraws().slice(-5).reverse().forEach((draw) => {
    const row = document.createElement("div");
    row.className = "recent-row";
    const id = document.createElement("span");
    id.className = "recent-draw-id";
    id.textContent = "NO. " + draw.draw;
    const balls = document.createElement("div");
    balls.className = "mini-balls";
    setBallRow(balls, draw.numbers, true);
    const date = document.createElement("time");
    date.className = "recent-date";
    date.dateTime = draw.date;
    date.textContent = prettyDate(draw.date, { short: true });
    row.append(id, balls, date);
    host.append(row);
  });
}

function backtestSummary() {
  if (selectedEra === "current") {
    return {
      observed: "65",
      observedLabel: "matches from 105<br>long-view picks",
      baseline: "≈ 53.6",
      copy: "That difference is still well within ordinary draw-to-draw noise. The archive offers no reliable edge."
    };
  }
  return {
    observed: "126",
    observedLabel: "matches from 228<br>long-view picks",
    baseline: "≈ 126",
    copy: "The long-view picker matched the random expectation in this walk-forward check. Past frequencies offer no reliable edge."
  };
}

function renderBacktest() {
  const summary = backtestSummary();
  $("#backtest-observed").textContent = summary.observed;
  $("#backtest-baseline").textContent = summary.baseline;
  $("#backtest-copy").textContent = summary.copy;
  $(".reality-metric span").innerHTML = summary.observedLabel;
}

function renderNumbers() {
  const draws = eraDraws();
  const max = currentRules().max;
  const counts = frequencyCounts(draws, max);
  const average = draws.length * 5 / max;
  const high = Math.max(...counts.slice(1));
  const low = Math.min(...counts.slice(1));
  $("#stats-range").textContent = "01—" + String(max).padStart(2, "0");
  $("#stats-draws").textContent = String(draws.length);
  $("#stats-average").textContent = average.toFixed(1);
  $("#stats-expected").textContent = average.toFixed(1);

  const board = $("#frequency-board");
  board.replaceChildren();
  for (let number = 1; number <= max; number += 1) {
    const cell = document.createElement("div");
    cell.className = "frequency-cell";
    const intensity = high === low ? 0 : (counts[number] - low) / (high - low);
    if (intensity > .72) cell.classList.add("is-high");
    else if (intensity < .18) cell.classList.add("is-low");
    const label = document.createElement("strong");
    label.textContent = String(number).padStart(2, "0");
    const count = document.createElement("span");
    count.textContent = counts[number] + "×";
    cell.title = "Number " + number + ": drawn " + counts[number] + " times in this era";
    cell.append(label, count);
    board.append(cell);
  }

  const leaders = Array.from({ length: max }, (_, index) => index + 1)
    .sort((a, b) => counts[b] - counts[a] || a - b)
    .slice(0, 8);
  const leaderHost = $("#frequency-leaders");
  leaderHost.replaceChildren();
  leaders.forEach((number) => {
    const row = document.createElement("div");
    row.className = "leader-row";
    const badge = document.createElement("span");
    badge.className = "leader-number";
    badge.textContent = String(number).padStart(2, "0");
    const track = document.createElement("span");
    track.className = "leader-track";
    const fill = document.createElement("span");
    fill.className = "leader-fill";
    fill.style.width = Math.max(5, counts[number] / high * 100) + "%";
    track.append(fill);
    const count = document.createElement("span");
    count.className = "leader-count";
    count.textContent = String(counts[number]);
    row.append(badge, track, count);
    leaderHost.append(row);
  });
}

function renderArchive(resetLimit = false) {
  if (resetLimit) archiveLimit = 14;
  const query = $("#archive-search").value.trim().toLowerCase();
  const draws = eraDraws().slice().reverse().filter((draw) => {
    if (!query) return true;
    return String(draw.draw).includes(query) || draw.date.includes(query) || prettyDate(draw.date, { short: true }).toLowerCase().includes(query);
  });
  const shown = draws.slice(0, archiveLimit);
  const host = $("#archive-list");
  host.replaceChildren();
  $("#archive-count").textContent = "SHOWING " + shown.length + " OF " + draws.length + " DRAWS";
  $("#archive-summary").textContent = archive.coverage.drawCount + " results saved locally.";
  shown.forEach((draw) => {
    const row = document.createElement("article");
    row.className = "archive-row";
    const id = document.createElement("span");
    id.className = "archive-row-id";
    id.textContent = "NO. " + draw.draw;
    const date = document.createElement("time");
    date.className = "archive-row-date";
    date.dateTime = draw.date;
    date.textContent = prettyDate(draw.date, { short: true }).toUpperCase();
    const balls = document.createElement("div");
    balls.className = "mini-balls";
    setBallRow(balls, draw.numbers, true);
    row.append(id, date, balls);
    host.append(row);
  });
  $("#load-more").hidden = shown.length >= draws.length;
  if (draws.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No draws match that search.";
    host.append(empty);
  }
}

function setEra(era) {
  selectedEra = era;
  generatedNumbers = null;
  predictedLines = [];
  positionModel = null;
  $$(".era-button").forEach((button) => {
    const selected = button.dataset.era === era;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  renderLatest();
  renderRecent();
  renderNumbers();
  renderBacktest();
  renderArchive(true);
  if (selectedMode === "predict") generateSelection();
  else {
    resetOrbitNumbers();
    updateLine();
  }
}

function showView(view) {
  activeView = view;
  $$(".nav-link").forEach((button) => {
    const selected = button.dataset.viewTarget === view;
    button.classList.toggle("is-active", selected);
    if (selected) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  $$(".view-panel").forEach((panel) => {
    const selected = panel.id === "view-" + view;
    panel.hidden = !selected;
    panel.classList.toggle("is-visible", selected);
  });
  if (view === "history") $("#archive-search").focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function attachEvents() {
  $$(".nav-link, .text-link").forEach((button) => {
    button.addEventListener("click", () => showView(button.dataset.viewTarget));
  });
  $$(".era-button").forEach((button) => button.addEventListener("click", () => setEra(button.dataset.era)));
  $$(".mode-option").forEach((button) => {
    button.addEventListener("click", () => {
      selectedMode = button.dataset.mode;
      $$(".mode-option").forEach((option) => {
        const selected = option === button;
        option.classList.toggle("is-selected", selected);
        option.setAttribute("aria-pressed", String(selected));
      });
      generateSelection();
    });
  });
  $("#generate-line").addEventListener("click", generateSelection);
  $$("#outcome-count, #outcome-diversity").forEach((control) => {
    control.addEventListener("change", () => {
      if (selectedMode === "predict") generateSelection();
    });
  });
  $("#copy-line").addEventListener("click", async () => {
    if (!generatedNumbers) return;
    await copyNumbers($("#copy-line"), [generatedNumbers]);
  });
  $("#copy-all-outcomes").addEventListener("click", async () => {
    if (predictedLines.length) await copyNumbers($("#copy-all-outcomes"), predictedLines);
  });
  $("#archive-search").addEventListener("input", () => renderArchive(true));
  $("#load-more").addEventListener("click", () => {
    archiveLimit += 14;
    renderArchive();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) {
      event.preventDefault();
      showView("history");
      $("#archive-search").focus();
    }
    if (event.key === "Escape" && activeView === "history") {
      $("#archive-search").value = "";
      renderArchive(true);
      $("#archive-search").blur();
    }
  });
}

function renderArchiveData() {
  $("#rail-draw-count").textContent = archive.coverage.drawCount + " draws";
  const retrieved = prettyDate(archive.retrievedAt, { short: true }).toUpperCase();
  $("#snapshot-label").textContent = "ARCHIVE UPDATED · " + retrieved;
  $("#history-snapshot-label").textContent = "ARCHIVE UPDATED " + retrieved + ".";
  $("#coverage-note").textContent = "OFFICIAL RESULTS · " + prettyDate(archive.coverage.firstDate, { short: true }).toUpperCase() + "—" + prettyDate(archive.coverage.lastDate, { short: true }).toUpperCase();
  renderLatest();
  renderRecent();
  renderNumbers();
  renderBacktest();
  renderArchive();
  if (selectedMode === "predict" && !generatedNumbers) generateSelection();
  else updateLine();
}

function scheduleResultsPoll(refreshing) {
  if (resultsPollTimer) window.clearTimeout(resultsPollTimer);
  if (document.visibilityState !== "visible") return;
  resultsPollTimer = window.setTimeout(() => { void syncResults(); }, refreshing ? 2000 : 60_000);
}

async function syncResults() {
  if (resultsRequestInFlight || document.visibilityState !== "visible") return;
  resultsRequestInFlight = true;
  try {
    const response = await fetch(RESULTS_PATH, { cache: "no-store" });
    if (!response.ok) throw new Error("Results service could not be reached.");
    const snapshot = await response.json();
    const incoming = snapshot.archive;
    if (!incoming || !Array.isArray(incoming.draws) || incoming.draws.length === 0 ||
        !incoming.coverage || incoming.coverage.drawCount !== incoming.draws.length ||
        incoming.coverage.lastDraw !== incoming.draws.at(-1)?.draw) throw new Error("The results service returned an incomplete archive.");
    const previousDraw = archive?.coverage?.lastDraw;
    const archiveChanged = !archive || incoming.coverage.lastDraw !== previousDraw || incoming.retrievedAt !== archive.retrievedAt;
    archive = incoming;
    if (archiveChanged) {
      if (previousDraw !== undefined && incoming.coverage.lastDraw > previousDraw && selectedMode === "predict") {
        generatedNumbers = null;
        predictedLines = [];
        positionModel = null;
      }
      renderArchiveData();
    }
    renderResultsStatus(snapshot);
    scheduleResultsPoll(Boolean(snapshot.refreshing));
  } catch {
    scheduleResultsPoll(false);
  } finally {
    resultsRequestInFlight = false;
  }
}

function watchForArchiveUpdates() {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void syncResults();
    else if (resultsPollTimer) window.clearTimeout(resultsPollTimer);
  });
  scheduleResultsPoll(false);
}

async function loadInitialSnapshot() {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(RESULTS_PATH, { cache: "no-store" });
      if (!response.ok) throw new Error("The results service could not be reached");
      const snapshot = await response.json();
      const incoming = snapshot.archive;
      if (!incoming || !Array.isArray(incoming.draws) || incoming.draws.length === 0 ||
          !incoming.coverage || incoming.coverage.drawCount !== incoming.draws.length ||
          incoming.coverage.lastDraw !== incoming.draws.at(-1)?.draw) throw new Error("Archive file is incomplete");
      return snapshot;
    } catch (error) {
      lastError = error;
      if (attempt < 4) await new Promise((resolve) => window.setTimeout(resolve, 250 * (2 ** attempt)));
    }
  }
  throw lastError;
}

async function start() {
  try {
    const snapshot = await loadInitialSnapshot();
    archive = snapshot.archive;
    attachEvents();
    renderArchiveData();
    if (selectedMode === "uniform" && !firstQuickPick) generateSelection();
    renderResultsStatus(snapshot);
    watchForArchiveUpdates();
  } catch (error) {
    document.querySelector(".workspace").innerHTML = '<section class="load-error"><p class="eyebrow">THE ARCHIVE DID NOT LOAD</p><h1>One small snag.</h1><p>Start this folder with <code>npm start</code> so the app server can load the archive.</p></section>';
    console.error(error);
  }
}

start();

