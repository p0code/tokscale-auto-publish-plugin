import type { UsageDailyTotal } from "./usage.ts";

/** A host usage row with zeros for everything a test does not care about. */
export function usageRow(overrides: Partial<UsageDailyTotal>): UsageDailyTotal {
  return {
    day: "2026-11-20",
    provider: "claude",
    model: "claude-opus-5-5",
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    records: 0,
    unpricedRecords: 0,
    ...overrides,
  };
}
