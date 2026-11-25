import { createHash } from "node:crypto";

/**
 * Tokscale's submit API, as implemented by github.com/junhoyeo/tokscale
 * (packages/frontend/src/app/api/submit/route.ts and lib/validation/submission.ts).
 */

export const TOKSCALE_API_URL = "https://tokscale.ai";
export const TOKSCALE_HOST = "tokscale.ai";
export const DEVICE_NAME = "p0code";
/** Sent as `meta.version`; Tokscale caps it at 20 characters. */
export const CLIENT_VERSION = "p0code-plugin/0.1.0";

/**
 * p0code usage providers to Tokscale client ids. Tokscale only accepts its own list, so a
 * provider it does not know (muse) is left out rather than mislabelled.
 */
const CLIENTS: Readonly<Record<string, string>> = {
  claude: "claude",
  codex: "codex",
  grok: "grok",
  cursor: "cursor",
  opencode: "opencode",
  antigravity: "antigravity",
  pi: "pi",
};

export function tokscaleClient(provider: string): string | null {
  return Object.hasOwn(CLIENTS, provider) ? (CLIENTS[provider] ?? null) : null;
}

/** Additive buckets: Tokscale's total is the sum of all five. */
export interface TokenBreakdown {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoning: number;
}

export interface ClientContribution {
  readonly client: string;
  readonly modelId: string;
  readonly tokens: TokenBreakdown;
  readonly cost: number;
  readonly messages: number;
}

export interface DailyContribution {
  readonly date: string;
  readonly totals: {
    readonly tokens: number;
    readonly cost: number;
    readonly messages: number;
    /** Only sent as `false`, when some usage that day had no known price. */
    readonly costIsComplete?: false;
  };
  readonly intensity: number;
  readonly tokenBreakdown: TokenBreakdown;
  readonly clients: ReadonlyArray<ClientContribution>;
}

export interface TokscaleSubmission {
  readonly meta: {
    readonly generatedAt: string;
    readonly version: string;
    readonly dateRange: { readonly start: string; readonly end: string };
  };
  /** Tokscale replaces this device's numbers per day and client, so resending never adds. */
  readonly device: { readonly id: string; readonly name: string };
  readonly summary: {
    readonly totalTokens: number;
    readonly totalCost: number;
    readonly totalDays: number;
    readonly activeDays: number;
    readonly averagePerDay: number;
    readonly maxCostInSingleDay: number;
    readonly clients: ReadonlyArray<string>;
    readonly models: ReadonlyArray<string>;
  };
  readonly years: ReadonlyArray<{
    readonly year: string;
    readonly totalTokens: number;
    readonly totalCost: number;
    readonly range: { readonly start: string; readonly end: string };
  }>;
  readonly contributions: ReadonlyArray<DailyContribution>;
}

export function tokenTotal(tokens: TokenBreakdown): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite + tokens.reasoning;
}

/**
 * A stable, opaque device id for this environment. Tokscale keys a device's numbers by it, so
 * it must not change between publishes; hashing keeps the environment id itself private.
 */
export function deviceIdFor(environmentId: string): string {
  return `p0code-${createHash("sha256").update(environmentId).digest("hex").slice(0, 32)}`;
}

/** The service origin, or null unless it is HTTPS (plain HTTP only for this machine). */
export function normalizeApiUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return url.protocol === "https:" || (url.protocol === "http:" && local) ? url.origin : null;
}
