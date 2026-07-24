import { test } from "node:test";
import assert from "node:assert/strict";
import { Cadence, buildReminder } from "../src/cadence";
import { parseMarkdown } from "../src/markdown";
import { DEFAULT_SETTINGS } from "../src/types";

const S = DEFAULT_SETTINGS;

const DOC = `### A - phase one
status: active

- [/] active item
- [ ] next item
- [x] done item
`;

function phases(md: string = DOC) {
  return parseMarkdown(md).phases;
}

test("buildReminder: null when idle counter below threshold", () => {
  const c = new Cadence();
  const snap = { ...c.snapshot(phases()), turnsSinceTodoTool: 1, hasUsedTodoTool: false };
  assert.equal(buildReminder(snap, S), null);
});

test("buildReminder: empty-list nudge when no open items", () => {
  const md = `### A - phase one
status: done

- [x] done item
`;
  const snap = { phases: parseMarkdown(md).phases, turnsSinceTodoTool: 100, turnsSinceStatusChange: 100, hasUsedTodoTool: false };
  const r = buildReminder(snap, S);
  assert.ok(r);
  assert.ok(r!.includes("No open todos"));
});

test("buildReminder: active cadence is shorter than idle", () => {
  // With an in_progress item, threshold = reminderTurnsActive (3). At turn 3 → nudge.
  const snap = { phases: phases(), turnsSinceTodoTool: 3, turnsSinceStatusChange: 3, hasUsedTodoTool: true };
  const r = buildReminder(snap, S);
  assert.ok(r, "expected a nudge at active threshold");
  assert.ok(r!.includes("active item"));
  assert.ok(r!.includes("next item"));
});

test("buildReminder: idle cadence uses reminderTurns when no in_progress", () => {
  const md = `### A - phase one
status: active

- [ ] pending only
`;
  const snap = { phases: parseMarkdown(md).phases, turnsSinceTodoTool: 5, turnsSinceStatusChange: 5, hasUsedTodoTool: true };
  // threshold = reminderTurns (6), so at 5 → null.
  assert.equal(buildReminder(snap, S), null);
  const snap2 = { ...snap, turnsSinceTodoTool: 6 };
  assert.ok(buildReminder(snap2, S));
});

test("Cadence: onTodoToolCall resets idle counter", () => {
  const c = new Cadence();
  c.onTurnStart();
  c.onTurnStart();
  c.onTodoToolCall();
  assert.equal(c.turnsSinceTodoTool, 0);
  assert.equal(c.hasUsedTodoTool, true);
});

test("Cadence: onStatusChange resets both counters", () => {
  const c = new Cadence();
  c.onTurnStart();
  c.onTurnStart();
  c.onStatusChange();
  assert.equal(c.turnsSinceStatusChange, 0);
  assert.equal(c.turnsSinceTodoTool, 0);
});