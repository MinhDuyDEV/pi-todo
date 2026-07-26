import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown, serializeMarkdown, parseItemLine } from "../src/markdown.js";
import { itemsOf } from "../src/model.js";

const SAMPLE = `# Notes

### 2026-07-24 - Refactor auth
status: active
updated: 2026-07-25

- [ ] pending item
- [/] in_progress item
- [x] completed item
- [-] abandoned item
- [!] blocked item [blocked by #2]
- [/] (#3) wire up token refresh [blocks #5]
some prose note here

### Done thing
status: done

- [x] shipped
`;

test("parseMarkdown: headers + meta + items + notes + preamble", () => {
  const doc = parseMarkdown(SAMPLE);
  assert.equal(doc.preamble.length, 2);
  assert.equal(doc.preamble[0], "# Notes");
  assert.equal(doc.phases.length, 2);
  const p0 = doc.phases[0]!;
  assert.equal(p0.title, "Refactor auth");
  assert.equal(p0.date, "2026-07-24");
  assert.equal(p0.status, "active");
  assert.equal(p0.updated, "2026-07-25");
  const items = itemsOf(p0);
  assert.equal(items.length, 6);
  assert.equal(items[0]!.status, "pending");
  assert.equal(items[1]!.status, "in_progress");
  assert.equal(items[2]!.status, "completed");
  assert.equal(items[3]!.status, "abandoned");
  assert.equal(items[4]!.status, "blocked");
  assert.deepEqual(items[4]!.blockedBy, ["#2"]);
  assert.equal(items[5]!.id, "#3");
  assert.deepEqual(items[5]!.blocks, ["#5"]);
  // prose note preserved
  assert.ok(p0.body.some((e) => e.type === "note" && e.text.includes("some prose note")));
});

test("parseMarkdown: defaults status to active and title without date", () => {
  const doc = parseMarkdown(`### Bare title\n- [x] done\n`);
  assert.equal(doc.phases[0]!.title, "Bare title");
  assert.equal(doc.phases[0]!.status, "active");
  assert.equal(doc.phases[0]!.date, undefined);
});

test("serializeMarkdown: round-trip is idempotent", () => {
  const once = serializeMarkdown(parseMarkdown(SAMPLE));
  const twice = serializeMarkdown(parseMarkdown(once));
  assert.equal(once, twice);
});

test("serializeMarkdown: round-trip preserves content + ids + deps", () => {
  const out = serializeMarkdown(parseMarkdown(SAMPLE));
  assert.ok(out.includes("- [/] (#3) wire up token refresh [blocks #5]"));
  assert.ok(out.includes("- [!] blocked item [blocked by #2]"));
  assert.ok(out.includes("some prose note here"));
  assert.ok(out.startsWith("# Notes"));
  assert.ok(out.includes("### 2026-07-24 - Refactor auth"));
});

test("parseItemLine: accepts oh-my-pi aliases (>, ~)", () => {
  assert.equal(parseItemLine("- > running")!.status, "in_progress");
  assert.equal(parseItemLine("* ~ dropped")!.status, "abandoned");
  assert.equal(parseItemLine("- [X] uppercase x")!.status, "completed");
  assert.equal(parseItemLine("not an item"), null);
});

test("parseItemLine: blocker note round-trips", () => {
  const it = parseItemLine("- [!] stuck (note: upstream bug)")!;
  assert.equal(it.status, "blocked");
  assert.equal(it.blockerNote, "upstream bug");
  assert.equal(it.content, "stuck");
});

test("round-trip: backwards-compatible with plain [ ]/[x]", () => {
  const md = `### T
status: active

- [ ] one
- [x] two
`;
  const doc = parseMarkdown(md);
  const firstItem = doc.phases[0]!.body.find((e): e is Extract<typeof e, { type: "item" }> => e.type === "item")!;
  assert.equal(firstItem.item.content, "one");
  const out = serializeMarkdown(doc);
  assert.ok(out.includes("- [ ] one"));
  assert.ok(out.includes("- [x] two"));
});

test("combined meta: `status: X | updated: Y` is the canonical pi-harness form", () => {
  const md = `### 2026-07-23 - Fix rate limit
status: done | updated: 2026-07-23

- [x] step 1
`;
  const doc = parseMarkdown(md);
  assert.equal(doc.phases[0]!.status, "done");
  assert.equal(doc.phases[0]!.updated, "2026-07-23");
  const out = serializeMarkdown(doc);
  assert.ok(out.includes("status: done | updated: 2026-07-23"));
  // idempotent
  assert.equal(serializeMarkdown(parseMarkdown(out)), out);
});

test("combined meta: idempotent across multiple phases", () => {
  const md = `### A - one
status: active | updated: 2026-07-23

- [ ] a

### B - two
status: done | updated: 2026-07-24

- [x] b
`;
  const once = serializeMarkdown(parseMarkdown(md));
  const twice = serializeMarkdown(parseMarkdown(once));
  assert.equal(once, twice);
});

test("annotation strip: >8 annotations stay idempotent (document order)", () => {
  const md = `### P
status: active

- [!] a [blocked by #9] [blocked by #8] [blocked by #7] [blocked by #6] [blocked by #5] [blocked by #4] [blocked by #3] [blocked by #2] [blocked by #1]
`;
  const once = serializeMarkdown(parseMarkdown(md));
  const twice = serializeMarkdown(parseMarkdown(once));
  assert.equal(once, twice, "once !== twice breaks idempotence");
  // all 9 refs survive in document order
  const doc = parseMarkdown(once);
  const item = doc.phases[0]!.body.find((e): e is Extract<typeof e, { type: "item" }> => e.type === "item")!;
  assert.equal(item.item.blockedBy.length, 9);
});

test("unrecognized status line kept as note, no spurious default injected", () => {
  const md = `### P
status: paused

- [ ] a
`;
  const out = serializeMarkdown(parseMarkdown(md));
  // The original `status: paused` must be preserved (as a note); no duplicate `status: active`.
  assert.ok(out.includes("status: paused"));
  assert.ok(!out.includes("status: active"));
  // idempotent
  assert.equal(serializeMarkdown(parseMarkdown(out)), out);
});