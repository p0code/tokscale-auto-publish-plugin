import { describe, expect, it } from "vite-plus/test";

import { addDays, isDue, isTimeZone, localDay, publishWindow, RETRY_AFTER_MS } from "./schedule.ts";

const HOUR = 60 * 60_000;
const now = Date.UTC(2026, 10, 25, 12);

describe("isDue", () => {
  it("publishes right away the first time", () => {
    expect(isDue({ schedule: "daily", now, lastSuccessAt: null, lastAttemptAt: null })).toBe(true);
  });

  it("waits a day, or an hour, after a success", () => {
    const base = { now, lastAttemptAt: now - 2 * HOUR };
    expect(isDue({ ...base, schedule: "daily", lastSuccessAt: now - 23 * HOUR })).toBe(false);
    expect(isDue({ ...base, schedule: "daily", lastSuccessAt: now - 24 * HOUR })).toBe(true);
    expect(isDue({ ...base, schedule: "hourly", lastSuccessAt: now - 2 * HOUR })).toBe(true);
  });

  it("backs off after a failure instead of retrying every tick", () => {
    const failed = { schedule: "daily" as const, lastSuccessAt: null };
    expect(isDue({ ...failed, now, lastAttemptAt: now - RETRY_AFTER_MS + 1 })).toBe(false);
    expect(isDue({ ...failed, now, lastAttemptAt: now - RETRY_AFTER_MS })).toBe(true);
  });
});

describe("days", () => {
  it("counts the day in the configured zone", () => {
    const lateEvening = Date.UTC(2026, 10, 25, 20);
    expect(localDay(lateEvening, "Asia/Taipei")).toBe("2026-11-26");
    expect(localDay(lateEvening, "America/Los_Angeles")).toBe("2026-11-25");
  });

  it("steps across months, years and leap days", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("looks back thirty days including today", () => {
    expect(publishWindow("2026-11-25")).toEqual({ sinceDay: "2026-10-27", untilDay: "2026-11-25" });
  });

  it("accepts only real time zones", () => {
    expect(isTimeZone("Asia/Taipei")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
  });
});
