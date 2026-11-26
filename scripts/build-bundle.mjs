#!/usr/bin/env node
/**
 * Builds the p0code shop release bundle for @t3tools/plugin-tokscale-auto-publish:
 *   dist/plugin.mjs
 *   dist/manifest.json
 *   dist/tokscale-auto-publish-<version>.tgz  (root entries: manifest.json, plugin.mjs)
 *   dist/tokscale-auto-publish-<version>.tgz.sha256
 *   dist/SHA256SUMS.txt
 *
 * Host runtime packages (`effect`, `@t3tools/plugin-api`, `@t3tools/contracts`,
 * `@effect/platform-node*`) stay external because p0code's plugin installer symlinks
 * them into the installed plugin directory.
 *
 * Usage:
 *   node scripts/build-bundle.mjs
 *   P0CODE_REPO=/path/to/p0code node scripts/build-bundle.mjs
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import util from "node:util";

const PLUGIN_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OUT_DIR = path.join(PLUGIN_DIR, "dist");
const HOST_EXTERNALS = [
  "effect",
  "@t3tools/plugin-api",
  "@t3tools/contracts",
  "@effect/platform-node",
  "@effect/platform-node-shared",
];

function findEsbuild() {
  const candidates = [
    process.env.ESBUILD_PATH,
    path.join(PLUGIN_DIR, "node_modules/esbuild/lib/main.js"),
    path.join(PLUGIN_DIR, "../../node_modules/.pnpm/node_modules/esbuild/lib/main.js"),
    process.env.P0CODE_REPO
      ? path.join(process.env.P0CODE_REPO, "node_modules/.pnpm/node_modules/esbuild/lib/main.js")
      : undefined,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return createRequire(import.meta.url)(candidate);
    }
  }
  try {
    return createRequire(import.meta.url)("esbuild");
  } catch {
    throw new Error(
      "Could not locate esbuild. Run inside a p0code checkout or set P0CODE_REPO / ESBUILD_PATH.",
    );
  }
}

function findHostRoot() {
  const candidates = [
    process.env.P0CODE_REPO,
    path.resolve(PLUGIN_DIR, "../.."),
  ].filter(Boolean);
  for (const root of candidates) {
    if (existsSync(path.join(root, "packages/plugin-api/package.json"))) {
      return root;
    }
  }
  return null;
}

function resolveHostPackageDirs(hostRoot) {
  const searchRoots = [
    path.join(hostRoot, "apps/server/node_modules"),
    path.join(hostRoot, "packages/plugin-api/node_modules"),
    path.join(hostRoot, "node_modules"),
    path.join(hostRoot, "node_modules/.pnpm/node_modules"),
  ];
  const resolved = {};
  for (const name of HOST_EXTERNALS) {
    for (const root of searchRoots) {
      const candidate = path.join(root, ...name.split("/"));
      const pkgPath = path.join(candidate, "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (pkg.name === name) {
          resolved[name] = realpathSync(candidate);
          break;
        }
      }
    }
    if (!resolved[name]) {
      throw new Error(`Could not resolve host external ${name} from ${hostRoot}`);
    }
  }
  return resolved;
}

function linkHostPackages(targetDir, packageDirs) {
  const nm = path.join(targetDir, "node_modules");
  mkdirSync(nm, { recursive: true });
  for (const [name, sourceDir] of Object.entries(packageDirs)) {
    const dest = path.join(nm, ...name.split("/"));
    mkdirSync(path.dirname(dest), { recursive: true });
    symlinkSync(sourceDir, dest, "dir");
  }
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

const pkg = JSON.parse(readFileSync(path.join(PLUGIN_DIR, "package.json"), "utf8"));
const esbuild = findEsbuild();

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

const bundlePath = path.join(OUT_DIR, "plugin.mjs");
await esbuild.build({
  entryPoints: [path.join(PLUGIN_DIR, "src/index.ts")],
  outfile: bundlePath,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  external: [
    ...HOST_EXTERNALS,
    "effect/*",
    "@effect/platform-node/*",
    "node:*",
  ],
});

// Load the built plugin.mjs against the host externals to extract its exact manifest and verify
// the installer's contract (`default.manifest` deep-equals `manifest.json`, `default.start` is Effect).
const hostRoot = findHostRoot();
if (hostRoot === null) {
  throw new Error(
    "Could not locate p0code checkout to verify bundle imports. Set P0CODE_REPO=/path/to/p0code.",
  );
}

const stageDir = path.join(os.tmpdir(), `p0-tokscale-bundle-verify-${process.pid}-${Date.now()}`);
mkdirSync(stageDir, { recursive: true });
let manifest;
try {
  const hostPackages = resolveHostPackageDirs(hostRoot);
  linkHostPackages(stageDir, hostPackages);
  const stagedBundle = path.join(stageDir, "plugin.mjs");
  writeFileSync(stagedBundle, readFileSync(bundlePath));
  const imported = await import(`${pathToFileURL(stagedBundle).href}?t=${Date.now()}`);
  const exported = imported.default;
  if (
    typeof exported !== "object" ||
    exported === null ||
    !("manifest" in exported) ||
    !("start" in exported)
  ) {
    throw new Error("Bundled plugin.mjs default export is not a valid Plugin.");
  }
  const effectMod = await import(
    pathToFileURL(path.join(hostPackages.effect, "dist/Effect.js")).href
  );
  if (!effectMod.isEffect(exported.start)) {
    throw new Error("Bundled plugin.mjs default.start is not an Effect.");
  }
  manifest = exported.manifest;
  if (manifest.version !== pkg.version) {
    throw new Error(
      `Manifest version (${manifest.version}) disagrees with package.json (${pkg.version}).`,
    );
  }
  const roundTripped = JSON.parse(JSON.stringify(manifest));
  if (!util.isDeepStrictEqual(roundTripped, manifest)) {
    throw new Error("Manifest is not clean JSON round-trip equal.");
  }
} finally {
  rmSync(stageDir, { recursive: true, force: true });
}

const manifestPath = path.join(OUT_DIR, "manifest.json");
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const tarballName = `tokscale-auto-publish-${manifest.version}.tgz`;
const tarballPath = path.join(OUT_DIR, tarballName);
execFileSync("tar", ["-czf", tarballPath, "-C", OUT_DIR, "manifest.json", "plugin.mjs"], {
  env: { ...process.env, COPYFILE_DISABLE: "1" },
  stdio: "inherit",
});

// Verify tarball entries have exact root names (no leading `./` or AppleDouble files).
const listing = execFileSync("tar", ["-tzf", tarballPath], { encoding: "utf8" })
  .trim()
  .split(/\r?\n/)
  .sort();
if (!util.isDeepStrictEqual(listing, ["manifest.json", "plugin.mjs"])) {
  throw new Error(`Unexpected tarball entries: ${JSON.stringify(listing)}`);
}

const tarballSha = sha256File(tarballPath);
const pluginSha = sha256File(bundlePath);
const manifestSha = sha256File(manifestPath);

writeFileSync(path.join(OUT_DIR, `${tarballName}.sha256`), `${tarballSha}  ${tarballName}\n`);
writeFileSync(
  path.join(OUT_DIR, "SHA256SUMS.txt"),
  [
    `${tarballSha}  ${tarballName}`,
    `${pluginSha}  plugin.mjs`,
    `${manifestSha}  manifest.json`,
    "",
  ].join("\n"),
);

console.log(`Built ${tarballPath}`);
console.log(`  size:   ${readFileSync(tarballPath).byteLength} bytes`);
console.log(`  sha256: ${tarballSha}`);
