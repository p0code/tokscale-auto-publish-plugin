import type { EnvironmentId } from "@t3tools/contracts";
import { PluginContext } from "@t3tools/plugin-api";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import { usageRow } from "./fixtures.ts";
import { makePublisher } from "./publisher.ts";
import type { UsageDailyTotal } from "./usage.ts";

interface Sent {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

/** A plugin host and a Tokscale that answer in memory. */
function harness(options: { readonly status?: number } = {}) {
  const storage = new Map<string, string>([["token", "tt_secret"]]);
  const sent: Array<Sent> = [];
  let rows: ReadonlyArray<UsageDailyTotal> = [
    usageRow({ day: "2026-11-20", uncachedInputTokens: 100, outputTokens: 50, costUsd: 0.5 }),
  ];

  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const body = request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      sent.push({
        url: request.url,
        authorization: request.headers["authorization"],
        body: body === "" ? null : JSON.parse(body),
      });
      const status = options.status ?? 200;
      const answer = status === 200 ? { success: true, username: "howard" } : { error: "Nope" };
      return HttpClientResponse.fromWeb(request, new Response(JSON.stringify(answer), { status }));
    }),
  );

  // Built as a variable so it also satisfies the full host context in the p0code workspace.
  const context = {
    pluginId: "tokscale-auto-publish",
    dataDir: "/nonexistent",
    storage: {
      get: (key: string) => Effect.sync(() => Option.fromNullishOr(storage.get(key))),
      set: (key: string, value: string) => Effect.sync(() => void storage.set(key, value)),
      remove: (key: string) => Effect.sync(() => void storage.delete(key)),
    },
    reportStatus: () => Effect.void,
    environment: {
      environmentId: Effect.succeed("env-1" as EnvironmentId),
      descriptor: Effect.die("unused"),
      localOrigin: Effect.die("unused"),
    },
    deviceAccess: { issueCredential: () => Effect.die("unused"), revokeAll: Effect.die("unused") },
    agentActivity: {
      changes: Stream.empty,
      read: () => Effect.succeed(null),
      activeThreadIds: Effect.succeed([]),
    },
    usage: { dailyTotals: () => Effect.sync(() => rows) },
  };

  const run = <A, E>(
    use: (publisher: Effect.Success<ReturnType<typeof makePublisher>>) => Effect.Effect<A, E>,
  ) =>
    Effect.runPromise(
      makePublisher().pipe(
        Effect.flatMap(use),
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(PluginContext, PluginContext.of(context)),
            Layer.succeed(HttpClient.HttpClient, http),
          ),
        ),
      ),
    );

  return {
    storage,
    sent,
    run,
    setRows: (next: ReadonlyArray<UsageDailyTotal>) => void (rows = next),
  };
}

describe("publisher", () => {
  it("previews without sending, then publishes exactly the previewed body", async () => {
    const h = harness();
    const preview = await h.run((p) => p.actions.preview());
    expect(h.sent).toEqual([]);
    expect(preview.days.map((day) => [day.date, day.published])).toEqual([["2026-11-20", false]]);

    await h.run((p) => p.actions.publishNow());
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.url).toBe("https://tokscale.ai/api/submit");
    expect(h.sent[0]?.authorization).toBe("Bearer tt_secret");
    const { meta: sentMeta, ...sentRest } = h.sent[0]?.body as { meta: object };
    const { meta: previewMeta, ...previewRest } = JSON.parse(preview.body ?? "null");
    expect(sentRest).toEqual(previewRest);
    expect(Object.keys(sentMeta)).toEqual(Object.keys(previewMeta));
  });

  it("never sends the same day twice, and resends a day only when it grew", async () => {
    const h = harness();
    const first = await h.run((p) => p.actions.publishNow());
    const second = await h.run((p) => p.actions.publishNow());
    expect(h.sent).toHaveLength(1);
    expect(first.lastRun?.sentDays).toBe(1);
    expect(second.lastRun).toMatchObject({ ok: true, sentDays: 0, message: "Up to date." });
    expect((await h.run((p) => p.actions.preview())).body).toBeNull();

    h.setRows([
      usageRow({ day: "2026-11-20", uncachedInputTokens: 100, outputTokens: 50, costUsd: 0.5 }),
      usageRow({ day: "2026-11-21", outputTokens: 10, costUsd: 0.1 }),
    ]);
    await h.run((p) => p.actions.publishNow());
    const body = h.sent[1]?.body as { contributions: Array<{ date: string }> };
    expect(body.contributions.map((day) => day.date)).toEqual(["2026-11-21"]);
  });

  it("remembers the account Tokscale reports and never exposes the token", async () => {
    const h = harness();
    const status = await h.run((p) => p.actions.publishNow());
    expect(status.account).toBe("howard");
    expect(JSON.stringify(status)).not.toContain("tt_secret");
  });

  it("forgets a token Tokscale rejects and keeps the day unpublished", async () => {
    const h = harness({ status: 401 });
    const failure = await h.run((p) => p.actions.publishNow().pipe(Effect.flip));
    expect(failure.message).toBe("Tokscale rejected the token. Sign in again.");
    expect(h.storage.has("token")).toBe(false);
    expect(h.storage.has("ledger")).toBe(false);
    const status = await h.run((p) => p.actions.status());
    expect(status).toMatchObject({ signedIn: false, lastRun: { ok: false } });
  });

  it("will not turn auto-publish on before sign-in", async () => {
    const h = harness();
    h.storage.delete("token");
    const failure = await h.run((p) => p.actions.setConfig({ autoPublish: true }).pipe(Effect.flip));
    expect(failure.message).toBe("Sign in to Tokscale first.");
  });

  it("accepts only Tokscale API tokens when pasted", async () => {
    const h = harness();
    const failure = await h.run((p) => p.actions.setToken({ token: "sk-123" }).pipe(Effect.flip));
    expect(failure.message).toBe("A Tokscale API token starts with tt_.");
    const status = await h.run((p) => p.actions.setToken({ token: " tt_abc123 " }));
    expect(status.signedIn).toBe(true);
    expect(h.storage.get("token")).toBe("tt_abc123");
  });

  it("signs out instead of sending the token to a different Tokscale", async () => {
    const h = harness();
    await h.run((p) => p.actions.setConfig({ autoPublish: true }));
    const status = await h.run((p) => p.actions.setConfig({ apiUrl: "https://tokscale.example/" }));
    expect(status).toMatchObject({
      signedIn: false,
      config: { apiUrl: "https://tokscale.example", autoPublish: false },
    });
    expect(h.storage.has("token")).toBe(false);
  });
});
