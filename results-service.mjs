import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { refreshArchive, validateArchive } from "./update-results.mjs";
import { readCheckState, writeCheckState } from "./results-check-state.mjs";

export const DEFAULT_REFRESH_INTERVAL_MS = 30 * 60 * 1000;

export function createResultsService({
  archivePath,
  checkStatePath,
  logPath,
  refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
  fetchResults,
  now = () => new Date()
}) {
  let inFlight = null;
  let statePromise = null;
  let lastCheck = null;

  async function loadState() {
    if (!statePromise) {
      statePromise = readCheckState(checkStatePath).then((state) => {
        lastCheck = state;
        return state;
      }).catch(() => {
        lastCheck = null;
        return null;
      });
    }
    return statePromise;
  }

  function isStale(state) {
    if (!state) return true;
    const checkedAt = Date.parse(state.checkedAt);
    return !Number.isFinite(checkedAt) || now().getTime() - checkedAt >= refreshIntervalMs;
  }

  async function log(message, error = false) {
    if (!logPath) return;
    const line = `${now().toISOString()} ${error ? "ERROR" : "INFO"} ${message}\n`;
    await appendFile(logPath, line, "utf8").catch(() => {});
  }

  async function runRefresh() {
    let state;
    try {
      const result = await refreshArchive({
        targetPath: archivePath,
        fetchResults,
        now
      });
      const message = result.added
        ? `Added ${result.added} draw${result.added === 1 ? "" : "s"}; archive now ends at draw ${result.archive.coverage.lastDraw} (${result.archive.coverage.lastDate}).`
        : `Archive is already current at draw ${result.archive.coverage.lastDraw}; no file changes were made.`;
      state = { checkedAt: result.checkedAt, status: "success", message };
      await log(message);
    } catch (error) {
      state = { checkedAt: now().toISOString(), status: "error", message: error.message || "The official results could not be checked." };
      await log(`${state.message} The archive was left untouched.`, true);
    }
    try {
      await writeCheckState(checkStatePath, state);
      lastCheck = state;
      statePromise = Promise.resolve(state);
    } catch (error) {
      lastCheck = { ...state, message: `${state.message} Check time could not be saved: ${error.message}` };
      statePromise = Promise.resolve(lastCheck);
    }
    return state;
  }

  function startRefresh() {
    if (inFlight) return inFlight;
    const pending = runRefresh().finally(() => {
      if (inFlight === pending) inFlight = null;
    });
    inFlight = pending;
    return pending;
  }

  async function getSnapshot() {
    const [archiveBytes, state] = await Promise.all([
      readFile(archivePath, "utf8"),
      loadState()
    ]);
    const archive = validateArchive(JSON.parse(archiveBytes));
    if (isStale(state)) void startRefresh();
    return { archive, lastCheck: state, refreshing: Boolean(inFlight) };
  }

  return {
    getSnapshot,
    waitForRefresh: () => inFlight || Promise.resolve(lastCheck),
    getRefreshState: () => ({ refreshing: Boolean(inFlight), lastCheck })
  };
}
