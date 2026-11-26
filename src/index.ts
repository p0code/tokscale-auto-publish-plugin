import { definePlugin } from "@t3tools/plugin-api";
import * as Effect from "effect/Effect";

import { TOKSCALE_PLUGIN_ID, tokscaleActions } from "./actions.ts";
import { makePublisher } from "./publisher.ts";
import { TOKSCALE_HOST } from "./tokscale.ts";

export const tokscaleAutoPublish = definePlugin({
  manifest: {
    id: TOKSCALE_PLUGIN_ID,
    name: "Tokscale auto-publish",
    description:
      "Publishes your daily token and cost totals per model to the Tokscale leaderboard. Prompts, code, thread titles, project names and file paths are never sent.",
    version: "0.1.1",
    apiVersion: 1,
    unofficial: true,
    externalServices: [TOKSCALE_HOST],
    capabilities: ["network:outbound", "usage:read"],
    httpRoutes: [],
  },
  actions: tokscaleActions,
  start: makePublisher().pipe(Effect.map(({ actions }) => ({ actions }))),
});

export default tokscaleAutoPublish;
