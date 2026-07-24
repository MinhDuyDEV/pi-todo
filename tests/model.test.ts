import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addItem,
  completeItem,
  findPhase,
  itemsOf,
  normalizeDoc,
  normalizePhase,
  promoteNext,
  resolveRef,
  setItemStatus,
  similarity,
  startItem,
  moveItem,
  validateDeps,
} from "../src/model";
import type { TodoPhase } from "../src/types";
import { parseMarkdown } from "../src/markdown";

const DOC = `### A - phase one
status: active

- [ ] write tests
- [ ] wire up tool
- [x] scaffold

### B - phase two
status: active

- [/] active item
- [ ] blocked item [blocked by #1]
`;

function phases(): TodoPhase[] {
  return parseMarkdown(DOC).phases;
}

test("resolveRef: fuzzy content match across phases", () => {
  const p = phases();
  const r = resolveRef(p, "wire up the tool");
  assert.ok(r);
  assert.equal(r.item.content, "wire up tool");
});

test("resolveRef: prefers in_progress/pending on ties", () => {
  const r = resolveRef(phases(), "active item");
  assert.ok(r);
  assert.equal(r.item.status, "in_progress");
});

test("resolveRef: #id and numeric index", () => {
  const p = phases();
  // numeric 1-based across whole doc
  assert.equal(resolveRef(p, "1")?.item.content, "write tests");
  assert.equal(resolveRef(p, "4")?.item.content, "active item");
});

test("resolveRef: phase:content scope", () => {
  const r = resolveRef(phases(), "phase two:blocked item");
  assert.ok(r);
  assert.equal(r.item.content, "blocked item");
});

test("findPhase: fuzzy title", () => {
  assert.ok(findPhase(phases(), "phase one"));
  assert.ok(findPhase(phases(), "two"));
  assert.equal(findPhase(phases(), "nope"), null);
});

test("normalizePhase: single-active demotes extra in_progress", () => {
  const p = phases();
  // Make two items in_progress in phase B.
  let next = startItem(p, "blocked item"); // start a second one
  next = startItem(next, "active item"); // start the first one again (should demote the second)
  const b = next.find((x) => x.title.includes("two") || x.title === "B - phase two" || itemsOf(x).some((i) => i.content === "active item"))!;
  const inProg = itemsOf(b).filter((i) => i.status === "in_progress");
  assert.equal(inProg.length, 1);
});

test("normalizePhase: autoPromote promotes first pending when idle", () => {
  const p = phases();
  const one = p[0]!;
  const n = normalizePhase(one, { autoPromote: true });
  // phase one has no in_progress → first pending ("write tests") promoted.
  const it = itemsOf(n).find((i) => i.status === "in_progress");
  assert.ok(it, "expected a promoted item");
  assert.equal(it!.content, "write tests");
});

test("normalizePhase: autoPromote does nothing when an item is in_progress", () => {
  const p = phases();
  const two = p[1]!;
  const n = normalizePhase(two, { autoPromote: true });
  const inProg = itemsOf(n).filter((i) => i.status === "in_progress");
  assert.equal(inProg.length, 1);
});

test("completeItem: marks completed and round-trips", () => {
  const next = completeItem(phases(), "write tests");
  const r = resolveRef(next, "write tests");
  assert.ok(r);
  assert.equal(r!.item.status, "completed");
});

test("addItem: creates missing phase", () => {
  const next = addItem(phases(), "New phase", {
    id: undefined,
    content: "fresh item",
    status: "pending",
    blocks: [],
    blockedBy: [],
  });
  assert.ok(next.some((p) => p.title === "New phase"));
  const created = next.find((p) => p.title === "New phase")!;
  assert.equal(itemsOf(created)[0]!.content, "fresh item");
});

test("startItem: demotes other in_progress in same phase", () => {
  const next = startItem(phases(), "blocked item");
  const b = next.find((p) => itemsOf(p).some((i) => i.content === "active item"))!;
  const inProg = itemsOf(b).filter((i) => i.status === "in_progress");
  assert.equal(inProg.length, 1);
  assert.equal(inProg[0]!.content, "blocked item");
});

test("promoteNext: promotes first pending of first active phase", () => {
  const next = promoteNext(phases());
  const r = resolveRef(next, "write tests");
  assert.equal(r?.item.status, "in_progress");
});

test("normalizeDoc: enforces across all phases immutably", () => {
  const p = phases();
  const n = normalizeDoc(p, { autoPromote: true });
  assert.notEqual(n, p, "should return a new array when changed");
  // phase one now has an in_progress; phase two keeps its single one.
  assert.equal(itemsOf(n[0]!).some((i) => i.status === "in_progress"), true);
});

test("similarity: exact > substring > token overlap", () => {
  assert.equal(similarity("wire up tool", "wire up tool"), 1);
  assert.ok(similarity("wire up tool", "wire up tool") > similarity("wire up tool", "wire up"));
  assert.ok(similarity("wire up the tool", "wire up tool") > 0);
  assert.equal(similarity("completely different", "wire up tool"), 0);
});

test("validateDeps: detects dangling ref", () => {
  const issues = validateDeps(phases());
  // "blocked item" is blocked by #1, but no item has id #1 → dangling.
  assert.ok(issues.some((i) => i.kind === "dangling" && i.missing === "#1"));
});

test("validateDeps: detects a cycle", () => {
  const p = parseMarkdown(
    `### C
status: active

- [x] (#1) a [blocks #2]
- [x] (#2) b [blocks #1]
`,
  ).phases;
  const issues = validateDeps(p);
  assert.ok(issues.some((i) => i.kind === "cycle"));
});

// ---- regression tests for adversarial model review findings ----

test("promoteNext: no-op when an in_progress already exists (no second active)", () => {
  const p = parseMarkdown(
    `### C
status: active

- [/] (#1) a
- [ ] (#2) b
`,
  ).phases;
  const next = promoteNext(p, "C");
  const r = resolveRef(next, "b");
  assert.equal(r?.item.status, "pending", "must not promote a second in_progress");
});

test("setItemStatus(in_progress): demotes the prior in_progress (not bypassed)", () => {
  const p = parseMarkdown(
    `### C
status: active

- [/] (#1) a
- [ ] (#2) b
`,
  ).phases;
  const next = setItemStatus(p, "b", "in_progress");
  const a = resolveRef(next, "a");
  const b = resolveRef(next, "b");
  assert.equal(b?.item.status, "in_progress");
  assert.equal(a?.item.status, "pending", "prior in_progress must be demoted, not kept alongside");
});

test("addItem: cross-phase afterRef appends instead of using the wrong phase's index", () => {
  const p = parseMarkdown(
    `### One
status: active

- [x] (#3) marker

### Two
status: active

- [ ] (#4) other
`,
  ).phases;
  const next = addItem(p, "One", { id: undefined, content: "new-in-one", status: "pending", blocks: [], blockedBy: [] }, "#3");
  const one = next.find((pp) => pp.title === "One")!;
  const titles = one.body.filter((e) => e.type === "item").map((e) => (e as { item: { content: string } }).item.content);
  // #3 lives in... wait #3 is in One. Use a ref in Two to test cross-phase.
  const next2 = addItem(p, "One", { id: undefined, content: "new2", status: "pending", blocks: [], blockedBy: [] }, "#4");
  const one2 = next2.find((pp) => pp.title === "One")!;
  const titles2 = one2.body.filter((e) => e.type === "item").map((e) => (e as { item: { content: string } }).item.content);
  assert.deepEqual(titles, ["marker", "new-in-one"], "afterRef in same phase inserts after it");
  assert.deepEqual(titles2, ["marker", "new2"], "afterRef in a DIFFERENT phase appends to the target phase (no wrong-index splice)");
});

test("moveItem: same-phase move is a no-op (not relocated to end)", () => {
  const p = parseMarkdown(
    `### C
status: active

- [x] (#1) aaa
- [x] (#2) bbb
- [x] (#3) ccc
`,
  ).phases;
  const next = moveItem(p, "#1", "C");
  const titles = next[0]!.body.filter((e) => e.type === "item").map((e) => (e as { item: { content: string } }).item.content);
  assert.deepEqual(titles, ["aaa", "bbb", "ccc"], "same-phase move must not reorder");
});

test("validateDeps: content cycle with case/punctuation is detected (normalized edges)", () => {
  const p = parseMarkdown(
    `### C
status: active

- [x] Alpha [blocks Beta]
- [x] Beta [blocks Alpha]
`,
  ).phases;
  const issues = validateDeps(p);
  assert.ok(issues.some((i) => i.kind === "cycle"), "content cycle with case must be detected");
});

test("validateDeps: a ref that resolvesRef matches (fuzzy) is NOT flagged dangling", () => {
  const p = parseMarkdown(
    `### C
status: active

- [x] (#1) wire up tool
- [x] (#2) other [blocks #1]
`,
  ).phases;
  const issues = validateDeps(p);
  assert.ok(!issues.some((i) => i.kind === "dangling"), "#1 resolves, must not be dangling");
});

test("dfsCycle: the reported cycle path is a valid walk (no duplicated start)", () => {
  const p = parseMarkdown(
    `### C
status: active

- [x] (#1) a [blocks #2]
- [x] (#2) b [blocks #1]
`,
  ).phases;
  const issues = validateDeps(p);
  const cycle = issues.find((i) => i.kind === "cycle") as { path: string[] } | undefined;
  assert.ok(cycle, "cycle detected");
  // path should be a valid walk closing the cycle, e.g. ["#1","#2","#1"], not ["#1","#2","#1","#1"]
  const path = cycle!.path;
  assert.equal(path[0], path[path.length - 1], "cycle path should close at start");
  assert.equal(path.length, 3, "2-cycle path should have 3 nodes (a→b→a), not 4");
});

test("similarity: needle-superset matches (token overlap, no 0.75 gate)", () => {
  assert.ok(similarity("do it", "do it now") > 0, "needle-superset should match via token overlap");
  assert.ok(similarity("do it now", "do it") > 0, "substring direction still matches");
});