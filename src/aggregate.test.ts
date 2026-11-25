import { describe, expect, it } from "vite-plus/test";

import { aggregate, toTokens } from "./aggregate.ts";
import { usageRow } from "./fixtures.ts";
import { tokenTotal } from "./tokscale.ts";

describe("aggregate", () => {
  it("sums rows the host splits by source into one entry per day, client and model", () => {
    const row = usageRow({ uncachedInputTokens: 100, outputTokens: 50, costUsd: 0.1, records: 2 });
    const { days } = aggregate([row, { ...row, cachedInputTokens: 1_000, costUsd: 0.2, records: 1 }]);

    expect(days).toEqual([
      {
        date: "2026-11-20",
        models: [
          {
            client: "claude",
            model: "claude-opus-5-5",
            tokens: { input: 200, output: 100, cacheRead: 1_000, cacheWrite: 0, reasoning: 0 },
            cost: 0.3,
            messages: 3,
            costIncomplete: false,
          },
        ],
      },
    ]);
  });

  it("splits reasoning out of output so Tokscale's additive total matches p0code's", () => {
    const row = usageRow({ uncachedInputTokens: 10, outputTokens: 500, reasoningTokens: 120 });
    const tokens = toTokens(row);

    expect(tokens).toEqual({ input: 10, output: 380, cacheRead: 0, cacheWrite: 0, reasoning: 120 });
    expect(tokenTotal(tokens)).toBe(510);
    // A malformed row claiming more reasoning than output cannot go negative or inflate the total.
    expect(toTokens(usageRow({ outputTokens: 5, reasoningTokens: 50 }))).toMatchObject({
      output: 0,
      reasoning: 5,
    });
  });

  it("leaves out providers Tokscale does not know and rows without tokens, and says so", () => {
    const { days, skipped } = aggregate([
      usageRow({ provider: "muse", model: "muse-1", outputTokens: 10 }),
      usageRow({ model: "priced-but-empty", costUsd: 1 }),
      usageRow({ model: "fine", outputTokens: 10 }),
    ]);

    expect(days.flatMap((day) => day.models.map((model) => model.model))).toEqual(["fine"]);
    expect(skipped).toEqual(
      expect.arrayContaining([
        { provider: "muse", model: "muse-1", reason: "unsupported-provider" },
        { provider: "claude", model: "priced-but-empty", reason: "no-tokens" },
      ]),
    );
  });

  it("marks a model's cost incomplete when some of its usage has no price", () => {
    const { days } = aggregate([usageRow({ outputTokens: 10, records: 3, unpricedRecords: 1 })]);
    expect(days[0]?.models[0]?.costIncomplete).toBe(true);
  });

  it("orders days and models and is independent of row order", () => {
    const rows = [
      usageRow({ day: "2026-11-21", provider: "codex", model: "gpt-5.5", outputTokens: 1 }),
      usageRow({ day: "2026-11-20", provider: "codex", model: "gpt-5.5", outputTokens: 1 }),
      usageRow({ day: "2026-11-20", provider: "claude", model: "b", outputTokens: 1 }),
      usageRow({ day: "2026-11-20", provider: "claude", model: "a", outputTokens: 1 }),
    ];
    const forward = aggregate(rows);

    expect(forward.days.map((day) => day.date)).toEqual(["2026-11-20", "2026-11-21"]);
    expect(forward.days[0]?.models.map((m) => `${m.client}/${m.model}`)).toEqual([
      "claude/a",
      "claude/b",
      "codex/gpt-5.5",
    ]);
    expect(aggregate(rows.toReversed())).toEqual(forward);
  });

  it("rounds away floating point noise in costs", () => {
    const { days } = aggregate([
      usageRow({ outputTokens: 1, costUsd: 0.1 }),
      usageRow({ outputTokens: 1, costUsd: 0.2 }),
    ]);
    expect(days[0]?.models[0]?.cost).toBe(0.3);
  });
});
