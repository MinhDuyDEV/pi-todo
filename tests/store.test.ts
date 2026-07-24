import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TodoStore } from "../src/store";

function setup(doc = ""): { store: TodoStore; dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "pi-todo-"));
  const file = join(dir, "TODO.md");
  if (doc) writeFileSync(file, doc, "utf8");
  return { store: new TodoStore(file), dir, file };
}

const DOC = `### A - phase one
status: active

- [ ] write tests
- [ ] wire up tool
- [x] scaffold
`;

test("TodoStore: reads + parses existing file", () => {
  const { store } = setup(DOC);
  const doc = store.get();
  assert.equal(doc.phases.length, 1);
  assert.equal(doc.phases[0]!.title, "A - phase one");
  assert.equal(doc.phases[0]!.body.filter((e) => e.type === "item").length, 3);
});

test("TodoStore: missing file → empty doc, no throw", () => {
  const { store } = setup();
  assert.equal(store.get().phases.length, 0);
});

test("TodoStore.add: writes item + persists to disk", async () => {
  const { store, file } = setup(DOC);
  await store.add("A - phase one", "new item");
  const fresh = new TodoStore(file);
  assert.ok(fresh.get().phases[0]!.body.some((e) => e.type === "item" && e.item.content === "new item"));
});

test("TodoStore.done: marks completed and round-trips on disk", async () => {
  const { store, file } = setup(DOC);
  await store.done("write tests");
  const fresh = new TodoStore(file);
  const items = fresh.get().phases[0]!.body.filter((e) => e.type === "item");
  const it = items.find((e) => e.item.content === "write tests")!;
  assert.equal(it.item.status, "completed");
});

test("TodoStore.start: enforces single-active and persists", async () => {
  const { store, file } = setup(
    `### A
status: active

- [/] one
- [ ] two
`,
  );
  await store.start("two");
  const fresh = new TodoStore(file);
  const items = fresh.get().phases[0]!.body.filter((e) => e.type === "item").map((e) => e.item);
  const inProg = items.filter((i) => i.status === "in_progress");
  assert.equal(inProg.length, 1);
  assert.equal(inProg[0]!.content, "two");
});

test("TodoStore.apply: changed=false when no-op", async () => {
  const { store } = setup(DOC);
  const r = await store.apply((p) => p); // identity → after normalize may equal
  assert.equal(r.changed, false);
});

test("TodoStore.reconcileSubagent: success marks matching item completed", async () => {
  const { store, file } = setup(DOC);
  const changed = await store.reconcileSubagent("write the tests", true);
  assert.equal(changed, true);
  const fresh = new TodoStore(file);
  const it = fresh.get().phases[0]!.body.find(
    (e): e is Extract<typeof e, { type: "item" }> => e.type === "item" && e.item.content === "write tests",
  )!;
  assert.equal(it.item.status, "completed");
});

test("TodoStore.reconcileSubagent: failure reverts to pending + note", async () => {
  const { store, file } = setup(
    `### A
status: active

- [/] build feature
`,
  );
  const changed = await store.reconcileSubagent("build the feature", false, "syntax error");
  assert.equal(changed, true);
  const fresh = new TodoStore(file);
  const entry = fresh.get().phases[0]!.body.find(
    (e): e is Extract<typeof e, { type: "item" }> => e.type === "item" && e.item.content === "build feature",
  )!;
  assert.equal(entry.item.status, "pending");
  assert.equal(entry.item.blockerNote, "syntax error");
});

test("TodoStore: atomic write leaves no .tmp file on success", async () => {
  const { store, dir } = setup(DOC);
  await store.add("A - phase one", "x");
  const { readdirSync } = await import("node:fs");
  const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp-"));
  assert.deepEqual(leftovers, []);
});

test("cleanup", () => {
  // best-effort temp cleanup; tests above create their own dirs
  const { dir } = setup();
  rmSync(dir, { recursive: true, force: true });
});

test("concurrency: 20 concurrent adds all survive (no temp collision, no lost update)", async () => {
  const { store, file } = setup("");
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, k) => store.add("P", `item-${k}`).then((r) => r.changed).catch(() => "ERR")),
  );
  const errs = results.filter((r) => r === "ERR");
  const changed = results.filter((r) => r === true).length;
  const fresh = new TodoStore(file);
  const items = fresh.get().phases[0]!.body.filter((e) => e.type === "item").map((e) => (e as { item: { content: string } }).item.content);
  assert.equal(errs.length, 0, "no add should reject (no ENOENT)");
  assert.equal(changed, 20, "all 20 adds should report changed");
  assert.equal(items.length, 20, "all 20 items should be on disk");
  assert.equal(new Set(items).size, 20, "all items distinct");
});

test("concurrency: external edit during apply is not clobbered (CAS)", async () => {
  const { store, file } = setup("### P\nstatus: active\n\n- [ ] keep\n");
  // Simulate an external write landing just before our apply's rename by
  // racing a direct write against store.done. The mutex serializes in-process;
  // here we verify a pre-write external change is preserved (re-applied onto).
  const { writeFileSync } = await import("node:fs");
  const external = "### P\nstatus: active\n\n- [ ] keep\n- [ ] external\n";
  writeFileSync(file, external);
  await store.done("keep");
  const fresh = new TodoStore(file);
  const contents = fresh.get().phases[0]!.body.filter((e) => e.type === "item").map((e) => (e as { item: { content: string } }).item.content);
  // The external item must survive AND keep must be completed.
  assert.ok(contents.includes("external"), "external edit preserved");
  const keep = fresh.get().phases[0]!.body.find((e): e is Extract<typeof e, { type: "item" }> => e.type === "item" && e.item.content === "keep")!;
  assert.equal(keep.item.status, "completed");
});

test("readSync: ENOENT → empty; non-file (EISDIR) throws (does not clobber)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-todo-err-"));
  const file = join(dir, "TODO.md");
  // ENOENT → empty
  const s = new TodoStore(file);
  assert.equal(s.get().phases.length, 0);
  // point at the directory itself → readSync throws (not silently empty)
  const sDir = new TodoStore(dir);
  assert.throws(() => sDir.readSync(), /not a regular file/);
  rmSync(dir, { recursive: true, force: true });
});

const MULTIPHASE = `### 2026-01-01 - Alpha
status: active

- [ ] a1
- [/] a2
- [x] a3

### 2026-01-02 - Beta
status: active

- [ ] b1
- [ ] b2

### 2026-01-03 - Gamma
status: active

- [ ] g1
`;

const EMPTY = `### 2026-01-04 - Delta
status: active

### 2026-01-05 - Epsilon
status: active

- [ ] e1
`;

const item = (p: { body: Array<{ type: string; item?: { content: string; status: string } }> }, content: string) =>
  p.body.find((e) => e.type === "item" && e.item?.content === content)!.item!;

test("done <phase>: completes remaining items + marks phase done + promotes NEXT active phase", async () => {
  const { store, file } = setup(MULTIPHASE);
  await store.done("Alpha");
  const doc = new TodoStore(file).get();
  const alpha = doc.phases.find((x) => x.title === "Alpha")!;
  assert.equal(alpha.status, "done", "Alpha marked done");
  assert.equal(item(alpha, "a1").status, "completed", "pending a1 completed");
  assert.equal(item(alpha, "a2").status, "completed", "in_progress a2 completed");
  assert.equal(item(alpha, "a3").status, "completed", "completed a3 stays completed");
  const beta = doc.phases.find((x) => x.title === "Beta")!;
  assert.equal(item(beta, "b1").status, "in_progress", "next active phase Beta promoted b1");
  const gamma = doc.phases.find((x) => x.title === "Gamma")!;
  assert.equal(item(gamma, "g1").status, "pending", "Gamma NOT promoted (only the next phase after Alpha)");
});

test("done <phase>: last active phase → marks done, no promotion, no throw", async () => {
  const { store, file } = setup(MULTIPHASE);
  await store.done("Gamma");
  const doc = new TodoStore(file).get();
  const gamma = doc.phases.find((x) => x.title === "Gamma")!;
  assert.equal(gamma.status, "done");
  assert.equal(item(gamma, "g1").status, "completed");
  assert.equal(doc.phases.find((x) => x.title === "Alpha")!.status, "active");
  // Alpha is untouched (its a2 stays in_progress); Beta/Gamma get no new in_progress.
  assert.equal(item(doc.phases.find((x) => x.title === "Alpha")!, "a2").status, "in_progress", "Alpha a2 untouched");
  assert.equal(item(doc.phases.find((x) => x.title === "Beta")!, "b1").status, "pending", "Beta not promoted");
  assert.equal(item(doc.phases.find((x) => x.title === "Gamma")!, "g1").status, "completed", "Gamma g1 completed");
});

test("done <empty-phase>: marks the empty phase done without error", async () => {
  const { store, file } = setup(EMPTY);
  await store.done("Delta");
  const doc = new TodoStore(file).get();
  assert.equal(doc.phases.find((x) => x.title === "Delta")!.status, "done", "empty phase Delta closed");
  assert.equal(item(doc.phases.find((x) => x.title === "Epsilon")!, "e1").status, "in_progress");
});

test("done <unknown-ref>: no-op (no phase or item changes)", async () => {
  const { store, file } = setup(MULTIPHASE);
  const before = new TodoStore(file).get();
  await store.done("does-not-exist");
  const after = new TodoStore(file).get();
  assert.equal(after.phases.length, before.phases.length);
  for (const ph of after.phases) {
    assert.equal(ph.status, before.phases.find((x) => x.title === ph.title)!.status);
  }
});

test("done <item-ref>: still works (completes item + same-phase auto-promote)", async () => {
  const { store, file } = setup(MULTIPHASE);
  await store.done("b1");
  const doc = new TodoStore(file).get();
  const beta = doc.phases.find((x) => x.title === "Beta")!;
  assert.equal(item(beta, "b1").status, "completed", "b1 completed");
  assert.equal(item(beta, "b2").status, "in_progress", "b2 promoted within Beta");
});
