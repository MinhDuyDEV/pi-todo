import { test } from "node:test";
import assert from "node:assert/strict";
import { SubagentTracker, wireSubagents, classifyTaskEnd, TASK_TOOL_NAME } from "../src/subagents";
import { TodoStore } from "../src/store";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OTHER = "not-the-task-tool";

test("SubagentTracker: descriptions reflect in-flight calls", () => {
  const t = new SubagentTracker();
  assert.deepEqual(t.descriptions, []);
  t.onStarted("a", "write tests");
  t.onStarted("b", "build feature");
  assert.deepEqual(t.descriptions, ["write tests", "build feature"]);
  assert.equal(t.onSettled("a"), "write tests");
  assert.deepEqual(t.descriptions, ["build feature"]);
  t.clear();
  assert.deepEqual(t.descriptions, []);
});

test("classifyTaskEnd: done→success; failed/verification_failed/isError→failure; running/scheduled→nonterminal", () => {
  assert.equal(classifyTaskEnd({ isError: true, result: {} }), "failure");
  assert.equal(classifyTaskEnd({ isError: false, result: { details: { phase: "failed" } } }), "failure");
  assert.equal(classifyTaskEnd({ isError: false, result: { details: { phase: "verification_failed" } } }), "failure");
  assert.equal(classifyTaskEnd({ isError: false, result: { details: { phase: "done" } } }), "success");
  assert.equal(classifyTaskEnd({ isError: false, result: { details: { phase: "running" } } }), "nonterminal");
  assert.equal(classifyTaskEnd({ isError: false, result: { details: { phase: "scheduled" } } }), "nonterminal");
  assert.equal(classifyTaskEnd({ isError: false, result: { details: {} } }), "nonterminal");
  assert.equal(classifyTaskEnd({ isError: false, result: undefined }), "nonterminal");
});

// A minimal fake Pi with .on(event, handler) that lets us dispatch events.
function fakePi() {
  const handlers = new Map<string, ((e: unknown) => unknown)[]>();
  return {
    events: { on: () => () => {} },
    on: (event: string, h: (e: unknown) => unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(h);
      handlers.set(event, list);
      return () => {
        const l = handlers.get(event);
        if (l) handlers.set(event, l.filter((x) => x !== h));
      };
    },
    dispatch: (event: string, e: unknown) => {
      for (const h of handlers.get(event) ?? []) h(e);
    },
  };
}

function setupStore(doc: string): TodoStore {
  const dir = mkdtempSync(join(tmpdir(), "pi-todo-sub-"));
  const file = join(dir, "TODO.md");
  writeFileSync(file, doc, "utf8");
  return new TodoStore(file);
}

const DOC = `### A - sprint
status: active

- [/] write tests
- [ ] build feature
`;

test("wireSubagents: ignores non-task tools", async () => {
  const pi = fakePi();
  const store = setupStore(DOC);
  let activity = 0;
  const reconciler = { reconcileSubagent: (d: string, ok: boolean) => store.reconcileSubagent(d, ok) };
  const unwind = wireSubagents(pi as never, new SubagentTracker(), reconciler, { reconcile: true, onActivity: () => activity++ });
  // a different tool starts and ends — should be ignored
  pi.dispatch("tool_execution_start", { toolCallId: "1", toolName: OTHER, args: { description: "write tests" } });
  pi.dispatch("tool_execution_end", { toolCallId: "1", toolName: OTHER, result: {}, isError: false });
  assert.equal(activity, 0, "non-task tools must not trigger activity");
  const it = store.get().phases[0]!.body.find((e): e is Extract<typeof e, { type: "item" }> => e.type === "item" && e.item.content === "write tests")!;
  assert.equal(it.item.status, "in_progress", "unrelated tool end must not reconcile");
  unwind();
});

test("wireSubagents: matched lighting tracks the task tool while in flight", async () => {
  const pi = fakePi();
  const tracker = new SubagentTracker();
  const unwind = wireSubagents(pi as never, tracker, { reconcileSubagent: () => Promise.resolve(false) }, { reconcile: false });
  pi.dispatch("tool_execution_start", { toolCallId: "1", toolName: TASK_TOOL_NAME, args: { description: "build the feature" } });
  assert.deepEqual(tracker.descriptions, ["build the feature"]);
  pi.dispatch("tool_execution_end", { toolCallId: "1", toolName: TASK_TOOL_NAME, result: { details: { phase: "completed" } }, isError: false });
  assert.deepEqual(tracker.descriptions, [], "settled call should leave the active set");
  unwind();
});

// Poll for a condition (reconcile is async via the store mutex; a fixed wait is flaky).
async function waitFor<T>(fn: () => T, check: (v: T) => boolean, timeoutMs = 500): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (check(v)) return v;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("wireSubagents: success reconciles matching item → completed", async () => {
  const pi = fakePi();
  const store = setupStore(DOC);
  const reconciler = { reconcileSubagent: (d: string, ok: boolean) => store.reconcileSubagent(d, ok) };
  const unwind = wireSubagents(pi as never, new SubagentTracker(), reconciler, { reconcile: true });
  pi.dispatch("tool_execution_start", { toolCallId: "1", toolName: TASK_TOOL_NAME, args: { description: "write the tests" } });
  pi.dispatch("tool_execution_end", { toolCallId: "1", toolName: TASK_TOOL_NAME, result: { details: { phase: "done" } }, isError: false });
  const it = await waitFor(
    () => store.get().phases[0]!.body.find((e): e is Extract<typeof e, { type: "item" }> => e.type === "item" && e.item.content === "write tests"),
    (e) => !!e && e.item.status === "completed",
  );
  assert.equal(it!.item.status, "completed");
  unwind();
});

test("wireSubagents: background task (phase running) does NOT reconcile (no false completion at launch)", async () => {
  const pi = fakePi();
  const store = setupStore(DOC);
  const reconciler = { reconcileSubagent: (d: string, ok: boolean) => store.reconcileSubagent(d, ok) };
  const tracker = new SubagentTracker();
  const unwind = wireSubagents(pi as never, tracker, reconciler, { reconcile: true });
  pi.dispatch("tool_execution_start", { toolCallId: "1", toolName: TASK_TOOL_NAME, args: { description: "write the tests" } });
  // Background tasks return immediately with phase "running" (final result comes later)
  pi.dispatch("tool_execution_end", { toolCallId: "1", toolName: TASK_TOOL_NAME, result: { details: { phase: "running" } }, isError: false });
  // Give any (incorrect) reconcile a chance to fire, then assert it didn't.
  await new Promise((r) => setTimeout(r, 30));
  const it = store.get().phases[0]!.body.find((e): e is Extract<typeof e, { type: "item" }> => e.type === "item" && e.item.content === "write tests")!;
  assert.notEqual(it.item.status, "completed", "background task must NOT be marked completed at launch");
  assert.deepEqual(tracker.descriptions, [], "background task unlit after its immediate end (no perpetual spinner)");
  unwind();
});

test("wireSubagents: cleanup clears the tracker (no pi.on unsub exists)", () => {
  const pi = fakePi();
  const tracker = new SubagentTracker();
  const unwind = wireSubagents(pi as never, tracker, { reconcileSubagent: () => Promise.resolve(false) }, { reconcile: false });
  tracker.onStarted("x", "running thing");
  assert.equal(tracker.descriptions.length, 1);
  unwind(); // must not throw (pi.on returns void — no unsub to call)
  assert.equal(tracker.descriptions.length, 0, "cleanup clears the tracker");
});

test("wireSubagents: failure reconciles matching item → pending + note", async () => {
  const pi = fakePi();
  const store = setupStore(DOC);
  const reconciler = { reconcileSubagent: (d: string, ok: boolean, note?: string) => store.reconcileSubagent(d, ok, note) };
  const unwind = wireSubagents(pi as never, new SubagentTracker(), reconciler, { reconcile: true });
  pi.dispatch("tool_execution_start", { toolCallId: "1", toolName: TASK_TOOL_NAME, args: { description: "build the feature" } });
  pi.dispatch("tool_execution_end", { toolCallId: "1", toolName: TASK_TOOL_NAME, result: { details: { phase: "failed", error: "boom" } }, isError: false });
  const it = await waitFor(
    () => store.get().phases[0]!.body.find((e): e is Extract<typeof e, { type: "item" }> => e.type === "item" && e.item.content === "build feature"),
    (e) => !!e && e.item.status === "pending" && e.item.blockerNote === "boom",
  );
  assert.equal(it!.item.status, "pending");
  assert.equal(it!.item.blockerNote, "boom");
  unwind();
});