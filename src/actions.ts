import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TOKSCALE_API_URL } from "./tokscale.ts";

export const TOKSCALE_PLUGIN_ID = "tokscale-auto-publish";

export const PublishSchedule = Schema.Literals(["hourly", "daily"]);

export const TokscaleConfig = Schema.Struct({
  /** Off until the person has seen the preview and turned it on. */
  autoPublish: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  schedule: PublishSchedule.pipe(Schema.withDecodingDefault(Effect.succeed("daily" as const))),
  /** IANA zone days are counted in; null follows the server's zone. */
  timeZone: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** For a self-hosted Tokscale. */
  apiUrl: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(TOKSCALE_API_URL))),
});
export type TokscaleConfig = typeof TokscaleConfig.Type;

export const TokscaleConfigPatch = Schema.Struct({
  autoPublish: Schema.optionalKey(Schema.Boolean),
  schedule: Schema.optionalKey(PublishSchedule),
  timeZone: Schema.optionalKey(Schema.NullOr(Schema.String)),
  apiUrl: Schema.optionalKey(Schema.String),
});
export type TokscaleConfigPatch = typeof TokscaleConfigPatch.Type;

export const LastRun = Schema.Struct({
  at: Schema.String,
  ok: Schema.Boolean,
  /** Days sent; 0 when nothing had changed. */
  sentDays: Schema.Number,
  message: Schema.NullOr(Schema.String),
});
export type LastRun = typeof LastRun.Type;

/** The token itself never leaves the server; status only says whether there is one. */
export const TokscaleStatus = Schema.Struct({
  signedIn: Schema.Boolean,
  account: Schema.NullOr(Schema.String),
  pendingSignIn: Schema.NullOr(
    Schema.Struct({ verificationUrl: Schema.String, userCode: Schema.String }),
  ),
  config: TokscaleConfig,
  /** The zone `config.timeZone` resolves to. */
  timeZone: Schema.String,
  lastRun: Schema.NullOr(LastRun),
  /** The opaque id Tokscale files this machine's numbers under. */
  deviceId: Schema.String,
  error: Schema.NullOr(Schema.String),
});
export type TokscaleStatus = typeof TokscaleStatus.Type;

export const PreviewModel = Schema.Struct({
  client: Schema.String,
  model: Schema.String,
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  reasoning: Schema.Number,
  cost: Schema.Number,
  messages: Schema.Number,
});
export type PreviewModel = typeof PreviewModel.Type;

export const PreviewDay = Schema.Struct({
  date: Schema.String,
  /** Already published with these exact numbers, so it will not be sent again. */
  published: Schema.Boolean,
  models: Schema.Array(PreviewModel),
});
export type PreviewDay = typeof PreviewDay.Type;

/** A dry run: what the next publish would send, and nothing is sent. */
export const TokscalePreview = Schema.Struct({
  endpoint: Schema.String,
  device: Schema.Struct({ id: Schema.String, name: Schema.String }),
  timeZone: Schema.String,
  days: Schema.Array(PreviewDay),
  skipped: Schema.Array(
    Schema.Struct({
      provider: Schema.String,
      model: Schema.String,
      reason: Schema.Literals(["unsupported-provider", "no-tokens"]),
    }),
  ),
  /** The exact JSON body the next publish would POST, or null when nothing changed. */
  body: Schema.NullOr(Schema.String),
});
export type TokscalePreview = typeof TokscalePreview.Type;

const NoInput = Schema.Struct({});

/** The actions the settings panel calls through `plugins.invoke`. */
export const tokscaleActions = {
  status: { input: NoInput, output: TokscaleStatus },
  /** Starts Tokscale's device sign-in; approve the code at the returned URL. */
  signIn: { input: NoInput, output: TokscaleStatus },
  /** Uses an API token made at tokscale.ai/settings instead of signing in. */
  setToken: { input: Schema.Struct({ token: Schema.String }), output: TokscaleStatus },
  /** Forgets the token and cancels a pending sign-in. */
  signOut: { input: NoInput, output: TokscaleStatus },
  setConfig: { input: TokscaleConfigPatch, output: TokscaleStatus },
  preview: { input: NoInput, output: TokscalePreview },
  publishNow: { input: NoInput, output: TokscaleStatus },
} as const;
export type TokscaleAction = keyof typeof tokscaleActions;
