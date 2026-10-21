# Super5 Studio

A small, local-first playground for Malta Super5 results. It has no third-party runtime dependencies. The app server returns its saved JSON archive immediately and checks the official history in the background when the last completed check is more than 30 minutes old. If the official page cannot be read, it can use Stats247 as a clearly labeled third-party fallback.

## Run the app

Install Node.js 18 or newer. From this folder, run:

```powershell
npm start
```

Open the local address printed in the terminal. No `npm install` is needed.

## Refresh results manually

Run:

```powershell
npm run update-results
```

The command first reads the official [Super5 results history](https://lottery.mt/super5/results/history/). If that request or its page parser fails, it tries [Stats247](https://stats247.com/lotto/malta-super-5) as a third-party fallback. Fallback rows must include the saved latest result, match its date and numbers, and continue on the regular Wednesday/Friday schedule. New draws are also checked for sequential draw numbers, valid dates, five unique numbers, and the correct 5/45 or 5/49 range before they are appended to `data/super5-draws.json`.

The updater validates the existing archive and every source draw before writing. If both sources are unavailable, or the fallback is stale, incomplete, changed, or invalid, it reports the error and leaves the archive untouched. Writes use a temporary file in the same directory followed by an atomic rename. Each completed check time and status is stored in `data/results-check.json`; run messages are appended to `data/results-update.log`.

The updater reuses the visible draw-card parser for the official history page; no official machine-readable feed is documented or linked by the operator. It does not call guessed or undocumented endpoints. Stats247 warns that its results may be delayed or incorrect, so any fallback check is labeled in the app and its source is recorded when it adds draws. If either source is stale, incomplete, changed, or invalid, the archive is left untouched.

## Optional Windows schedule

The National Lottery’s [FAQ](https://support.lottery.mt/faq/when-are-super5-and-super5-plus-draws-conducted/) confirms Super5 draws are on Wednesday and Friday, and the [history page](https://lottery.mt/super5/results/history/) says results are updated after draws. Its [current homepage](https://lottery.mt/) lists 18:30, while the static [Super5 guide](https://instore.lottery.mt/super5/how-to-play/) still says approximately 20:30. To cover both official timings, the task checks at 21:00 on Wednesday and Friday, with a retry at 09:00 the following Thursday and Saturday. Task Scheduler uses your Windows local time.

To install the task for your Windows account, run this from the project folder:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-results-task.ps1
```

The script registers the task only when you run it; starting the app does not install it. It runs as your account and is set to start a missed check when the computer becomes available.

To remove the task:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\remove-results-task.ps1
```

If the PC is off at a scheduled time, Windows will try the missed run when the PC is available again. If it has no Internet connection then, the updater logs the failure and the next scheduled check retries. If the official page has not posted the result yet, the next-morning retry checks again. Check `data/results-update.log` for scheduled run outcomes. This task updates files on this computer; it does not update a hosted copy.

## Open app behavior

On load, the browser requests `/api/results` from this app’s own server and renders the current archive as soon as it arrives. If the last completed source check is at least 30 minutes old, the server starts one background refresh; overlapping page requests share that refresh. The browser never scrapes the lottery site. While a refresh is running, the page checks the same app endpoint every two seconds and updates the draw archive and predictor in place when new validated results are saved. Otherwise it checks once a minute, and it checks again when a backgrounded tab becomes visible.

The “Latest saved draw” card shows the newest result in the saved archive. Its date is separate from “Last source check,” which shows when the server last completed a source check, including a failed check or third-party fallback. A failed, stale, incomplete, changed, or invalid source response does not alter the archive. The schedule card uses the latest saved draw number plus one and the regular Wednesday/Friday calendar in Malta time. It is an expected schedule only; the operator can change dates or make exceptions.

The **Official Super5 play page** link opens the lottery’s play flow. The operator’s [help article explains choosing numbers on its site](https://support.lottery.mt/faq/how-do-i-fill-in-a-super5-ticket/); it does not document a prefill handoff, so generated numbers are not transferred by this link.

## Hosting

The app can run as a Render Node web service with `npm start` as its start command. It reads Render's `PORT` value and listens on `0.0.0.0`; no build step or third-party runtime package is required. A static host alone cannot run `/api/results` or fetch the official history page.

The canonical URL and sitemap use the Render service origin `https://super5malta.onrender.com/`. If the production domain changes, update the canonical link in `index.html`, the `Sitemap` entry in `robots.txt`, and the URL in `sitemap.xml` together.

Render services use an ephemeral filesystem by default. The app can refresh its archive while an instance is running, but those writes are lost after a restart or deploy unless the service has persistent storage. Render persistent disks require a paid web service; the free web-service plan has no persistent disk. The Windows task only updates local project files and does not update a hosted copy.
## Archive and pick styles

`data/super5-draws.json` stores the draw results retrieved from the official source on 20 October 2026. It starts at draw 1 on 13 July 2022 and contains 393 draws through draw 393 on 16 October 2026. Draws 1–258 use 5/45; draw 259 onward uses 5/49, following the [official format announcement](https://instore.lottery.mt/new-super5-game-format/). It does not include results before draw 1 in this archive.

Quick pick samples five different numbers uniformly. Recent favourites, Long view, and Overdue list summarize archived frequency or draw gaps.

**Past-draw sample picks** offer 1–10 lines (five by default), ranked from patterns in the saved draws. Each line contains five distinct numbers for the selected rules era. These lines are for exploration only; every valid line has the same chance of being drawn.

Choose how much **Variety** to include:

- **Closest:** any two lines may share at most 4 numbers, preserving the original score-only ranking of distinct lines.
- **Balanced** (default): any two lines may share at most 3 numbers.
- **More varied:** any two lines may share at most 2 numbers.

The settings control how much lines may overlap. Sample picks are deterministic for the same archive and settings. Changing the variety or rules era rebuilds the set; you can copy one line or the full list. These settings do not improve the odds.

Increasing the sample count preserves the existing prefix. The picker does not predict a future draw or improve a line’s odds.

Run `npm test` for predictor checks plus fixture-based updater and service checks. The saved HTML fixtures cover no new draw, one or multiple new draws, missing draw numbers, invalid dates and numbers, changed history, stale source pages, concurrent refresh requests, and recent checks. Schedule tests cover Wednesday/Friday selection and Malta timezone boundaries. Predictor tests also check exhaustive ranking and diversity selection on small ranges, overlap across positions, tie-breaking, valid lines, count limits, and deterministic 10-line output in both rules eras. The archive regression check times generation against a generous two-second budget per setting and era.
