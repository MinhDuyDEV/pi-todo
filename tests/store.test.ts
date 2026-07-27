import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TodoStore } from "../src/store.js";

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
  const result = await store.reconcileSubagent("write the tests", true);
  assert.equal(result, "applied");
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
  const result = await store.reconcileSubagent("build the feature", false, "syntax error");
  assert.equal(result, "applied");
  const fresh = new TodoStore(file);
  const entry = fresh.get().phases[0]!.body.find(
    (e): e is Extract<typeof e, { type: "item" }> => e.type === "item" && e.item.content === "build feature",
  )!;
  assert.equal(entry.item.status, "pending");
  assert.equal(entry.item.blockerNote, "syntax error");
});

test("TodoStore.reconcileSubagent: explicit #id refs win over fuzzy text (roadmap 25)", async () => {
  const { store, file } = setup(
    `### A
status: active

- [ ] (#1) refactor the auth parser
- [ ] (#2) refactor the auth serializer
- [ ] (#3) unrelated cleanup
`,
  );
  // The description names #3 explicitly; its TEXT resembles items #1/#2. The
  // ref is the contract — text similarity must not widen the blast radius.
  const result = await store.reconcileSubagent("refactor the auth layer (#3)", true);
  assert.equal(result, "applied");
  const items = new TodoStore(file)
    .get()
    .phases[0]!.body.filter((e): e is Extract<typeof e, { type: "item" }> => e.type === "item")
    .map((e) => e.item);
  assert.deepEqual(
    items.map((it) => [it.id, it.status]),
    [["#1", "pending"], ["#2", "pending"], ["#3", "completed"]],
  );
});

test("TodoStore.reconcileSubagent: fuzzy fallback completes at most ONE best match", async () => {
  const { store, file } = setup(
    `### A
status: active

- [ ] extract the token parser for auth
- [ ] extract the token parser for sessions
- [ ] extract the token parser for billing
`,
  );
  // Every item clears the similarity bar; the old behavior completed ALL of
  // them from one subagent result.
  const result = await store.reconcileSubagent("extract the token parser for auth", true);
  assert.equal(result, "applied");
  const items = new TodoStore(file)
    .get()
    .phases[0]!.body.filter((e): e is Extract<typeof e, { type: "item" }> => e.type === "item")
    .map((e) => e.item);
  assert.equal(items.filter((it) => it.status === "completed").length, 1);
  assert.equal(items.find((it) => it.status === "completed")?.content, "extract the token parser for auth");
});

test("TodoStore.reconcileSubagent: an unresolvable #id completes nothing", async () => {
  const { store, file } = setup(DOC);
  // The description carries a ref, so fuzzy must NOT engage — a typo'd ref
  // silently completing a lookalike item is the failure mode being removed.
  const result = await store.reconcileSubagent("write the tests (#99)", true);
  assert.equal(result, "unmatched");
  const items = new TodoStore(file)
    .get()
    .phases[0]!.body.filter((e): e is Extract<typeof e, { type: "item" }> => e.type === "item")
    .map((e) => e.item);
  // DOC's open items stay open ("scaffold" was completed in the fixture).
  assert.deepEqual(
    items.map((it) => [it.content, it.status]),
    [["write tests", "pending"], ["wire up tool", "pending"], ["scaffold", "completed"]],
  );
});

test("TodoStore.reconcileSubagent: durable retry distinguishes already-applied from unmatched", async () => {
  const { store } = setup(DOC);
  assert.equal(
    await store.reconcileSubagent("write the tests", true),
    "applied",
  );
  assert.equal(
    await store.reconcileSubagent("write the tests", true),
    "already-applied",
    "a crash after the TODO write can be acknowledged on replay",
  );
  assert.equal(
    await store.reconcileSubagent("does not exist", true),
    "unmatched",
    "a successful no-op call must not be mistaken for an acknowledgement",
  );
});

test("TodoStore.reconcileSubagent: empty and oversized native descriptions fail closed", async () => {
  const { store } = setup(DOC);
  assert.equal(await store.reconcileSubagent("", true), "unmatched");
  assert.equal(await store.reconcileSubagent("x".repeat(4_001), true), "unmatched");
  const statuses = store.get().phases[0]!.body
    .filter((entry): entry is Extract<typeof entry, { type: "item" }> => entry.type === "item")
    .map((entry) => entry.item.status);
  assert.deepEqual(statuses, ["pending", "pending", "completed"]);
});

test("TodoStore.reconcileSubagent: repeated failure result is idempotently acknowledged", async () => {
  const { store } = setup(
    `### A
status: active

- [/] build feature
`,
  );
  assert.equal(
    await store.reconcileSubagent("build feature", false, "compile failed"),
    "applied",
  );
  assert.equal(
    await store.reconcileSubagent("build feature", false, "compile failed"),
    "already-applied",
  );
});

test("TodoStore.reconcileSubagent: failure notes are redacted before persistence", async () => {
  const { store } = setup(
    `### A
status: active

- [/] build feature
`,
  );
  const secret = "abcdefghijklmnop";
  assert.equal(
    await store.reconcileSubagent(
      "build feature",
      false,
      `compile failed api_key=${secret}`,
    ),
    "applied",
  );
  const item = store.get().phases[0]!.body.find(
    (entry): entry is Extract<typeof entry, { type: "item" }> => entry.type === "item",
  )!.item;
  assert.equal(item.blockerNote, "compile failed [REDACTED]");
  assert.equal(item.blockerNote?.includes(secret), false);
});

test("TodoStore.reconcileSubagent: mixed missing refs fail closed without partial writes", async () => {
  const { store, file } = setup(
    `### A
status: active

- [ ] (#1) first
- [ ] (#2) second
`,
  );
  assert.equal(
    await store.reconcileSubagent("finish #1 and #missing", true),
    "unmatched",
  );
  const items = new TodoStore(file)
    .get()
    .phases[0]!.body.filter((e): e is Extract<typeof e, { type: "item" }> => e.type === "item");
  assert.deepEqual(items.map((entry) => entry.item.status), ["pending", "pending"]);
});

test("TodoStore.reconcileSubagent: duplicate refs and fuzzy ties are ambiguous", async () => {
  const duplicate = setup(
    `### A
status: active

- [ ] (#same) first
- [ ] (#same) second
`,
  );
  assert.equal(
    await duplicate.store.reconcileSubagent("finish #same", true),
    "unmatched",
  );

  const fuzzy = setup(
    `### A
status: active

- [ ] identical work
- [ ] identical work
`,
  );
  assert.equal(
    await fuzzy.store.reconcileSubagent("identical work", true),
    "unmatched",
  );
});

test("TodoStore.reconcileSubagent: an operator-terminal item supersedes a late task result", async () => {
  const { store } = setup(
    `### A
status: active

- [-] (#1) cancelled by operator
`,
  );
  assert.equal(
    await store.reconcileSubagent("finish #1", true),
    "superseded",
  );
  assert.equal(
    store.get().phases[0]!.body.find((entry) => entry.type === "item")?.item.status,
    "abandoned",
  );
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

test("concurrency: two store instances in one process never collide on a temp file (T-A)", async () => {
  const { file } = setup("");
  // The old temp name was `${pid}-${seq}` with `seq` per-instance, so the first
  // write of every instance in a process picked the SAME path.
  const a = new TodoStore(file);
  const b = new TodoStore(file);
  const results = await Promise.all([
    ...Array.from({ length: 10 }, (_, k) => a.add("P", `a-${k}`).catch((e) => e as Error)),
    ...Array.from({ length: 10 }, (_, k) => b.add("P", `b-${k}`).catch((e) => e as Error)),
  ]);
  const errs = results.filter((r) => r instanceof Error);
  assert.equal(errs.length, 0, `no write should fail: ${errs.map(String).join("; ")}`);
  const contents = new TodoStore(file)
    .get()
    .phases[0]!.body.filter((e) => e.type === "item")
    .map((e) => (e as { item: { content: string } }).item.content);
  assert.equal(new Set(contents).size, 20, "all 20 items from both instances survive");
});

test("CAS: a writer that loses every race THROWS instead of clobbering (T-B)", async () => {
  const { store, file } = setup("### P\nstatus: active\n\n- [ ] keep\n");
  const { writeFileSync, readFileSync } = await import("node:fs");
  let n = 0;
  const original = (store as unknown as { versionKey(): string }).versionKey;
  // Force a permanent CAS conflict: every check reports a different version.
  (store as unknown as { versionKey(): string }).versionKey = () => `conflict-${n++}`;
  await assert.rejects(() => store.add("P", "should-not-land"), /CAS retries exhausted/);
  (store as unknown as { versionKey(): string }).versionKey = original;
  assert.equal(
    readFileSync(file, "utf8").includes("should-not-land"),
    false,
    "the losing writer must not have written",
  );
  void writeFileSync;
});

test("CAS: a same-length, same-millisecond external edit is still detected (T-B)", async () => {
  const { store, file } = setup("### P\nstatus: active\n\n- [ ] aaaa\n");
  const version = store.version();
  const { writeFileSync } = await import("node:fs");
  const { utimesSync, statSync } = await import("node:fs");
  const st = statSync(file);
  // Same byte length, restored mtime — indistinguishable under an mtime:size key.
  writeFileSync(file, "### P\nstatus: active\n\n- [ ] bbbb\n");
  utimesSync(file, st.atime, st.mtime);
  assert.notEqual(store.version(), version, "content fingerprint must notice the edit");
});

test("writeRaw: refuses to overwrite a file that changed since the caller read it", async () => {
  const { store, file } = setup("### P\nstatus: active\n\n- [ ] keep\n");
  const version = store.version();
  const { writeFileSync, readFileSync } = await import("node:fs");
  writeFileSync(file, "### P\nstatus: active\n\n- [ ] someone-else\n");
  await assert.rejects(
    () => store.writeRaw("### P\nstatus: active\n\n- [ ] stale-editor-buffer\n", version),
    /changed since it was read/,
  );
  assert.match(readFileSync(file, "utf8"), /someone-else/);
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
  await store.done("phase:Alpha");
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
  await store.done("phase:Gamma");
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
  await store.done("phase:Delta");
  const doc = new TodoStore(file).get();
  assert.equal(doc.phases.find((x) => x.title === "Delta")!.status, "done", "empty phase Delta closed");
  assert.equal(item(doc.phases.find((x) => x.title === "Epsilon")!, "e1").status, "in_progress");
});

test("done <bare phase title>: does NOT close the phase (needs an explicit phase: ref)", async () => {
  const { store, file } = setup(MULTIPHASE);
  const result = await store.done("Alpha");
  assert.equal(result.changed, false, "a bare title must not fall back to closing the phase");
  const doc = new TodoStore(file).get();
  const alpha = doc.phases.find((x) => x.title === "Alpha")!;
  assert.equal(alpha.status, "active", "Alpha untouched");
  assert.equal(item(alpha, "a1").status, "pending", "a1 untouched");
  assert.equal(item(alpha, "a2").status, "in_progress", "a2 untouched");
});

test("done <1-char ref>: matches nothing (substring scoring no longer returns 0.9 for everything)", async () => {
  const { store, file } = setup(MULTIPHASE);
  for (const ref of ["a", "th", "AUTH"]) {
    const result = await store.done(ref);
    assert.equal(result.changed, false, `ref "${ref}" must not match`);
  }
  const doc = new TodoStore(file).get();
  assert.equal(doc.phases.find((x) => x.title === "Alpha")!.status, "active");
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
