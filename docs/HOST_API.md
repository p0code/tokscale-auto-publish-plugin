# Host API this plugin needs: `usage:read`

p0code already knows every token an agent spent: `UsageService` (`apps/server/src/usage/UsageService.ts`) scans the Claude, Codex, Grok, Cursor, OpenCode, Antigravity, Pi and Muse transcripts and prices them (`usagePricing.ts`). Plugins cannot read it yet. This plugin is written against the API below, and will not typecheck or start in p0code until the host adds it.

The API is deliberately narrow: one row per local day, provider and model, with numbers only. No source paths, home directories, session ids, projects, threads or prompts reach the plugin, so a plugin with `usage:read` can learn how much was spent, not on what.

## 1. Capability (`packages/contracts/src/plugins.ts`)

```ts
export const PluginCapability = Schema.Literals([
  "network:outbound",
  "process:spawn",
  "http:routes",
  "auth:issue-device-credentials",
  "orchestration:read-activity",
  "usage:read", // new: daily token and cost totals per provider and model
]);
```

Like `orchestration:read-activity`, the host enforces it: a plugin that did not declare it gets `PluginError("The plugin did not declare this capability.")`.

## 2. Context field (`packages/plugin-api/src/index.ts`)

```ts
export interface UsageDailyTotal {
  /** `YYYY-MM-DD` in the requested time zone. */
  readonly day: string;
  /** A `UsageProviderKind`, typed as string so a newer host cannot break an older plugin. */
  readonly provider: string;
  readonly model: string;
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  /** Includes reasoning tokens, as in `UsageTokenTotals`. */
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly costUsd: number;
  readonly records: number;
  /** Records with no known price; their cost is missing from `costUsd`. */
  readonly unpricedRecords: number;
}

// Inside PluginContext:
/** Requires the `usage:read` capability. */
readonly usage: {
  /** Daily totals per provider and model; days with no usage are absent. */
  readonly dailyTotals: (input: {
    readonly sinceDay: string; // YYYY-MM-DD, inclusive
    readonly untilDay: string; // YYYY-MM-DD, inclusive
    readonly timeZone: string; // IANA zone
  }) => Effect.Effect<ReadonlyArray<UsageDailyTotal>, PluginError>;
};
```

The plugin copy of these types is [`src/usage.ts`](../src/usage.ts).

## 3. Binding (`apps/server/src/plugins/bindings.ts`)

`contextFor` already gates `deviceAccess` and `agentActivity` with `declared(...)`. Add `usage` the same way, backed by `UsageService.readSummary` with day resolution, and fold the buckets so nothing but the numbers crosses over:

```ts
usage: declared("usage:read")
  ? {
      dailyTotals: (input) =>
        usage
          .readSummary({ ...input, resolution: "day", awaitRefresh: true })
          .pipe(
            Effect.map((summary) => toDailyTotals(summary.buckets)),
            Effect.mapError(hostError("Could not read usage.")),
          ),
    }
  : { dailyTotals: () => refused },
```

```ts
/** One row per day, provider and model; drops sourcePath, hourStart and session counts. */
function toDailyTotals(buckets: ReadonlyArray<UsageBucket>): Array<UsageDailyTotal> {
  const rows = new Map<string, UsageDailyTotal>();
  for (const bucket of buckets) {
    const key = `${bucket.day}\u0000${bucket.provider}\u0000${bucket.model}`;
    const row = rows.get(key);
    rows.set(key, {
      day: bucket.day,
      provider: bucket.provider,
      model: bucket.model,
      uncachedInputTokens: (row?.uncachedInputTokens ?? 0) + bucket.totals.uncachedInputTokens,
      cachedInputTokens: (row?.cachedInputTokens ?? 0) + bucket.totals.cachedInputTokens,
      cacheCreationTokens: (row?.cacheCreationTokens ?? 0) + bucket.totals.cacheCreationTokens,
      outputTokens: (row?.outputTokens ?? 0) + bucket.totals.outputTokens,
      reasoningTokens: (row?.reasoningTokens ?? 0) + bucket.totals.reasoningTokens,
      costUsd: (row?.costUsd ?? 0) + bucket.costUsd,
      records: (row?.records ?? 0) + bucket.records,
      unpricedRecords: (row?.unpricedRecords ?? 0) + bucket.unpricedRecords,
    });
  }
  return [...rows.values()];
}
```

`UsageService` must join the layers `PluginHostBindings` is built from (it already exists as `layerUsage` in `apps/server/src/server.ts`). The plugin asks for at most 30 days at a time, at most hourly, and `UsageService`'s scan cache keeps repeat reads cheap.

## 4. Things the host should keep true

- **Same numbers as the Usage page.** Use the server's own pricing and model aliases, so what a person sees in p0code is what gets published.
- **No identifying fields, ever.** If `UsageBucket` grows fields such as a project id, they stay out of `UsageDailyTotal`.
- **Off unless declared.** The settings UI shows `usage:read` next to the plugin before it is enabled, like the other capabilities.
- **Muse is not a Tokscale client.** The host returns it anyway; this plugin leaves out providers Tokscale does not accept and shows them as skipped in its preview.

## 5. Registering the plugin

After the API lands:

1. `git submodule add https://github.com/p0code/tokscale-auto-publish-plugin plugins/tokscale-auto-publish`
2. Add `"@t3tools/plugin-tokscale-auto-publish": "workspace:*"` to `apps/server` and `apps/web`, then `pnpm install`.
3. Add `tokscaleAutoPublish` to `bundledPlugins` in `apps/server/src/plugins/registry.ts`.
4. Move [`web/TokscalePanel.tsx`](../web/TokscalePanel.tsx) to `apps/web/src/components/settings/` and add `{ Disclosure: TokscaleDisclosure, Panel: TokscalePanel }` under `TOKSCALE_PLUGIN_ID` in `PLUGIN_PANELS` (`apps/web/src/components/settings/PluginsSettings.tsx`).
