import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

interface PackageManifest {
  version: string;
  main?: string;
  types?: string;
  engines?: Record<string, string>;
  exports?: Record<string, { types?: string; import?: string }>;
  files?: string[];
  pi?: { extensions?: string[] };
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function manifest(): Promise<PackageManifest> {
  return JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as PackageManifest;
}

async function readme(): Promise<string> {
  return readFile(new URL("../README.md", import.meta.url), "utf8");
}

/**
 * The whole `pi-*` set must resolve ONE Pi host. An open host range on three
 * packages and a narrower range on a fourth can make an unverified Pi install
 * and conflict on the fourth, so the range is pinned to a single minor here and
 * in every sibling package.
 */
test("Pi peer and development ranges pin one host minor across the pi-* set", async () => {
  const pkg = await manifest();
  assert.equal(pkg.peerDependencies?.["@earendil-works/pi-coding-agent"], ">=0.84.0 <0.85.0");
  assert.equal(pkg.peerDependencies?.["@earendil-works/pi-tui"], ">=0.84.0 <0.85.0");
  assert.equal(pkg.peerDependencies?.typebox, "1.3.7");
  assert.equal(pkg.devDependencies?.["@earendil-works/pi-coding-agent"], "0.84.0");
  assert.equal(pkg.devDependencies?.["@earendil-works/pi-tui"], "0.84.0");
  assert.equal(pkg.devDependencies?.typebox, "1.3.7");
  assert.equal(pkg.engines?.node, ">=22.19.0", "engines must match the rest of the pi-* set");
});

/**
 * Publishing raw `.ts` made every subpath unloadable outside Pi's jiti loader:
 * extensionless relative imports fail to resolve and parameter properties hit
 * `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, which no Node flag can turn
 * off. The package advertises four subpaths, so all four must be compiled.
 */
test("every advertised entry point resolves to compiled output, not raw TypeScript", async () => {
  const pkg = await manifest();
  assert.match(pkg.main ?? "", /^\.\/dist\/.*\.js$/);
  assert.match(pkg.types ?? "", /^\.\/dist\/.*\.d\.ts$/);
  for (const [subpath, entry] of Object.entries(pkg.exports ?? {})) {
    assert.match(entry.import ?? "", /^\.\/dist\/.*\.js$/, `${subpath} import must be compiled`);
    assert.match(entry.types ?? "", /^\.\/dist\/.*\.d\.ts$/, `${subpath} types must be compiled`);
  }
  for (const entry of pkg.pi?.extensions ?? []) {
    assert.match(entry, /^\.\/dist\/.*\.js$/, "the Pi extension entry must be compiled too");
  }
  assert.ok(pkg.files?.includes("dist"), "dist must be published");
  assert.ok(!pkg.files?.includes("src"), "raw src must not be published");
});

test("the canonical Markdown parser is exposed through a public subpath", async () => {
  const pkg = await manifest();
  const markdown = pkg.exports?.["./markdown"];
  assert.ok(markdown, "./markdown export must remain public for integrations");
  assert.equal(markdown.import, "./dist/markdown.js");
  assert.equal(markdown.types, "./dist/markdown.d.ts");
});

test("README install/default claims stay aligned with the published manifest", async () => {
  const [pkg, docs] = await Promise.all([manifest(), readme()]);
  assert.match(docs, /ships compiled ESM[\s\S]*`dist`/);
  assert.match(docs, /extension entry is `\.\/dist\/index\.js`/);
  assert.match(docs, /\| `widget` \| `true` \|/);
  assert.match(docs, /\| `autoArchive` \| `true` \|/);
  assert.match(docs, /only while the project is Pi-trusted/);
  assert.match(docs, new RegExp(`npm:@minhduydev/pi-todo@${pkg.version.replaceAll(".", "\\.")}`));
  assert.match(docs, /subagent-tasks\.json/);
  assert.match(docs, /unmatched description remains retryable/);
  assert.match(docs, /only treats the explicit terminal `done` phase as success/);
  assert.doesNotMatch(docs, /entry `\.\/src\/index\.ts`|ships TypeScript source/);
  assert.doesNotMatch(docs, /todo\.ts nudge|moving to the typed events is planned/);
});
