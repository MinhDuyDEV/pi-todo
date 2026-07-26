import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

interface PackageManifest {
  version: string;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function manifest(): Promise<PackageManifest> {
  return JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as PackageManifest;
}

test("Pi peer and development ranges match the published 0.x host packages", async () => {
  const pkg = await manifest();
  assert.equal(pkg.peerDependencies?.["@earendil-works/pi-coding-agent"], ">=0.81.1");
  assert.equal(pkg.peerDependencies?.["@earendil-works/pi-tui"], ">=0.81.1");
  assert.equal(pkg.devDependencies?.["@earendil-works/pi-coding-agent"], "^0.81.1");
  assert.equal(pkg.devDependencies?.["@earendil-works/pi-tui"], "^0.81.1");
});
