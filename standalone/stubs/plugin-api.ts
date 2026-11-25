/**
 * Test-only stand-in for @t3tools/plugin-api, trimmed to what this plugin uses, plus the
 * `usage` host API from docs/HOST_API.md. `definePlugin` is copied from p0code. Not shipped.
 */
import type { EnvironmentId, PluginManifest } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import type { UsageDailyTotal, UsageDailyTotalsInput } from "../../src/usage.ts";

export class PluginError extends Schema.TaggedError<PluginError>()("PluginError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class PluginContext extends Context.Service<
  PluginContext,
  {
    readonly pluginId: string;
    readonly dataDir: string;
    readonly storage: {
      readonly get: (key: string) => Effect.Effect<Option.Option<string>, PluginError>;
      readonly set: (key: string, value: string) => Effect.Effect<void, PluginError>;
      readonly remove: (key: string) => Effect.Effect<void, PluginError>;
    };
    readonly reportStatus: (message: string | null) => Effect.Effect<void>;
    readonly environment: {
      readonly environmentId: Effect.Effect<EnvironmentId>;
    };
    /** Proposed in docs/HOST_API.md. Requires the `usage:read` capability. */
    readonly usage: {
      readonly dailyTotals: (
        input: UsageDailyTotalsInput,
      ) => Effect.Effect<ReadonlyArray<UsageDailyTotal>, PluginError>;
    };
  }
>()("@t3tools/plugin-api/PluginContext") {}

export type PluginServices = PluginContext | HttpClient.HttpClient;

export interface PluginActionSchema {
  readonly input: Schema.Codec<unknown, unknown>;
  readonly output: Schema.Codec<unknown, unknown>;
}
export type PluginActionSchemas = Readonly<Record<string, PluginActionSchema>>;

export interface PluginInstance<Actions extends PluginActionSchemas> {
  readonly actions: {
    readonly [K in keyof Actions]: (
      input: Actions[K]["input"]["Type"],
    ) => Effect.Effect<Actions[K]["output"]["Type"], PluginError>;
  };
}

export interface StartedPlugin {
  readonly invoke: (action: string, input: unknown) => Effect.Effect<unknown, PluginError>;
}

export interface Plugin {
  readonly manifest: PluginManifest;
  readonly start: Effect.Effect<StartedPlugin, PluginError, PluginServices | Scope.Scope>;
}

export function definePlugin<Actions extends PluginActionSchemas>(definition: {
  readonly manifest: PluginManifest;
  readonly actions: Actions;
  readonly start: Effect.Effect<PluginInstance<Actions>, PluginError, PluginServices | Scope.Scope>;
}): Plugin {
  const codecs = new Map(
    Object.entries(definition.actions).map(([action, schema]) => [
      action,
      {
        decode: Schema.decodeUnknownEffect(schema.input),
        encode: Schema.encodeEffect(schema.output),
      },
    ]),
  );
  return {
    manifest: definition.manifest,
    start: definition.start.pipe(
      Effect.map((instance) => ({
        invoke: (action: string, input: unknown) => {
          const codec = codecs.get(action);
          const handler = Object.hasOwn(instance.actions, action)
            ? instance.actions[action]
            : undefined;
          if (codec === undefined || handler === undefined) {
            return Effect.fail(new PluginError({ message: `Unknown action ${action}.` }));
          }
          return codec.decode(input).pipe(
            Effect.mapError((cause) => new PluginError({ message: "Invalid action input.", cause })),
            Effect.flatMap(handler),
            Effect.flatMap((output) =>
              codec
                .encode(output)
                .pipe(
                  Effect.mapError(
                    (cause) => new PluginError({ message: "Invalid action output.", cause }),
                  ),
                ),
            ),
          );
        },
      })),
    ),
  };
}
