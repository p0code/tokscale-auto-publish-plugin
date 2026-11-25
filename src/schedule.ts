export type PublishSchedule = "hourly" | "daily";

/** How far back each publish looks, so late transcripts still reach their day. */
export const LOOKBACK_DAYS = 30;
/** A failed publish waits this long before the schedule tries again. */
export const RETRY_AFTER_MS = 30 * 60_000;

const INTERVAL_MS: Record<PublishSchedule, number> = {
  hourly: 60 * 60_000,
  daily: 24 * 60 * 60_000,
};

export function isDue(input: {
  readonly schedule: PublishSchedule;
  readonly now: number;
  readonly lastSuccessAt: number | null;
  readonly lastAttemptAt: number | null;
}): boolean {
  const { now, lastSuccessAt, lastAttemptAt } = input;
  if (lastAttemptAt !== null && now - lastAttemptAt < RETRY_AFTER_MS) return false;
  return lastSuccessAt === null || now - lastSuccessAt >= INTERVAL_MS[input.schedule];
}

/** The calendar day `now` falls on in `timeZone`, as `YYYY-MM-DD`. */
export function localDay(now: number, timeZone: string): string {
  // en-CA formats dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function publishWindow(today: string): { sinceDay: string; untilDay: string } {
  return { sinceDay: addDays(today, -(LOOKBACK_DAYS - 1)), untilDay: today };
}

export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
