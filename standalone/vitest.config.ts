import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Tests import `vite-plus/test` like the rest of p0code; outside the workspace that is vitest.
export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  // The package tsconfig extends p0code's base, which only exists inside the workspace.
  tsconfig: local("tsconfig.json"),
  resolve: {
    alias: [
      { find: "vite-plus/test", replacement: fileURLToPath(import.meta.resolve("vitest")) },
      { find: "@t3tools/plugin-api", replacement: local("stubs/plugin-api.ts") },
      { find: "@t3tools/contracts", replacement: local("stubs/contracts.ts") },
      // Sources live outside this folder, so point them at the effect installed here.
      { find: /^effect\/(.*)$/, replacement: local("node_modules/effect/dist/$1.js") },
    ],
  },
  test: { include: ["src/**/*.test.ts"] },
});
