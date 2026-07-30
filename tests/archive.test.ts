import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMarkdown, serializeMarkdown } from "../src/markdown.js";
import { TodoStore } from "../src/store.js";
import type { TodoItem } from "../src/types.js";

function setup(doc = ""): { store: TodoStore; dir: string; file: string; archive: string } {
  const dir = mkdtempSync(join(tmpdir(), "pi-todo-archive-"));
  const file = join(dir, "TODO.md");
  if (doc) writeFileSync(file, doc, "utf8");
  return { store: new TodoStore(file), dir, file, archive: join(dir, "TODO.archive.md") };
}

const ACTIVE = `### Active phase
status: active

- [ ] pending task

### Done phase
status: done

- [x] finished task

### Abandoned phase
status: abandoned

- [-] dropped task
`;

function titles(doc: ReturnType<typeof parseMarkdown>): string[] {
  return doc.phases.map((p) => p.title);
}

test("archivePath: derived as <base>.archive.md next to TODO.md", () => {
  const { store, archive } = setup();
  assert.equal(store.archivePath, archive);
});

test("getArchive: empty list when no archive file exists", () => {
  const { store } = setup();
  assert.deepEqual(store.getArchive(), []);
});

test("archive(): moves done + abandoned phases to the archive file, losslessly", async () => {
  const { store, archive } = setup(ACTIVE);
  const r = await store.archive();
  assert.equal(r.changed, true);
  assert.deepEqual(r.archived, ["Done phase", "Abandoned phase"]);
  // Active file keeps only the active phase, in order.
  const activeAfter = parseMarkdown(readFileSync(store.filePath, "utf8"));
  assert.deepEqual(titles(activeAfter), ["Active phase"]);
  // Archive file exists and holds the terminal phases, in order.
  assert.ok(existsSync(archive), "archive file should exist");
  const archAfter = parseMarkdown(readFileSync(archive, "utf8"));
  assert.deepEqual(titles(archAfter), ["Done phase", "Abandoned phase"]);
  // Lossless invariant: union of titles (active ++ archive) before == after.
  const before = titles(parseMarkdown(ACTIVE));
  const after = [...titles(activeAfter), ...titles(archAfter)];
  assert.deepEqual(after, before);
});

test("archive(): item content, ids, and deps are preserved verbatim across the move", async () => {
  const md = `### Done phase
status: done

- [x] (#1) first [blocks #2]
- [x] (#2) second
`;
  const { store, archive } = setup(md);
  await store.archive();
  const arch = parseMarkdown(readFileSync(archive, "utf8"));
  const items: TodoItem[] = [];
  for (const e of arch.phases[0]!.body) if (e.type === "item") items.push(e.item);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.id), ["#1", "#2"]);
  assert.deepEqual(items.map((i) => i.blocks), [["#2"], []]);
  assert.equal(items[0]!.content, "first");
  assert.equal(items[1]!.content, "second");
});

test("archive(): idempotent — second call is a no-op, no duplication", async () => {
  const { store, archive } = setup(ACTIVE);
  await store.archive();
  const after1 = readFileSync(archive, "utf8");
  const r2 = await store.archive();
  assert.equal(r2.changed, false);
  assert.deepEqual(r2.archived, []);
  assert.equal(readFileSync(archive, "utf8"), after1);
});

test("archive(): no terminal phases → no-op, archive file not created", async () => {
  const { store, archive } = setup(`### Active
status: active

- [ ] one
`);
  const r = await store.archive();
  assert.equal(r.changed, false);
  assert.ok(!existsSync(archive));
});

test("archive(phase:<title>): archives a specific terminal phase", async () => {
  const { store, archive } = setup(ACTIVE);
  const r = await store.archive("phase:Done phase");
  assert.equal(r.changed, true);
  assert.deepEqual(r.archived, ["Done phase"]);
  const activeAfter = parseMarkdown(readFileSync(store.filePath, "utf8"));
  assert.deepEqual(titles(activeAfter), ["Active phase", "Abandoned phase"]);
  const arch = parseMarkdown(readFileSync(archive, "utf8"));
  assert.deepEqual(titles(arch), ["Done phase"]);
});

test("archive(phase:<title>): refuses to archive an active phase (lossless guard)", async () => {
  const { store, archive } = setup(ACTIVE);
  const r = await store.archive("phase:Active phase");
  assert.equal(r.changed, false);
  assert.ok(!existsSync(archive), "archive file must not be created for an active phase");
  // Active file untouched.
  assert.equal(readFileSync(store.filePath, "utf8"), ACTIVE);
});

test("archive(): appends to an existing archive (preserves prior history)", async () => {
  const { store, archive } = setup(ACTIVE);
  // Seed an existing archive with prior history.
  writeFileSync(
    archive,
    `### Prior done
status: done

- [x] old
`,
    "utf8",
  );
  await store.archive();
  const arch = parseMarkdown(readFileSync(archive, "utf8"));
  assert.deepEqual(titles(arch), ["Prior done", "Done phase", "Abandoned phase"]);
});

test("archive(): archive file is human-readable markdown that round-trips", async () => {
  const { store, archive } = setup(ACTIVE);
  await store.archive();
  const md = readFileSync(archive, "utf8");
  // Round-trips losslessly under normal parse/serialize.
  assert.equal(serializeMarkdown(parseMarkdown(md)), md);
  // Looks like a normal TODO doc (phase headers + items).
  assert.ok(md.startsWith("### Done phase"), md);
});

test("getArchive(): returns parsed archive phases after archiving", async () => {
  const { store } = setup(ACTIVE);
  await store.archive();
  const arch = store.getArchive();
  assert.deepEqual(
    arch.map((p) => p.title),
    ["Done phase", "Abandoned phase"],
  );
});

test("archive(): does not break get() / cadence (active doc excludes archived phases)", async () => {
  const { store } = setup(ACTIVE);
  await store.archive();
  const active = store.get();
  assert.deepEqual(titles(active), ["Active phase"]);
  const activePhase = active.phases[0]!;
  const items: TodoItem[] = [];
  for (const e of activePhase.body) if (e.type === "item") items.push(e.item);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.status, "pending");
});

test("archive(): a failed second durable replace never loses terminal history", async () => {
  const { store, file, archive } = setup(ACTIVE);
  const internals = store as unknown as {
    durableReplaceAt(targetPath: string, contents: string): Promise<void>;
  };
  const durableReplaceAt = internals.durableReplaceAt.bind(store);
  let writes = 0;
  internals.durableReplaceAt = async (targetPath, contents) => {
    writes += 1;
    if (writes === 2) throw new Error("simulated second replace failure");
    await durableReplaceAt(targetPath, contents);
  };

  await assert.rejects(store.archive(), /simulated second replace failure/);
  const activeTitles = titles(parseMarkdown(readFileSync(file, "utf8")));
  const archiveTitles = existsSync(archive)
    ? titles(parseMarkdown(readFileSync(archive, "utf8")))
    : [];
  for (const title of titles(parseMarkdown(ACTIVE))) {
    assert.ok(
      activeTitles.includes(title) || archiveTitles.includes(title),
      `phase must survive a partial archive: ${title}`,
    );
  }
  internals.durableReplaceAt = durableReplaceAt;
  await store.archive();
  const recoveredTitles = titles(parseMarkdown(readFileSync(archive, "utf8")));
  assert.equal(
    recoveredTitles.filter((title) => title === "Done phase").length,
    1,
    "retry after a partial archive must not duplicate history",
  );
});