import { describe, expect, it } from "vite-plus/test";

import { aggregate } from "./aggregate.ts";
import { usageRow } from "./fixtures.ts";
import { buildSubmission, intensity } from "./payload.ts";
import { tokenTotal } from "./tokscale.ts";

const device = { id: "p0code-abc", name: "p0code" };
const generatedAt = "2026-11-25T00:00:00.000Z";

const days = aggregate([
  usageRow({ day: "2025-12-31", uncachedInputTokens: 100, outputTokens: 40, costUsd: 1, records: 2 }),
  usageRow({
    day: "2026-01-01",
    provider: "codex",
    model: "gpt-5.5",
    uncachedInputTokens: 1_000,
    cachedInputTokens: 4_000,
    outputTokens: 300,
    reasoningTokens: 100,
    costUsd: 4,
    records: 5,
  }),
  usageRow({
    day: "2026-01-01",
    cacheCreationTokens: 200,
    outputTokens: 10,
    costUsd: 0.5,
    records: 1,
    unpricedRecords: 1,
  }),
]).days;

describe("buildSubmission", () => {
  it("sends nothing when there is nothing to send", () => {
    expect(buildSubmission({ days: [], device, generatedAt })).toBeNull();
  });

  it("keeps every total consistent, as Tokscale's validation requires", () => {
    const submission = buildSubmission({ days, device, generatedAt });
    if (submission === null) throw new Error("expected a submission");

    for (const day of submission.contributions) {
      const clientTokens = day.clients.reduce((sum, c) => sum + tokenTotal(c.tokens), 0);
      const clientCost = day.clients.reduce((sum, c) => sum + c.cost, 0);
      expect(tokenTotal(day.tokenBreakdown)).toBe(day.totals.tokens);
      expect(clientTokens).toBe(day.totals.tokens);
      expect(clientCost).toBeCloseTo(day.totals.cost, 6);
    }
    const contributionTokens = submission.contributions.reduce((s, d) => s + d.totals.tokens, 0);
    expect(submission.summary.totalTokens).toBe(contributionTokens);
    expect(submission.summary.totalCost).toBe(5.5);
    expect(submission.summary).toMatchObject({
      totalDays: 2,
      activeDays: 2,
      maxCostInSingleDay: 4.5,
      clients: ["claude", "codex"],
      models: ["claude-opus-5-5", "gpt-5.5"],
    });
    expect(submission.meta).toEqual({
      generatedAt,
      version: "p0code-plugin/0.1.1",
      dateRange: { start: "2025-12-31", end: "2026-01-01" },
    });
    expect(submission.meta.version.length).toBeLessThanOrEqual(20);
  });

  it("splits years and flags a day whose cost is only a floor", () => {
    const submission = buildSubmission({ days, device, generatedAt });
    expect(submission?.years.map((year) => [year.year, year.totalCost, year.range])).toEqual([
      ["2025", 1, { start: "2025-12-31", end: "2025-12-31" }],
      ["2026", 4.5, { start: "2026-01-01", end: "2026-01-01" }],
    ]);
    expect(submission?.contributions.map((day) => day.totals.costIsComplete)).toEqual([
      undefined,
      false,
    ]);
    expect(submission?.contributions.map((day) => day.intensity)).toEqual([1, 4]);
  });

  it("carries usage numbers, model names and the opaque device id, and nothing else", () => {
    const submission = buildSubmission({ days, device, generatedAt });
    expect(Object.keys(submission ?? {}).toSorted()).toEqual([
      "contributions",
      "device",
      "meta",
      "summary",
      "years",
    ]);
    expect(submission?.device).toEqual(device);
    for (const day of submission?.contributions ?? []) {
      expect(Object.keys(day).toSorted()).toEqual([
        "clients",
        "date",
        "intensity",
        "tokenBreakdown",
        "totals",
      ]);
      for (const client of day.clients) {
        expect(Object.keys(client).toSorted()).toEqual([
          "client",
          "cost",
          "messages",
          "modelId",
          "tokens",
        ]);
      }
    }
  });
});

describe("intensity", () => {
  it("buckets a day's cost against the costliest day", () => {
    expect([0, 1, 25, 50, 75, 100].map((cost) => intensity(cost, 100))).toEqual([0, 1, 2, 3, 4, 4]);
    expect(intensity(5, 0)).toBe(0);
  });
});
