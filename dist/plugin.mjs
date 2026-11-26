// src/index.ts
import { definePlugin } from "@t3tools/plugin-api";
import * as Effect3 from "effect/Effect";

// src/actions.ts
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// src/tokscale.ts
import { createHash } from "node:crypto";
var TOKSCALE_API_URL = "https://tokscale.ai";
var TOKSCALE_HOST = "tokscale.ai";
var DEVICE_NAME = "p0code";
var CLIENT_VERSION = "p0code-plugin/0.1.0";
var CLIENTS = {
  claude: "claude",
  codex: "codex",
  grok: "grok",
  cursor: "cursor",
  opencode: "opencode",
  antigravity: "antigravity",
  pi: "pi"
};
function tokscaleClient(provider) {
  return Object.hasOwn(CLIENTS, provider) ? CLIENTS[provider] ?? null : null;
}
function tokenTotal(tokens) {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite + tokens.reasoning;
}
function deviceIdFor(environmentId) {
  return `p0code-${createHash("sha256").update(environmentId).digest("hex").slice(0, 32)}`;
}
function normalizeApiUrl(value) {
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return url.protocol === "https:" || url.protocol === "http:" && local ? url.origin : null;
}

// src/actions.ts
var TOKSCALE_PLUGIN_ID = "tokscale-auto-publish";
var PublishSchedule = Schema.Literals(["hourly", "daily"]);
var TokscaleConfig = Schema.Struct({
  /** Off until the person has seen the preview and turned it on. */
  autoPublish: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  schedule: PublishSchedule.pipe(Schema.withDecodingDefault(Effect.succeed("daily"))),
  /** IANA zone days are counted in; null follows the server's zone. */
  timeZone: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** For a self-hosted Tokscale. */
  apiUrl: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(TOKSCALE_API_URL)))
});
var TokscaleConfigPatch = Schema.Struct({
  autoPublish: Schema.optionalKey(Schema.Boolean),
  schedule: Schema.optionalKey(PublishSchedule),
  timeZone: Schema.optionalKey(Schema.NullOr(Schema.String)),
  apiUrl: Schema.optionalKey(Schema.String)
});
var LastRun = Schema.Struct({
  at: Schema.String,
  ok: Schema.Boolean,
  /** Days sent; 0 when nothing had changed. */
  sentDays: Schema.Number,
  message: Schema.NullOr(Schema.String)
});
var TokscaleStatus = Schema.Struct({
  signedIn: Schema.Boolean,
  account: Schema.NullOr(Schema.String),
  pendingSignIn: Schema.NullOr(
    Schema.Struct({ verificationUrl: Schema.String, userCode: Schema.String })
  ),
  config: TokscaleConfig,
  /** The zone `config.timeZone` resolves to. */
  timeZone: Schema.String,
  lastRun: Schema.NullOr(LastRun),
  /** The opaque id Tokscale files this machine's numbers under. */
  deviceId: Schema.String,
  error: Schema.NullOr(Schema.String)
});
var PreviewModel = Schema.Struct({
  client: Schema.String,
  model: Schema.String,
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  reasoning: Schema.Number,
  cost: Schema.Number,
  messages: Schema.Number
});
var PreviewDay = Schema.Struct({
  date: Schema.String,
  /** Already published with these exact numbers, so it will not be sent again. */
  published: Schema.Boolean,
  models: Schema.Array(PreviewModel)
});
var TokscalePreview = Schema.Struct({
  endpoint: Schema.String,
  device: Schema.Struct({ id: Schema.String, name: Schema.String }),
  timeZone: Schema.String,
  days: Schema.Array(PreviewDay),
  skipped: Schema.Array(
    Schema.Struct({
      provider: Schema.String,
      model: Schema.String,
      reason: Schema.Literals(["unsupported-provider", "no-tokens"])
    })
  ),
  /** The exact JSON body the next publish would POST, or null when nothing changed. */
  body: Schema.NullOr(Schema.String)
});
var NoInput = Schema.Struct({});
var tokscaleActions = {
  status: { input: NoInput, output: TokscaleStatus },
  /** Starts Tokscale's device sign-in; approve the code at the returned URL. */
  signIn: { input: NoInput, output: TokscaleStatus },
  /** Uses an API token made at tokscale.ai/settings instead of signing in. */
  setToken: { input: Schema.Struct({ token: Schema.String }), output: TokscaleStatus },
  /** Forgets the token and cancels a pending sign-in. */
  signOut: { input: NoInput, output: TokscaleStatus },
  setConfig: { input: TokscaleConfigPatch, output: TokscaleStatus },
  preview: { input: NoInput, output: TokscalePreview },
  publishNow: { input: NoInput, output: TokscaleStatus }
};

// src/publisher.ts
import { PluginContext, PluginError } from "@t3tools/plugin-api";
import * as Clock from "effect/Clock";
import * as Effect2 from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema2 from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

// src/aggregate.ts
var roundCost = (usd) => Math.round(usd * 1e6) / 1e6;
var ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
function addTokens(a, b) {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning
  };
}
function toTokens(row) {
  const output = Math.max(0, row.outputTokens);
  const reasoning = Math.min(Math.max(0, row.reasoningTokens), output);
  return {
    input: Math.max(0, row.uncachedInputTokens),
    output: output - reasoning,
    cacheRead: Math.max(0, row.cachedInputTokens),
    cacheWrite: Math.max(0, row.cacheCreationTokens),
    reasoning
  };
}
function aggregate(rows) {
  const byKey = /* @__PURE__ */ new Map();
  const skipped = /* @__PURE__ */ new Map();
  const skip = (provider, model, reason) => skipped.set(`${reason}\0${provider}\0${model}`, { provider, model, reason });
  for (const row of rows) {
    const client = tokscaleClient(row.provider);
    if (client === null) {
      skip(row.provider, row.model, "unsupported-provider");
      continue;
    }
    const key = `${row.day}\0${client}\0${row.model}`;
    const current = byKey.get(key) ?? {
      date: row.day,
      client,
      model: row.model,
      tokens: ZERO,
      cost: 0,
      messages: 0,
      costIncomplete: false
    };
    byKey.set(key, {
      ...current,
      tokens: addTokens(current.tokens, toTokens(row)),
      cost: current.cost + Math.max(0, row.costUsd),
      messages: current.messages + Math.max(0, row.records),
      costIncomplete: current.costIncomplete || row.unpricedRecords > 0
    });
  }
  const days = /* @__PURE__ */ new Map();
  for (const { date, ...model } of byKey.values()) {
    if (tokenTotal(model.tokens) === 0) {
      skip(model.client, model.model, "no-tokens");
      continue;
    }
    const list = days.get(date) ?? [];
    list.push({ ...model, cost: roundCost(model.cost) });
    days.set(date, list);
  }
  return {
    days: [...days.entries()].map(([date, models]) => ({
      date,
      models: models.toSorted(
        (a, b) => a.client.localeCompare(b.client) || a.model.localeCompare(b.model)
      )
    })).toSorted((a, b) => a.date.localeCompare(b.date)),
    skipped: [...skipped.values()]
  };
}

// src/ledger.ts
import { createHash as createHash2 } from "node:crypto";
var ledgerTarget = (apiUrl, deviceId) => `${apiUrl}#${deviceId}`;
function fingerprintDay(day) {
  return createHash2("sha256").update(JSON.stringify(day)).digest("hex");
}
function pendingDays(days, ledger, target) {
  const published = ledger?.target === target ? ledger.days : {};
  return days.filter((day) => published[day.date] !== fingerprintDay(day));
}
function recordPublished(ledger, target, days, keepSince) {
  const next = {};
  for (const [date, fingerprint] of Object.entries(ledger?.target === target ? ledger.days : {})) {
    if (date >= keepSince) next[date] = fingerprint;
  }
  for (const day of days) {
    if (day.date >= keepSince) next[day.date] = fingerprintDay(day);
  }
  return { target, days: next };
}

// src/payload.ts
var ZERO2 = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
function intensity(cost, maxCost) {
  if (cost <= 0 || maxCost <= 0) return 0;
  const ratio = cost / maxCost;
  return ratio >= 0.75 ? 4 : ratio >= 0.5 ? 3 : ratio >= 0.25 ? 2 : 1;
}
function contribution(day) {
  const tokenBreakdown = day.models.reduce((sum, model) => addTokens(sum, model.tokens), ZERO2);
  const incomplete = day.models.some((model) => model.costIncomplete);
  return {
    date: day.date,
    totals: {
      tokens: tokenTotal(tokenBreakdown),
      cost: roundCost(day.models.reduce((sum, model) => sum + model.cost, 0)),
      messages: day.models.reduce((sum, model) => sum + model.messages, 0),
      ...incomplete ? { costIsComplete: false } : {}
    },
    tokenBreakdown,
    clients: day.models.map((model) => ({
      client: model.client,
      modelId: model.model,
      tokens: model.tokens,
      cost: model.cost,
      messages: model.messages
    }))
  };
}
function buildSubmission(input) {
  const days = input.days.toSorted((a, b) => a.date.localeCompare(b.date));
  const first = days[0];
  const last = days.at(-1);
  if (first === void 0 || last === void 0) return null;
  const partial = days.map(contribution);
  const maxCost = Math.max(...partial.map((day) => day.totals.cost));
  const contributions = partial.map((day) => ({
    ...day,
    intensity: intensity(day.totals.cost, maxCost)
  }));
  const totalTokens = contributions.reduce((sum, day) => sum + day.totals.tokens, 0);
  const totalCost = roundCost(contributions.reduce((sum, day) => sum + day.totals.cost, 0));
  const years = /* @__PURE__ */ new Map();
  for (const day of contributions) {
    const year = day.date.slice(0, 4);
    years.set(year, [...years.get(year) ?? [], day]);
  }
  return {
    meta: {
      generatedAt: input.generatedAt,
      version: CLIENT_VERSION,
      dateRange: { start: first.date, end: last.date }
    },
    device: { id: input.device.id, name: input.device.name },
    summary: {
      totalTokens,
      totalCost,
      totalDays: contributions.length,
      activeDays: contributions.length,
      averagePerDay: roundCost(totalCost / contributions.length),
      maxCostInSingleDay: maxCost,
      clients: [...new Set(days.flatMap((day) => day.models.map((m) => m.client)))].toSorted(),
      models: [...new Set(days.flatMap((day) => day.models.map((m) => m.model)))].toSorted()
    },
    years: [...years.entries()].map(([year, yearDays]) => ({
      year,
      totalTokens: yearDays.reduce((sum, day) => sum + day.totals.tokens, 0),
      totalCost: roundCost(yearDays.reduce((sum, day) => sum + day.totals.cost, 0)),
      range: { start: yearDays[0]?.date ?? year, end: yearDays.at(-1)?.date ?? year }
    })),
    contributions
  };
}

// src/schedule.ts
var LOOKBACK_DAYS = 30;
var RETRY_AFTER_MS = 30 * 6e4;
var INTERVAL_MS = {
  hourly: 60 * 6e4,
  daily: 24 * 60 * 6e4
};
function isDue(input) {
  const { now, lastSuccessAt, lastAttemptAt } = input;
  if (lastAttemptAt !== null && now - lastAttemptAt < RETRY_AFTER_MS) return false;
  return lastSuccessAt === null || now - lastSuccessAt >= INTERVAL_MS[input.schedule];
}
function localDay(now, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
}
function addDays(day, days) {
  const date = /* @__PURE__ */ new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function publishWindow(today) {
  return { sinceDay: addDays(today, -(LOOKBACK_DAYS - 1)), untilDay: today };
}
function isTimeZone(value) {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// src/publisher.ts
var KEYS = {
  token: "token",
  account: "account",
  config: "config",
  ledger: "ledger",
  runs: "runs"
};
var DEFAULT_CONFIG = {
  autoPublish: false,
  schedule: "daily",
  timeZone: null,
  apiUrl: TOKSCALE_API_URL
};
var StoredLedger = Schema2.Struct({
  target: Schema2.String,
  days: Schema2.Record(Schema2.String, Schema2.String)
});
var StoredRuns = Schema2.Struct({
  lastRun: Schema2.NullOr(LastRun),
  lastSuccessAt: Schema2.NullOr(Schema2.Number),
  lastAttemptAt: Schema2.NullOr(Schema2.Number)
});
var DeviceCodeResponse = Schema2.Struct({
  deviceCode: Schema2.String,
  userCode: Schema2.String,
  verificationUrl: Schema2.String,
  expiresIn: Schema2.Number,
  interval: Schema2.Number
});
var PollResponse = Schema2.Struct({
  status: Schema2.String,
  token: Schema2.optionalKey(Schema2.String),
  user: Schema2.optionalKey(Schema2.Struct({ username: Schema2.String }))
});
var SubmitResponse = Schema2.Struct({
  username: Schema2.optionalKey(Schema2.String),
  warnings: Schema2.optionalKey(Schema2.Array(Schema2.String))
});
var ErrorBody = Schema2.Struct({
  error: Schema2.String,
  details: Schema2.optionalKey(Schema2.Array(Schema2.String))
});
var isPluginError = Schema2.is(PluginError);
var fail2 = (message) => Effect2.fail(new PluginError({ message }));
var serverTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
var makePublisher = Effect2.fn("tokscale.make")(function* () {
  const ctx = yield* PluginContext;
  const http = yield* HttpClient.HttpClient;
  const pluginScope = yield* Effect2.scope;
  const publishLock = yield* Semaphore.make(1);
  const state = yield* Ref.make({ pendingSignIn: null, error: null });
  const deviceId = deviceIdFor(yield* ctx.environment.environmentId);
  const device = { id: deviceId, name: DEVICE_NAME };
  let signInFiber = null;
  const readKey = (key) => Effect2.suspend(() => ctx.storage.get(key));
  const readJson = (key, schema) => readKey(key).pipe(Effect2.map(Option.flatMap(Schema2.decodeUnknownOption(Schema2.fromJsonString(schema)))));
  const writeJson = (key, schema, value) => Schema2.encodeEffect(Schema2.fromJsonString(schema))(value).pipe(
    Effect2.mapError((cause) => new PluginError({ message: "Could not save Tokscale state.", cause })),
    Effect2.flatMap((json) => ctx.storage.set(key, json))
  );
  const readConfig = readJson(KEYS.config, TokscaleConfig).pipe(
    Effect2.map(Option.getOrElse(() => DEFAULT_CONFIG))
  );
  const readToken = readKey(KEYS.token);
  const readRuns = readJson(KEYS.runs, StoredRuns).pipe(
    Effect2.map(
      Option.getOrElse(
        () => ({ lastRun: null, lastSuccessAt: null, lastAttemptAt: null })
      )
    )
  );
  const zoneOf = (config) => config.timeZone ?? serverTimeZone();
  const status = Effect2.gen(function* () {
    const [config, token, account, runs, runtime] = yield* Effect2.all([
      readConfig,
      readToken,
      readKey(KEYS.account),
      readRuns,
      Ref.get(state)
    ]);
    return {
      signedIn: Option.isSome(token),
      account: Option.getOrNull(account),
      pendingSignIn: runtime.pendingSignIn,
      config,
      timeZone: zoneOf(config),
      lastRun: runs.lastRun,
      deviceId,
      error: runtime.error
    };
  });
  const publishStatus = status.pipe(
    Effect2.flatMap(
      (current) => ctx.reportStatus(
        current.error ?? (current.pendingSignIn !== null ? "Waiting for Tokscale sign-in." : !current.signedIn ? "Not signed in to Tokscale." : !current.config.autoPublish ? "Auto-publish is off." : current.lastRun?.message ?? `Publishing ${current.config.schedule}.`)
      )
    ),
    Effect2.ignore
  );
  const setState = (update2) => Ref.update(state, (current) => ({ ...current, ...update2 })).pipe(Effect2.andThen(publishStatus));
  const post2 = (url, body, schema, token) => Effect2.gen(function* () {
    const base = HttpClientRequest.post(url);
    const request = yield* HttpClientRequest.bodyJson(
      token === void 0 ? base : base.pipe(HttpClientRequest.bearerToken(token)),
      body
    );
    const response = yield* http.execute(request);
    if (response.status >= 200 && response.status < 300) {
      return yield* HttpClientResponse.schemaBodyJson(schema)(response);
    }
    const error = yield* HttpClientResponse.schemaBodyJson(ErrorBody)(response).pipe(
      Effect2.option
    );
    if (response.status === 401) {
      yield* ctx.storage.remove(KEYS.token);
      yield* ctx.storage.remove(KEYS.account);
      return yield* fail2("Tokscale rejected the token. Sign in again.");
    }
    return yield* fail2(
      Option.match(error, {
        onNone: () => `Tokscale answered HTTP ${response.status}.`,
        onSome: (body2) => [`Tokscale refused the data: ${body2.error}`, ...body2.details ?? []].join(" ")
      })
    );
  }).pipe(
    Effect2.timeout("30 seconds"),
    Effect2.mapError(
      (cause) => isPluginError(cause) ? cause : new PluginError({ message: "Could not reach Tokscale.", cause })
    )
  );
  const collect = Effect2.gen(function* () {
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
      generatedAt: new Date(now).toISOString()
    });
    return { config, timeZone, now, window, days, skipped, ledger, target, pending, submission };
  });
  const preview = collect.pipe(
    Effect2.map(
      (collected) => ({
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
            messages: model.messages
          }))
        })),
        skipped: collected.skipped,
        body: collected.submission === null ? null : JSON.stringify(collected.submission, null, 2)
      })
    )
  );
  const recordRun = (run, now, succeeded) => readRuns.pipe(
    Effect2.flatMap(
      (runs) => writeJson(KEYS.runs, StoredRuns, {
        lastRun: { ...run, at: new Date(now).toISOString() },
        lastSuccessAt: succeeded ? now : runs.lastSuccessAt,
        lastAttemptAt: now
      })
    )
  );
  const publishUnlocked = Effect2.gen(function* () {
    const token = yield* readToken;
    if (Option.isNone(token)) return yield* fail2("Sign in to Tokscale first.");
    const collected = yield* collect;
    if (collected.submission === null) {
      yield* recordRun({ ok: true, sentDays: 0, message: "Up to date." }, collected.now, true);
      return;
    }
    const response = yield* post2(
      `${collected.config.apiUrl}/api/submit`,
      collected.submission,
      SubmitResponse,
      token.value
    );
    yield* writeJson(
      KEYS.ledger,
      StoredLedger,
      recordPublished(
        collected.ledger,
        collected.target,
        collected.pending,
        collected.window.sinceDay
      )
    );
    if (response.username !== void 0) yield* ctx.storage.set(KEYS.account, response.username);
    const sent = collected.pending.length;
    yield* recordRun(
      { ok: true, sentDays: sent, message: `Published ${sent} day${sent === 1 ? "" : "s"}.` },
      collected.now,
      true
    );
  });
  const publish = publishLock.withPermits(1)(publishUnlocked).pipe(
    Effect2.andThen(setState({ error: null })),
    Effect2.tapError(
      (error) => Clock.currentTimeMillis.pipe(
        Effect2.flatMap(
          (now) => recordRun({ ok: false, sentDays: 0, message: error.message }, now, false)
        ),
        Effect2.andThen(setState({ error: error.message })),
        Effect2.ignore
      )
    )
  );
  const scheduledTick = Effect2.gen(function* () {
    const config = yield* readConfig;
    if (!config.autoPublish || Option.isNone(yield* readToken)) return;
    const runs = yield* readRuns;
    const now = yield* Clock.currentTimeMillis;
    if (isDue({ schedule: config.schedule, now, ...runs })) yield* publish;
  });
  yield* scheduledTick.pipe(
    Effect2.catchCause((cause) => Effect2.logWarning("Tokscale publish failed", { cause })),
    Effect2.repeat(Schedule.spaced("15 minutes")),
    Effect2.delay("1 minute"),
    Effect2.forkIn(pluginScope)
  );
  const cancelSignIn = Effect2.gen(function* () {
    const fiber = signInFiber;
    signInFiber = null;
    if (fiber !== null) yield* Fiber.interrupt(fiber);
    yield* Ref.update(state, (current) => ({ ...current, pendingSignIn: null }));
  });
  const pollSignIn = (apiUrl, deviceCode, intervalSeconds) => Effect2.gen(function* () {
    while (true) {
      yield* Effect2.sleep(`${Math.max(intervalSeconds, 2)} seconds`);
      const result = yield* post2(`${apiUrl}/api/auth/device/poll`, { deviceCode }, PollResponse).pipe(
        Effect2.option
      );
      if (Option.isNone(result) || result.value.status === "pending") continue;
      if (result.value.status === "complete" && result.value.token !== void 0) {
        yield* ctx.storage.set(KEYS.token, result.value.token);
        if (result.value.user !== void 0) {
          yield* ctx.storage.set(KEYS.account, result.value.user.username);
        }
        return;
      }
      return yield* fail2("The Tokscale sign-in code expired.");
    }
  });
  const signIn = Effect2.gen(function* () {
    if ((yield* Ref.get(state)).pendingSignIn !== null) return;
    const { apiUrl } = yield* readConfig;
    const code = yield* post2(
      `${apiUrl}/api/auth/device`,
      { deviceName: DEVICE_NAME },
      DeviceCodeResponse
    );
    yield* setState({
      pendingSignIn: { verificationUrl: code.verificationUrl, userCode: code.userCode },
      error: null
    });
    signInFiber = yield* pollSignIn(apiUrl, code.deviceCode, code.interval).pipe(
      Effect2.timeout(`${code.expiresIn} seconds`),
      Effect2.andThen(setState({ pendingSignIn: null })),
      Effect2.catch(
        (error) => setState({
          pendingSignIn: null,
          error: isPluginError(error) ? error.message : "The Tokscale sign-in code expired."
        })
      ),
      Effect2.ensuring(Effect2.sync(() => signInFiber = null)),
      Effect2.forkIn(pluginScope)
    );
  });
  const setToken = (raw) => Effect2.gen(function* () {
    const token = raw.trim();
    if (!/^tt_[A-Za-z0-9]+$/.test(token)) {
      return yield* fail2("A Tokscale API token starts with tt_.");
    }
    yield* cancelSignIn;
    yield* ctx.storage.set(KEYS.token, token);
    yield* ctx.storage.remove(KEYS.account);
    yield* setState({ error: null });
  });
  const signOut = Effect2.gen(function* () {
    yield* cancelSignIn;
    yield* ctx.storage.remove(KEYS.token);
    yield* ctx.storage.remove(KEYS.account);
    const config = yield* readConfig;
    yield* writeJson(KEYS.config, TokscaleConfig, { ...config, autoPublish: false });
    yield* setState({ error: null });
  });
  const setConfig = (patch) => Effect2.gen(function* () {
    const current = yield* readConfig;
    const apiUrl = patch.apiUrl === void 0 ? current.apiUrl : normalizeApiUrl(patch.apiUrl);
    if (apiUrl === null) return yield* fail2("The Tokscale URL must be an HTTPS origin.");
    const timeZone = patch.timeZone === void 0 ? current.timeZone : patch.timeZone;
    if (timeZone !== null && !isTimeZone(timeZone)) {
      return yield* fail2(`${timeZone} is not a time zone.`);
    }
    if (apiUrl !== current.apiUrl) {
      yield* signOut;
      yield* writeJson(KEYS.config, TokscaleConfig, {
        ...current,
        autoPublish: false,
        apiUrl,
        timeZone
      });
      return;
    }
    if (patch.autoPublish === true && Option.isNone(yield* readToken)) {
      return yield* fail2("Sign in to Tokscale first.");
    }
    yield* writeJson(KEYS.config, TokscaleConfig, { ...current, ...patch, apiUrl, timeZone });
    yield* publishStatus;
  });
  yield* publishStatus;
  const thenStatus = (effect) => effect.pipe(Effect2.andThen(status));
  return {
    actions: {
      status: () => status,
      signIn: () => thenStatus(signIn),
      setToken: (input) => thenStatus(setToken(input.token)),
      signOut: () => thenStatus(signOut),
      setConfig: (patch) => thenStatus(setConfig(patch)),
      preview: () => preview,
      publishNow: () => thenStatus(publish)
    }
  };
});

// src/index.ts
var tokscaleAutoPublish = definePlugin({
  manifest: {
    id: TOKSCALE_PLUGIN_ID,
    name: "Tokscale auto-publish",
    description: "Publishes your daily token and cost totals per model to the Tokscale leaderboard. Prompts, code, thread titles, project names and file paths are never sent.",
    version: "0.1.0",
    unofficial: true,
    externalServices: [TOKSCALE_HOST],
    capabilities: ["network:outbound", "usage:read"],
    httpRoutes: []
  },
  actions: tokscaleActions,
  start: makePublisher().pipe(Effect3.map(({ actions }) => ({ actions })))
});
var index_default = tokscaleAutoPublish;
export {
  index_default as default,
  tokscaleAutoPublish
};
