import { describe, expect, it } from "vite-plus/test";

import { aggregate } from "./aggregate.ts";
import { usageRow } from "./fixtures.ts";
import { fingerprintDay, ledgerTarget, pendingDays, recordPublished } from "./ledger.ts";

const target = ledgerTarget("https://tokscale.ai", "p0code-abc");
const week = aggregate(
  ["2026-11-18", "2026-11-19", "2026-11-20"].map((day) => usageRow({ day, outputTokens: 10 })),
).days;

describe("ledger", () => {
  it("sends every day the first time and nothing once they are recorded", () => {
    expect(pendingDays(week, null, target)).toEqual(week);
    const ledger = recordPublished(null, target, week, "2026-11-01");
    expect(pendingDays(week, ledger, target)).toEqual([]);
  });

  it("resends only the day whose numbers grew", () => {
    const ledger = recordPublished(null, target, week, "2026-11-01");
    const later = aggregate([
      usageRow({ day: "2026-11-18", outputTokens: 10 }),
      usageRow({ day: "2026-11-19", outputTokens: 10 }),
      usageRow({ day: "2026-11-20", outputTokens: 10 }),
      usageRow({ day: "2026-11-20", outputTokens: 5, model: "another" }),
    ]).days;
    expect(pendingDays(later, ledger, target).map((day) => day.date)).toEqual(["2026-11-20"]);
  });

  it("starts over for another service or device", () => {
    const ledger = recordPublished(null, target, week, "2026-11-01");
    const elsewhere = ledgerTarget("https://tokscale.example", "p0code-abc");
    expect(pendingDays(week, ledger, elsewhere)).toEqual(week);
    expect(recordPublished(ledger, elsewhere, week.slice(0, 1), "2026-11-01").days).toEqual({
      "2026-11-18": fingerprintDay(week[0]!),
    });
  });

  it("forgets days that fell out of the publish window", () => {
    const ledger = recordPublished(null, target, week, "2026-11-01");
    expect(Object.keys(recordPublished(ledger, target, [], "2026-11-19").days)).toEqual([
      "2026-11-19",
      "2026-11-20",
    ]);
  });

  it("fingerprints the numbers, not the order the host returned them in", () => {
    const rows = [
      usageRow({ model: "a", outputTokens: 1 }),
      usageRow({ model: "b", outputTokens: 2 }),
    ];
    const [forward] = aggregate(rows).days;
    const [backward] = aggregate(rows.toReversed()).days;
    expect(fingerprintDay(forward!)).toBe(fingerprintDay(backward!));
  });
});
