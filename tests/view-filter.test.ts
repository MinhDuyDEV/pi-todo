import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMarkdown, serializeMarkdown } from "../src/markdown.js";
import { isViewFilter, filterStatuses, VIEW_FILTERS } from "../src/model.js";
import { TodoStore } from "../src/store.js";
import { viewText } from "../src/tool.js";

function setup(doc = ""): { store: TodoStore; dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "pi-todo-view-"));
  const file = join(dir, "TODO.md");
  if (doc) writeFileSync(file, doc, "utf8");
  return { store: new TodoStore(file), dir, file };
}

const DOC = `### A
status: active

- [ ] pending one
- [/] in progress two
- [x] completed three
- [-] abandoned four
- [!] blocked five

### B - all done
status: done

- [x] finished six
`;

const phases = () => parseMarkdown(DOC).phases;

test("VIEW_FILTERS exposes the additive presets", () => {
  assert.ok(VIEW_FILTERS.includes("open"));
  assert.ok(VIEW_FILTERS.includes("completed"));
  assert.ok(VIEW_FILTERS.includes("abandoned"));
  assert.ok(VIEW_FILTERS.includes("blocked"));
  assert.ok(VIEW_FILTERS.includes("archived"));
});

test("isViewFilter: recognizes presets, rejects garbage", () => {
  assert.equal(isViewFilter("open"), true);
  assert.equal(isViewFilter("archived"), true);
  assert.equal(isViewFilter("nope"), false);
  assert.equal(isViewFilter(""), false);
});

test("filterStatuses: open = pending+in_progress+blocked; presets map to one status", () => {
  assert.deepEqual(filterStatuses("open"), ["pending", "in_progress", "blocked"]);
  assert.deepEqual(filterStatuses("completed"), ["completed"]);
  assert.deepEqual(filterStatuses("abandoned"), ["abandoned"]);
  assert.deepEqual(filterStatuses("blocked"), ["blocked"]);
  assert.equal(filterStatuses("archived"), null);
});

test("viewText: default (no filter) is unchanged — full phase list, global numbering", () => {
  const expected = `### A (status: active, 1/5 done)
  1. [ ] pending one
  2. [/] in progress two
  3. [x] completed three
  4. [-] abandoned four
  5. [!] blocked five
### B - all done (status: done, 1/1 done)
  6. [x] finished six`;
  assert.equal(viewText(phases()), expected);
});

test("viewText: 'open' hides completed/abandoned and phases with no open items", () => {
  const out = viewText(phases(), "open");
  assert.ok(out.includes("[ ] pending one"), out);
  assert.ok(out.includes("[/] in progress two"), out);
  assert.ok(out.includes("[!] blocked five"), out);
  assert.ok(!out.includes("completed three"), out);
  assert.ok(!out.includes("abandoned four"), out);
  // Phase B has no open items → hidden.
  assert.ok(!out.includes("B - all done"), out);
});

test("viewText: 'completed' shows only completed items", () => {
  const out = viewText(phases(), "completed");
  assert.ok(out.includes("[x] completed three"), out);
  assert.ok(out.includes("[x] finished six"), out);
  assert.ok(!out.includes("pending one"), out);
  assert.ok(!out.includes("in progress two"), out);
});

test("viewText: 'abandoned' shows only abandoned items", () => {
  const out = viewText(phases(), "abandoned");
  assert.ok(out.includes("[-] abandoned four"), out);
  assert.ok(!out.includes("pending one"), out);
  assert.ok(!out.includes("completed three"), out);
});

test("viewText: 'blocked' shows only blocked items", () => {
  const out = viewText(phases(), "blocked");
  assert.ok(out.includes("[!] blocked five"), out);
  assert.ok(!out.includes("pending one"), out);
});

test("viewText: 'in_progress' shows only in progress items", () => {
  const out = viewText(phases(), "in_progress");
  assert.ok(out.includes("[/] in progress two"), out);
  assert.ok(!out.includes("pending one"), out);
});

test("viewText: 'pending' shows only pending items", () => {
  const out = viewText(phases(), "pending");
  assert.ok(out.includes("[ ] pending one"), out);
  assert.ok(!out.includes("in progress two"), out);
});

test("viewText: filter narrows item list but keeps full phase stats in header", () => {
  const out = viewText(phases(), "open");
  // Header still reports 1/5 done over the whole phase A.
  assert.ok(out.includes("### A (status: active, 1/5 done)"), out);
});

test("viewText: invalid filter falls back to the full view (no throw)", () => {
  assert.equal(viewText(phases(), "garbage"), viewText(phases()));
});

test("viewText: archived filter renders the archive store's phases", async () => {
  const { store } = setup(`### Done phase
status: done

- [x] finished work
`);
  // Archive the done phase, then view archived.
  await store.archive();
  const out = viewText(store.getArchive(), undefined);
  assert.ok(out.includes("Done phase"), out);
  assert.ok(out.includes("[x] finished work"), out);
});

test("TodoStore.get(): filter=open narrows active items without mutating the file", async () => {
  const { store, file } = setup(DOC);
  const out = viewText(store.get().phases, "open");
  assert.ok(out.includes("pending one"), out);
  assert.ok(!out.includes("completed three"), out);
  // Viewing is read-only.
  assert.equal(readFileSync(file, "utf8"), DOC);
});