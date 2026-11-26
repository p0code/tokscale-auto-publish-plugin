/**
 * Test-only stand-in for the slice of @t3tools/contracts this plugin touches, as p0code would
 * look with docs/HOST_API.md applied (the `usage:read` capability). Not shipped.
 */
import * as Schema from "effect/Schema";

export const EnvironmentId = Schema.String.pipe(Schema.brand("EnvironmentId"));
export type EnvironmentId = typeof EnvironmentId.Type;

export const PluginCapability = Schema.Literals([
  "network:outbound",
  "process:spawn",
  "http:routes",
  "auth:issue-device-credentials",
  "orchestration:read-activity",
  "usage:read",
]);
export type PluginCapability = typeof PluginCapability.Type;

export const PluginManifest = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  version: Schema.String,
  unofficial: Schema.Boolean,
  externalServices: Schema.Array(Schema.String),
  capabilities: Schema.Array(PluginCapability),
  httpRoutes: Schema.Array(Schema.String),
  apiVersion: Schema.optionalKey(Schema.Int),
});
export type PluginManifest = typeof PluginManifest.Type;
