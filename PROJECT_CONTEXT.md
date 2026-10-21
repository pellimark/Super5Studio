# Super5 Studio — Project Context

## Purpose

Super5 Studio is an independent, local-first playground for viewing Malta Super5 results, exploring descriptive number frequencies, and generating sample lines. It is not affiliated with the Malta National Lottery.

## Project boundaries

- Keep this project independent from the PettyLogs application and its Angular workspace.
- It has no third-party runtime dependencies. The small Node server serves local files and the `/api/results` endpoint.
- The app receives its saved archive from `/api/results`; that endpoint starts a background source refresh only when the last completed check is at least 30 minutes old.
- `npm run update-results` and the server share the official-history parser, Stats247 fallback parser, validation, archive merge, and atomic write logic. Stats247 is tried only when the official page request or parser fails, and fallback use is shown in the source-check status. A Windows Task Scheduler task can be installed explicitly with `scripts/install-results-task.ps1`; starting the app never registers it.
- The browser calls only the app’s own server. It receives the current archive immediately, polls the app endpoint while a server refresh is active, and applies new validated results in place. The server allows one refresh at a time and records completed check time/status in `data/results-check.json`.

## Data

The baseline snapshot was retrieved from the [official Super5 results history](https://lottery.mt/super5/results/history) on 20 October 2026. It contains draws 1–393, dated 13 July 2022 through 16 October 2026. The updater preserves its metadata and normally adds later results from the same source. If that page cannot be read, the updater may use [Stats247](https://stats247.com/lotto/malta-super-5) as a third-party fallback after confirming the saved latest draw, regular schedule, and result format. Stats247 notes its data may be delayed or contain mistakes; fallback use is recorded and displayed. The archive does not include results before draw 1 in this operator archive, so it must not be described as all-time Super5 history.

The [official FAQ](https://support.lottery.mt/faq/when-are-super5-and-super5-plus-draws-conducted/) confirms Wednesday and Friday draws. The optional Windows schedule checks at 21:00 on draw days and retries the next morning. The app shows the latest saved draw separately from the last source check. It estimates the next scheduled date using Wednesday/Friday in Malta time and labels that date as scheduled because exceptions are possible. The updater parses visible result cards because no official machine-readable feed is documented; if sources are stale, incomplete, or invalid, it reports an error and leaves the archive untouched.

The app can run as a Render Node web service using `npm start`; it reads Render's `PORT` value and binds to `0.0.0.0`. The service can fetch the official page, but Render's default filesystem is ephemeral, so archive and check-state writes are lost on restart or deploy unless persistent storage is configured. Render persistent disks require a paid web service; a free web service has no persistent disk. The optional Windows task only changes local project files.

Rules are represented as separate eras:

- Draws 1–258: five numbers from 1 to 45.
- Draw 259 onward: five numbers from 1 to 49, following the [official format announcement](https://instore.lottery.mt/new-super5-game-format/).

## Number selection and claims

- Quick pick samples five distinct numbers uniformly from the selected range.
- Recent favourites and Long view rank numbers by historical frequency within the selected era.
- Overdue list ranks numbers by draws since last appearance.
- Past-draw sample picks model five sorted positions (lowest through highest); the archive records sorted numbers, not actual ball draw order. Each position uses next-value transition counts after its latest value, smoothed with positional frequencies from the last 60 draws (add-one prior, prior strength 5). It combines the five position scores to rank valid, ascending lines of five unique numbers within the selected era.
- Sample-pick variety: Closest allows at most 4 shared numbers between any two distinct lines (the original score-only ranking); Balanced is the default and allows at most 3; More varied allows at most 2. The highest-ranked line is always the anchor. Each later line is the highest-scoring candidate compatible with every earlier selection, counting shared numbers regardless of their positions. This is greedy selection, not global set optimization. Branch-and-bound search uses independent positional score maxima to avoid exhaustive enumeration or a limited top-candidate pool. Never silently relax overlap limits to fill the count; show an explanation if fewer compatible lines remain.
- Choose 1–10 sample lines, five by default. Archive and settings determine output, with lexicographic tie-breaking and a stable prefix as count increases. Changing count, variety, or era regenerates immediately. Preserve individual copy, Copy All, and clipboard fallback. Greater variety may include lower-ranked pattern matches. Neither pattern scores nor variety settings represent winning probabilities or improve a line’s chance of winning.
- Both eras are bounded: classic uses draws 1–258 only, current starts at draw 259. Switching eras rebuilds sample picks from that era alone.
- Historical rankings are entertainment and descriptive statistics only. They do not improve a line’s odds or predict a future draw.

## Run locally

From this folder, run npm start with Node.js installed. The server binds to 127.0.0.1, serves the app from this project directory, and provides `/api/results`. On an app request it returns the saved archive before the background refresh completes.

## Key files

- index.html, styles.css, app.js, next-draw.js — the standalone interface, picker, and Malta-time schedule display.
- position-predictor.js and tests/position-predictor.test.mjs — positional pattern scoring, constrained diversity selection, exhaustive small-range reference checks, deterministic valid outputs in both eras, and a two-second performance regression budget for 10-line generation per setting and era. Check browser timing and desktop/mobile layout after search or UI changes.
- data/super5-draws.json — the archived results and source metadata.
- server.mjs, results-service.mjs, results-check-state.mjs, package.json — the local results endpoint, single-flight stale refresh service, and completed-check record.
- README.md — setup, server refresh behavior, manual refresh, hosting requirements, and schedule install/removal.
- update-results.mjs and scripts/ — shared dependency-free updater and opt-in Windows Task Scheduler scripts.
- tests/results-update.test.mjs and tests/fixtures/ — saved official-history HTML fixtures for archive validation, merge behavior, refresh concurrency, and Malta schedule dates.
- MOVE_PROJECT_PROMPT.md — a reusable prompt for relocating this project out of an enclosing PettyLogs checkout.
