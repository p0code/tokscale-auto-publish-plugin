/**
 * The host API this plugin needs and p0code does not have yet. See docs/HOST_API.md.
 *
 * One row is one model's usage on one local day. Rows carry no paths, sessions, projects,
 * threads or prompts; that is the point of the API.
 */
export interface UsageDailyTotal {
  /** `YYYY-MM-DD` in the requested time zone. */
  readonly day: string;
  /** p0code's `UsageProviderKind`, kept a string so a newer host cannot break the plugin. */
  readonly provider: string;
  readonly model: string;
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  /** Includes reasoning tokens. */
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly costUsd: number;
  readonly records: number;
  /** Records with no known price; their cost is missing from `costUsd`. */
  readonly unpricedRecords: number;
}

export interface UsageDailyTotalsInput {
  readonly sinceDay: string;
  readonly untilDay: string;
  /** IANA zone the host buckets days in. */
  readonly timeZone: string;
}
