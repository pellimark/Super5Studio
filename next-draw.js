const DRAW_WEEKDAYS = new Set([3, 5]); // Wednesday and Friday in JavaScript's Sunday-first convention.

function dateStringInMalta(date) {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Malta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addCalendarDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function nextScheduledDraw(latestVerifiedDraw, now = new Date()) {
  if (!latestVerifiedDraw || !Number.isSafeInteger(latestVerifiedDraw.draw) || latestVerifiedDraw.draw < 1 ||
      typeof latestVerifiedDraw.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(latestVerifiedDraw.date)) {
    throw new TypeError("A verified draw number and YYYY-MM-DD date are required.");
  }
  const afterLatest = addCalendarDays(latestVerifiedDraw.date, 1);
  let candidate = dateStringInMalta(now);
  if (candidate < afterLatest) candidate = afterLatest;
  while (!DRAW_WEEKDAYS.has(new Date(`${candidate}T00:00:00.000Z`).getUTCDay())) {
    candidate = addCalendarDays(candidate, 1);
  }
  return { draw: latestVerifiedDraw.draw + 1, date: candidate };
}
