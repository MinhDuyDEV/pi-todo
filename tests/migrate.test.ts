import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseMarkdown,
  serializeMarkdown,
  formatVersionOf,
  FORMAT_VERSION,
  FORMAT_MARKER,
} from "../src/markdown.js";
import { migrateDoc } from "../src/model.js";
import type { TodoItem } from "../src/types.js";
import { TodoStore } from "../src/store.js";

function setup(doc = ""): { store: TodoStore; dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "pi-todo-migrate-"));
  const file = join(dir, "TODO.md");
  if (doc) writeFileSync(file, doc, "utf8");
  return { store: new TodoStore(file), dir, file };
}

function itemsOf(phase: ReturnType<typeof parseMarkdown>["phases"][number]) {
  const out: TodoItem[] = [];
  for (const e of phase.body) if (e.type === "item") out.push(e.item);
  return out;
}

test("formatVersionOf: null when no marker present", () => {
  assert.equal(formatVersionOf("### A\nstatus: active\n\n- [ ] one\n"), null);
  assert.equal(formatVersionOf("# Notes\n\n### A\nstatus: active\n\n- [ ] one\n"), null);
});

test("formatVersionOf: reads the declared format version from the preamble", () => {
  assert.equal(formatVersionOf(`${FORMAT_MARKER}\n### A\nstatus: active\n`), FORMAT_VERSION);
});

test("migrateDoc: adds the format marker to the preamble (canonical input)", () => {
  const md = `### A
status: active

- [ ] one
- [x] two
`;
  const out = serializeMarkdown(migrateDoc(parseMarkdown(md)));
  assert.equal(formatVersionOf(out), FORMAT_VERSION);
  assert.ok(out.startsWith(FORMAT_MARKER), out);
  // Canonical input: the only change is the prepended marker + separator.
  assert.equal(out, `${FORMAT_MARKER}\n\n${md}`);
});

test("migrateDoc: no duplicate marker when one is already present", () => {
  const md = `${FORMAT_MARKER}
# Notes

### A
status: active

- [ ] one
`;
  const out = serializeMarkdown(migrateDoc(parseMarkdown(md)));
  const esc = FORMAT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.equal((out.match(new RegExp(esc, "g")) || []).length, 1);
});

test("migrateDoc: idempotent", () => {
  const md = `### A
status: active

- [ ] one
- [/] two
- [x] three
- [-] four
- [!] five
`;
  const once = serializeMarkdown(migrateDoc(parseMarkdown(md)));
  const twice = serializeMarkdown(migrateDoc(parseMarkdown(once)));
  assert.equal(twice, once);
});

test("migrateDoc: normalizes oh-my-pi legacy marks to canonical", () => {
  const md = `### A
status: active

- > in progress legacy
- ~ abandoned legacy
`;
  const out = serializeMarkdown(migrateDoc(parseMarkdown(md)));
  assert.ok(out.includes("[/] in progress legacy"), out);
  assert.ok(out.includes("[-] abandoned legacy"), out);
  assert.ok(!/> in progress legacy/.test(out), out);
  assert.ok(!/~ abandoned legacy/.test(out), out);
});

test("migrateDoc: status-preserving (phase + items)", () => {
  const md = `### A
status: active

- [ ] p
- [/] ip
- [x] c
- [-] a
- [!] b
`;
  const before = parseMarkdown(md);
  const after = parseMarkdown(serializeMarkdown(migrateDoc(before)));
  assert.equal(after.phases[0]!.status, before.phases[0]!.status);
  assert.deepEqual(
    itemsOf(after.phases[0]!).map((i) => i.status),
    itemsOf(before.phases[0]!).map((i) => i.status),
  );
});

test("migrateDoc: count + ids + deps preserved", () => {
  const md = `### A
status: active

- [ ] (#1) first [blocks #2]
- [ ] (#2) second
`;
  const before = parseMarkdown(md);
  const after = parseMarkdown(serializeMarkdown(migrateDoc(before)));
  assert.equal(after.phases.length, before.phases.length);
  assert.equal(itemsOf(after.phases[0]!).length, itemsOf(before.phases[0]!).length);
  assert.deepEqual(
    itemsOf(after.phases[0]!).map((i) => i.id),
    itemsOf(before.phases[0]!).map((i) => i.id),
  );
  assert.deepEqual(
    itemsOf(after.phases[0]!).map((i) => i.blocks),
    itemsOf(before.phases[0]!).map((i) => i.blocks),
  );
});

test("migrateDoc: phase status done/abandoned preserved across migrate", () => {
  const md = `### A
status: done

- [x] done item

### B
status: abandoned

- [-] dropped item
`;
  const after = parseMarkdown(serializeMarkdown(migrateDoc(parseMarkdown(md))));
  assert.equal(after.phases[0]!.status, "done");
  assert.equal(after.phases[1]!.status, "abandoned");
});

test("format marker survives normal parse/serialize round-trip (stable under edits)", () => {
  const md = `${FORMAT_MARKER}
# Notes

### A
status: active

- [ ] one
`;
  // A migrated file, when reparsed and re-serialized WITHOUT migrate, keeps the marker.
  assert.equal(serializeMarkdown(parseMarkdown(md)), md);
});

test("TodoStore.migrate: writes migrated file, normalizes legacy, idempotent on disk", async () => {
  const { store, file } = setup(`### A
status: active

- > legacy ip
- ~ legacy dropped
`);
  const r1 = await store.migrate();
  assert.equal(r1.changed, true);
  const onDisk = readFileSync(file, "utf8");
  assert.ok(onDisk.includes("[/] legacy ip"), onDisk);
  assert.ok(onDisk.includes("[-] legacy dropped"), onDisk);
  assert.equal(formatVersionOf(onDisk), FORMAT_VERSION);
  // Idempotent: a second migrate is a no-op.
  const r2 = await store.migrate();
  assert.equal(r2.changed, false);
  assert.equal(readFileSync(file, "utf8"), onDisk);
});

test("TodoStore.migrate: no-op on already-canonical file with marker", async () => {
  const { store, file } = setup(`${FORMAT_MARKER}
### A
status: active

- [ ] one
`);
  const r = await store.migrate();
  assert.equal(r.changed, false);
  assert.equal(
    readFileSync(file, "utf8"),
    `${FORMAT_MARKER}\n### A\nstatus: active\n\n- [ ] one\n`,
  );
});

test("migrateDoc: preserves duplicate in-progress statuses in legacy input", () => {
  const md = `### A
status: active

- [/] first
- [/] second
`;
  const before = parseMarkdown(md);
  const after = parseMarkdown(serializeMarkdown(migrateDoc(before)));
  assert.deepEqual(
    itemsOf(after.phases[0]!).map((item) => item.status),
    ["in_progress", "in_progress"],
  );
});

test("TodoStore.migrate: retries instead of writing after a stale read", async () => {
  const { store, file } = setup(`### A
status: active

- > legacy
`);
  const internals = store as unknown as { versionKey(): string };
  const versionKey = internals.versionKey.bind(store);
  let calls = 0;
  internals.versionKey = () => {
    calls += 1;
    return calls === 2 ? "external-change" : versionKey();
  };

  const result = await store.migrate();
  assert.equal(result.changed, true);
  assert.ok(calls >= 4, `expected a CAS retry, got ${calls} version checks`);
  assert.ok(readFileSync(file, "utf8").includes("[/] legacy"));
});