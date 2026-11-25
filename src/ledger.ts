import { createHash } from "node:crypto";

import type { DayUsage } from "./aggregate.ts";

/**
 * What this device last published, per day. Tokscale already replaces a device's numbers for
 * a day instead of adding them, so resending is safe; the ledger is what keeps unchanged days
 * from being sent at all.
 */
export interface Ledger {
  /** The service and device the days were published to; another target starts empty. */
  readonly target: string;
  /** Day to the fingerprint of the numbers published for it. */
  readonly days: Readonly<Record<string, string>>;
}

export const ledgerTarget = (apiUrl: string, deviceId: string) => `${apiUrl}#${deviceId}`;

export function fingerprintDay(day: DayUsage): string {
  return createHash("sha256").update(JSON.stringify(day)).digest("hex");
}

/** Days that were never published to `target`, or whose numbers changed since. */
export function pendingDays(
  days: ReadonlyArray<DayUsage>,
  ledger: Ledger | null,
  target: string,
): ReadonlyArray<DayUsage> {
  const published = ledger?.target === target ? ledger.days : {};
  return days.filter((day) => published[day.date] !== fingerprintDay(day));
}

/** Records a successful publish and forgets days before `keepSince`, which are never resent. */
export function recordPublished(
  ledger: Ledger | null,
  target: string,
  days: ReadonlyArray<DayUsage>,
  keepSince: string,
): Ledger {
  const next: Record<string, string> = {};
  for (const [date, fingerprint] of Object.entries(ledger?.target === target ? ledger.days : {})) {
    if (date >= keepSince) next[date] = fingerprint;
  }
  for (const day of days) {
    if (day.date >= keepSince) next[day.date] = fingerprintDay(day);
  }
  return { target, days: next };
}
