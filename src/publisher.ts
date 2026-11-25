import { PluginContext, PluginError } from "@t3tools/plugin-api";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  LastRun,
  TokscaleConfig,
  type TokscaleConfigPatch,
  type TokscalePreview,
  type TokscaleStatus,
} from "./actions.ts";
import { aggregate } from "./aggregate.ts";
import { ledgerTarget, pendingDays, recordPublished } from "./ledger.ts";
import { buildSubmission } from "./payload.ts";
import { isDue, isTimeZone, localDay, publishWindow } from "./schedule.ts";
import { DEVICE_NAME, deviceIdFor, normalizeApiUrl, TOKSCALE_API_URL } from "./tokscale.ts";

const KEYS = {
  token: "token",
  account: "account",
  config: "config",
  ledger: "ledger",
  runs: "runs",
} as const;

const DEFAULT_CONFIG: TokscaleConfig = {
  autoPublish: false,
  schedule: "daily",
  timeZone: null,
  apiUrl: TOKSCALE_API_URL,
};

const StoredLedger = Schema.Struct({
  target: Schema.String,
  days: Schema.Record(Schema.String, Schema.String),
});

const StoredRuns = Schema.Struct({
  lastRun: Schema.NullOr(LastRun),
  lastSuccessAt: Schema.NullOr(Schema.Number),
  lastAttemptAt: Schema.NullOr(Schema.Number),
});
type StoredRuns = typeof StoredRuns.Type;

const DeviceCodeResponse = Schema.Struct({
  deviceCode: Schema.String,
  userCode: Schema.String,
  verificationUrl: Schema.String,
  expiresIn: Schema.Number,
  interval: Schema.Number,
});

const PollResponse = Schema.Struct({
  status: Schema.String,
  token: Schema.optionalKey(Schema.String),
  user: Schema.optionalKey(Schema.Struct({ username: Schema.String })),
});

const SubmitResponse = Schema.Struct({
  username: Schema.optionalKey(Schema.String),
  warnings: Schema.optionalKey(Schema.Array(Schema.String)),
});

const ErrorBody = Schema.Struct({
  error: Schema.String,
  details: Schema.optionalKey(Schema.Array(Schema.String)),
});

const isPluginError = Schema.is(PluginError);
const fail = (message: string) => Effect.fail(new PluginError({ message }));
const serverTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

interface RuntimeState {
  readonly pendingSignIn: { readonly verificationUrl: string; readonly userCode: string } | null;
  readonly error: string | null;
}

export const makePublisher = Effect.fn("tokscale.make")(function* () {
  const ctx = yield* PluginContext;
  const http = yield* HttpClient.HttpClient;
  const pluginScope = yield* Effect.scope;
  const publishLock = yield* Semaphore.make(1);
  const state = yield* Ref.make<RuntimeState>({ pendingSignIn: null, error: null });
  const deviceId = deviceIdFor(yield* ctx.environment.environmentId);
  const device = { id: deviceId, name: DEVICE_NAME };
  let signInFiber: Fiber.Fiber<void> | null = null;

  // Suspended so a value read once at startup is never reused.
  const readKey = (key: string) => Effect.suspend(() => ctx.storage.get(key));
  const readJson = <A, I>(key: string, schema: Schema.Codec<A, I>) =>
    readKey(key).pipe(Effect.map(Option.flatMap(Schema.decodeUnknownOption(Schema.fromJsonString(schema)))));
  const writeJson = <A, I>(key: string, schema: Schema.Codec<A, I>, value: A) =>
    Schema.encodeEffect(Schema.fromJsonString(schema))(value).pipe(
      Effect.mapError((cause) => new PluginError({ message: "Could not save Tokscale state.", cause })),
      Effect.flatMap((json) => ctx.storage.set(key, json)),
    );

  const readConfig = readJson(KEYS.config, TokscaleConfig).pipe(
    Effect.map(Option.getOrElse(() => DEFAULT_CONFIG)),
  );
  const readToken = readKey(KEYS.token);
  const readRuns = readJson(KEYS.runs, StoredRuns).pipe(
    Effect.map(
      Option.getOrElse(
        (): StoredRuns => ({ lastRun: null, lastSuccessAt: null, lastAttemptAt: null }),
      ),
    ),
  );
  const zoneOf = (config: TokscaleConfig) => config.timeZone ?? serverTimeZone();

  const status = Effect.gen(function* () {
    const [config, token, account, runs, runtime] = yield* Effect.all([
      readConfig,
      readToken,
      readKey(KEYS.account),
      readRuns,
      Ref.get(state),
    ]);
    return {
      signedIn: Option.isSome(token),
      account: Option.getOrNull(account),
      pendingSignIn: runtime.pendingSignIn,
      config,
      timeZone: zoneOf(config),
      lastRun: runs.lastRun,
      deviceId,
      error: runtime.error,
    } satisfies TokscaleStatus;
  });

  const publishStatus: Effect.Effect<void> = status.pipe(
    Effect.flatMap((current) =>
      ctx.reportStatus(
        current.error ??
          (current.pendingSignIn !== null
            ? "Waiting for Tokscale sign-in."
            : !current.signedIn
              ? "Not signed in to Tokscale."
              : !current.config.autoPublish
                ? "Auto-publish is off."
                : (current.lastRun?.message ?? `Publishing ${current.config.schedule}.`)),
      ),
    ),
    Effect.ignore,
  );

  const setState = (update: Partial<RuntimeState>) =>
    Ref.update(state, (current) => ({ ...current, ...update })).pipe(Effect.andThen(publishStatus));

  const post = <A, I>(url: string, body: unknown, schema: Schema.Codec<A, I>, token?: string) =>
    Effect.gen(function* () {
      const base = HttpClientRequest.post(url);
      const request = yield* HttpClientRequest.bodyJson(
        token === undefined ? base : base.pipe(HttpClientRequest.bearerToken(token)),
        body,
      );
      const response = yield* http.execute(request);
      if (response.status >= 200 && response.status < 300) {
        return yield* HttpClientResponse.schemaBodyJson(schema)(response);
      }
      const error = yield* HttpClientResponse.schemaBodyJson(ErrorBody)(response).pipe(
        Effect.option,
      );
      if (response.status === 401) {
        // A revoked or expired token never recovers; forget it so the panel asks again.
        yield* ctx.storage.remove(KEYS.token);
        yield* ctx.storage.remove(KEYS.account);
        return yield* fail("Tokscale rejected the token. Sign in again.");
      }
      return yield* fail(
        Option.match(error, {
          onNone: () => `Tokscale answered HTTP ${response.status}.`,
          onSome: (body) =>
            [`Tokscale refused the data: ${body.error}`, ...(body.details ?? [])].join(" "),
        }),
      );
    }).pipe(
      Effect.timeout("30 seconds"),
      Effect.mapError((cause) =>
        isPluginError(cause)
          ? cause
          : new PluginError({ message: "Could not reach Tokscale.", cause }),
      ),
    );

  /** Everything a publish would send, computed without sending anything. */
  const collect = Effect.gen(function* () {
    const config = yield* readConfig;
    const timeZone = zoneOf(config);
    const now = yield* Clock.currentTimeMillis;
    const window = publishWindow(localDay(now, timeZone));
    const rows = yield* ctx.usage.dailyTotals({ ...window, timeZone });
    const { days, skipped } = aggregate(rows);
    const ledger = Option.getOrNull(yield* readJson(KEYS.ledger, StoredLedger));
    const target = ledgerTarget(config.apiUrl, deviceId);
    const pending = pendingDays(days, ledger, target);
    const submission = buildSubmission({
      days: pending,
      device,
      generatedAt: new Date(now).toISOString(),
    });
    return { config, timeZone, now, window, days, skipped, ledger, target, pending, submission };
  });

  const preview = collect.pipe(
    Effect.map(
      (collected): TokscalePreview => ({
        endpoint: `${collected.config.apiUrl}/api/submit`,
        device,
        timeZone: collected.timeZone,
        days: collected.days.map((day) => ({
          date: day.date,
          published: !collected.pending.some((pending) => pending.date === day.date),
          models: day.models.map((model) => ({
            client: model.client,
            model: model.model,
            ...model.tokens,
            cost: model.cost,
            messages: model.messages,
          })),
        })),
        skipped: collected.skipped,
        body: collected.submission === null ? null : JSON.stringify(collected.submission, null, 2),
      }),
    ),
  );

  const recordRun = (run: Omit<LastRun, "at">, now: number, succeeded: boolean) =>
    readRuns.pipe(
      Effect.flatMap((runs) =>
        writeJson(KEYS.runs, StoredRuns, {
          lastRun: { ...run, at: new Date(now).toISOString() },
          lastSuccessAt: succeeded ? now : runs.lastSuccessAt,
          lastAttemptAt: now,
        }),
      ),
    );

  const publishUnlocked = Effect.gen(function* () {
    const token = yield* readToken;
    if (Option.isNone(token)) return yield* fail("Sign in to Tokscale first.");
    const collected = yield* collect;
    if (collected.submission === null) {
      yield* recordRun({ ok: true, sentDays: 0, message: "Up to date." }, collected.now, true);
      return;
    }
    const response = yield* post(
      `${collected.config.apiUrl}/api/submit`,
      collected.submission,
      SubmitResponse,
      token.value,
    );
    yield* writeJson(
      KEYS.ledger,
      StoredLedger,
      recordPublished(
        collected.ledger,
        collected.target,
        collected.pending,
        collected.window.sinceDay,
      ),
    );
    if (response.username !== undefined) yield* ctx.storage.set(KEYS.account, response.username);
    const sent = collected.pending.length;
    yield* recordRun(
      { ok: true, sentDays: sent, message: `Published ${sent} day${sent === 1 ? "" : "s"}.` },
      collected.now,
      true,
    );
  });

  const publish = publishLock.withPermits(1)(publishUnlocked).pipe(
    Effect.andThen(setState({ error: null })),
    Effect.tapError((error) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          recordRun({ ok: false, sentDays: 0, message: error.message }, now, false),
        ),
        Effect.andThen(setState({ error: error.message })),
        Effect.ignore,
      ),
    ),
  );

  const scheduledTick = Effect.gen(function* () {
    const config = yield* readConfig;
    if (!config.autoPublish || Option.isNone(yield* readToken)) return;
    const runs = yield* readRuns;
    const now = yield* Clock.currentTimeMillis;
    if (isDue({ schedule: config.schedule, now, ...runs })) yield* publish;
  });

  yield* scheduledTick.pipe(
    Effect.catchCause((cause) => Effect.logWarning("Tokscale publish failed", { cause })),
    Effect.repeat(Schedule.spaced("15 minutes")),
    Effect.delay("1 minute"),
    Effect.forkIn(pluginScope),
  );

  const cancelSignIn = Effect.gen(function* () {
    const fiber = signInFiber;
    signInFiber = null;
    if (fiber !== null) yield* Fiber.interrupt(fiber);
    yield* Ref.update(state, (current) => ({ ...current, pendingSignIn: null }));
  });

  /** Tokscale's own device flow: POST /api/auth/device, then poll until approved. */
  const pollSignIn = (apiUrl: string, deviceCode: string, intervalSeconds: number) =>
    Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(`${Math.max(intervalSeconds, 2)} seconds`);
        const result = yield* post(`${apiUrl}/api/auth/device/poll`, { deviceCode }, PollResponse).pipe(
          Effect.option,
        );
        if (Option.isNone(result) || result.value.status === "pending") continue;
        if (result.value.status === "complete" && result.value.token !== undefined) {
          yield* ctx.storage.set(KEYS.token, result.value.token);
          if (result.value.user !== undefined) {
            yield* ctx.storage.set(KEYS.account, result.value.user.username);
          }
          return;
        }
        return yield* fail("The Tokscale sign-in code expired.");
      }
    });

  const signIn = Effect.gen(function* () {
    if ((yield* Ref.get(state)).pendingSignIn !== null) return;
    const { apiUrl } = yield* readConfig;
    const code = yield* post(
      `${apiUrl}/api/auth/device`,
      { deviceName: DEVICE_NAME },
      DeviceCodeResponse,
    );
    yield* setState({
      pendingSignIn: { verificationUrl: code.verificationUrl, userCode: code.userCode },
      error: null,
    });
    signInFiber = yield* pollSignIn(apiUrl, code.deviceCode, code.interval).pipe(
      Effect.timeout(`${code.expiresIn} seconds`),
      Effect.andThen(setState({ pendingSignIn: null })),
      Effect.catch((error) =>
        setState({
          pendingSignIn: null,
          error: isPluginError(error) ? error.message : "The Tokscale sign-in code expired.",
        }),
      ),
      Effect.ensuring(Effect.sync(() => (signInFiber = null))),
      Effect.forkIn(pluginScope),
    );
  });

  const setToken = (raw: string) =>
    Effect.gen(function* () {
      const token = raw.trim();
      if (!/^tt_[A-Za-z0-9]+$/.test(token)) {
        return yield* fail("A Tokscale API token starts with tt_.");
      }
      yield* cancelSignIn;
      yield* ctx.storage.set(KEYS.token, token);
      yield* ctx.storage.remove(KEYS.account);
      yield* setState({ error: null });
    });

  const signOut = Effect.gen(function* () {
    yield* cancelSignIn;
    yield* ctx.storage.remove(KEYS.token);
    yield* ctx.storage.remove(KEYS.account);
    const config = yield* readConfig;
    yield* writeJson(KEYS.config, TokscaleConfig, { ...config, autoPublish: false });
    yield* setState({ error: null });
  });

  const setConfig = (patch: TokscaleConfigPatch) =>
    Effect.gen(function* () {
      const current = yield* readConfig;
      const apiUrl =
        patch.apiUrl === undefined ? current.apiUrl : normalizeApiUrl(patch.apiUrl);
      if (apiUrl === null) return yield* fail("The Tokscale URL must be an HTTPS origin.");
      const timeZone = patch.timeZone === undefined ? current.timeZone : patch.timeZone;
      if (timeZone !== null && !isTimeZone(timeZone)) {
        return yield* fail(`${timeZone} is not a time zone.`);
      }
      if (apiUrl !== current.apiUrl) {
        // A token belongs to the service that issued it; never hand it to another host.
        yield* signOut;
        yield* writeJson(KEYS.config, TokscaleConfig, {
          ...current,
          autoPublish: false,
          apiUrl,
          timeZone,
        });
        return;
      }
      if (patch.autoPublish === true && Option.isNone(yield* readToken)) {
        return yield* fail("Sign in to Tokscale first.");
      }
      yield* writeJson(KEYS.config, TokscaleConfig, { ...current, ...patch, apiUrl, timeZone });
      yield* publishStatus;
    });

  yield* publishStatus;

  const thenStatus = <E>(effect: Effect.Effect<unknown, E>) =>
    effect.pipe(Effect.andThen(status));

  return {
    actions: {
      status: () => status,
      signIn: () => thenStatus(signIn),
      setToken: (input: { readonly token: string }) => thenStatus(setToken(input.token)),
      signOut: () => thenStatus(signOut),
      setConfig: (patch: TokscaleConfigPatch) => thenStatus(setConfig(patch)),
      preview: () => preview,
      publishNow: () => thenStatus(publish),
    },
  };
});
