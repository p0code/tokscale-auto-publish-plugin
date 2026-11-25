import { type TokenBreakdown, tokenTotal, tokscaleClient } from "./tokscale.ts";
import type { UsageDailyTotal } from "./usage.ts";

/** One model's totals on one day, already in Tokscale's terms. */
export interface ModelDay {
  readonly client: string;
  readonly model: string;
  readonly tokens: TokenBreakdown;
  readonly cost: number;
  readonly messages: number;
  /** Some of this usage had no known price, so `cost` is a floor. */
  readonly costIncomplete: boolean;
}

export interface DayUsage {
  readonly date: string;
  /** Sorted by client, then model. */
  readonly models: ReadonlyArray<ModelDay>;
}

export interface SkippedModel {
  readonly provider: string;
  readonly model: string;
  readonly reason: "unsupported-provider" | "no-tokens";
}

export interface Aggregated {
  /** Sorted by date; days with nothing to send are left out. */
  readonly days: ReadonlyArray<DayUsage>;
  readonly skipped: ReadonlyArray<SkippedModel>;
}

/** Costs are summed in floating point; rounding keeps a day's numbers stable between reads. */
export const roundCost = (usd: number) => Math.round(usd * 1e6) / 1e6;

const ZERO: TokenBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };

export function addTokens(a: TokenBreakdown, b: TokenBreakdown): TokenBreakdown {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
  };
}

/**
 * p0code counts reasoning inside output; Tokscale adds its buckets, so reasoning is split out
 * of output (as Tokscale's own Codex parser does) to keep the total unchanged.
 */
export function toTokens(row: UsageDailyTotal): TokenBreakdown {
  const output = Math.max(0, row.outputTokens);
  const reasoning = Math.min(Math.max(0, row.reasoningTokens), output);
  return {
    input: Math.max(0, row.uncachedInputTokens),
    output: output - reasoning,
    cacheRead: Math.max(0, row.cachedInputTokens),
    cacheWrite: Math.max(0, row.cacheCreationTokens),
    reasoning,
  };
}

/**
 * Folds host rows into one entry per day, client and model. The host may return several rows
 * for the same key (one per transcript source), so they are summed here.
 */
export function aggregate(rows: ReadonlyArray<UsageDailyTotal>): Aggregated {
  const byKey = new Map<string, { date: string } & ModelDay>();
  const skipped = new Map<string, SkippedModel>();
  const skip = (provider: string, model: string, reason: SkippedModel["reason"]) =>
    skipped.set(`${reason}\u0000${provider}\u0000${model}`, { provider, model, reason });

  for (const row of rows) {
    const client = tokscaleClient(row.provider);
    if (client === null) {
      skip(row.provider, row.model, "unsupported-provider");
      continue;
    }
    const key = `${row.day}\u0000${client}\u0000${row.model}`;
    const current = byKey.get(key) ?? {
      date: row.day,
      client,
      model: row.model,
      tokens: ZERO,
      cost: 0,
      messages: 0,
      costIncomplete: false,
    };
    byKey.set(key, {
      ...current,
      tokens: addTokens(current.tokens, toTokens(row)),
      cost: current.cost + Math.max(0, row.costUsd),
      messages: current.messages + Math.max(0, row.records),
      costIncomplete: current.costIncomplete || row.unpricedRecords > 0,
    });
  }

  const days = new Map<string, Array<ModelDay>>();
  for (const { date, ...model } of byKey.values()) {
    // Tokscale rejects cost without tokens, and an empty row tells it nothing.
    if (tokenTotal(model.tokens) === 0) {
      skip(model.client, model.model, "no-tokens");
      continue;
    }
    const list = days.get(date) ?? [];
    list.push({ ...model, cost: roundCost(model.cost) });
    days.set(date, list);
  }

  return {
    days: [...days.entries()]
      .map(([date, models]) => ({
        date,
        models: models.toSorted(
          (a, b) => a.client.localeCompare(b.client) || a.model.localeCompare(b.model),
        ),
      }))
      .toSorted((a, b) => a.date.localeCompare(b.date)),
    skipped: [...skipped.values()],
  };
}
