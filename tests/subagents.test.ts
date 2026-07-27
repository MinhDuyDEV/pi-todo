import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SubagentTracker,
  wireSubagents,
  classifyTaskEnd,
  classifyLifecycleSettlement,
  TASK_STARTED_EVENT,
  TASK_SETTLED_EVENT,
  TASK_TOOL_NAME,
  type TaskSettledEventV1,
} from "../src/subagents.js";
import { TodoStore } from "../src/store.js";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
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
  assert.equal(
    classifyTaskEnd({ isError: false, result: { details: { phase: "done", error: "late failure" } } }),
    "failure",
    "a contradictory error must fail closed even when phase says done",
  );
  assert.equal(classifyTaskEnd({ isError: false, result: { details: { phase: "done" } } }), "success");
  assert.equal(classifyTaskEnd({ isError: false, result: { details: { phase: "running" } } }), "nonterminal");
  assert.equal(classifyTaskEnd({ isError: false, result: { details: { phase: "scheduled" } } }), "nonterminal");
  assert.equal(classifyTaskEnd({ isError: false, result: { details: {} } }), "nonterminal");
  assert.equal(classifyTaskEnd({ isError: false, result: undefined }), "nonterminal");
});

// A minimal fake Pi with .on(event, handler) that lets us dispatch events.
function fakePi() {
  const handlers = new Map<string, ((e: unknown) => unknown)[]>();
  const busHandlers = new Map<string, ((e: unknown) => unknown)[]>();
  return {
    events: {
      on: (event: string, h: (e: unknown) => unknown) => {
        const list = busHandlers.get(event) ?? [];
        list.push(h);
        busHandlers.set(event, list);
        return () => busHandlers.set(event, (busHandlers.get(event) ?? []).filter((x) => x !== h));
      },
      emit: (event: string, e: unknown) => {
        for (const h of busHandlers.get(event) ?? []) h(e);
      },
    },
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

function started(taskId: string, description = "write the tests") {
  return {
    protocolVersion: 1 as const,
    taskId,
    invocationId: `inv-${taskId}`,
    description,
    timestamp: "2026-07-27T00:00:00.000Z",
  };
}

function settled(
  taskId: string,
  terminalOutcome: TaskSettledEventV1["terminalOutcome"],
  reportedOutcome: TaskSettledEventV1["reportedOutcome"],
  issues: string[] = [],
): TaskSettledEventV1 {
  return {
    protocolVersion: 1,
    taskId,
    terminalOutcome,
    reportedOutcome,
    ...(terminalOutcome === "failure"
      ? { executionPhase: "failed" as const }
      : terminalOutcome === "cancelled"
        ? { executionPhase: "cancelled" as const }
        : terminalOutcome === "timeout"
          ? { executionPhase: "timeout" as const }
          : terminalOutcome === "awaiting-decision"
            ? {}
            : { executionPhase: "completed" as const }),
    ...(reportedOutcome === "success"
      ? { verificationPassed: terminalOutcome === "success" }
      : {}),
    awaitingReview: false,
    issues,
    ...(terminalOutcome === "awaiting-decision" ? { decisionId: `decision-${taskId}` } : {}),
    timestamp: "2026-07-27T00:01:00.000Z",
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
  const unwind = wireSubagents(pi as never, tracker, { reconcileSubagent: () => Promise.resolve("unmatched") }, { reconcile: false });
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

test("wireSubagents: native fallback reconciliation rejects without an unhandled promise", async () => {
  const pi = fakePi();
  let attempts = 0;
  let activity = 0;
  wireSubagents(pi as never, new SubagentTracker(), {
    async reconcileSubagent() {
      attempts += 1;
      throw new Error("temporary native TODO failure");
    },
  }, { reconcile: true, onActivity: () => activity++ });
  pi.dispatch("tool_execution_start", {
    toolCallId: "native-reject",
    toolName: TASK_TOOL_NAME,
    args: { description: "write the tests" },
  });
  pi.dispatch("tool_execution_end", {
    toolCallId: "native-reject",
    toolName: TASK_TOOL_NAME,
    result: { details: { phase: "done" } },
    isError: false,
  });
  await waitFor(() => attempts, (count) => count === 1);
  assert.ok(activity >= 3, "start, end, and rejection should all notify activity");
});

test("wireSubagents: cleanup clears the tracker (no pi.on unsub exists)", () => {
  const pi = fakePi();
  const tracker = new SubagentTracker();
  const unwind = wireSubagents(pi as never, tracker, { reconcileSubagent: () => Promise.resolve("unmatched") }, { reconcile: false });
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

test("classifyLifecycleSettlement: only explicit terminal + reported semantic success completes", () => {
  assert.equal(classifyLifecycleSettlement(settled("ok", "success", "success")), "success");
  assert.equal(classifyLifecycleSettlement(settled("partial", "partial", "partial")), "failure");
  assert.equal(classifyLifecycleSettlement(settled("blocked", "blocked", "blocked")), "failure");
  assert.equal(classifyLifecycleSettlement(settled("decision", "awaiting-decision", "awaiting-decision")), "nonterminal");
  assert.equal(classifyLifecycleSettlement({
    ...settled("review", "success", "success"),
    awaitingReview: true,
  }), "nonterminal", "a pending review is not settled success");
  assert.equal(classifyLifecycleSettlement({
    ...settled("bad-proof", "success", "success"),
    verificationPassed: false,
  }), "failure", "explicit verification failure cannot complete a TODO");
  assert.equal(classifyLifecycleSettlement({
    ...settled("unknown", "unknown", "unknown"),
    executionPhase: undefined,
    verificationPassed: undefined,
  }), "failure", "a terminal unknown result must clear/revert, never remain active forever");
  assert.equal(classifyLifecycleSettlement({
    ...settled("contradictory-phase", "success", "success"),
    executionPhase: "failed",
  }), "failure", "execution failure cannot be hidden by semantic success fields");
  assert.equal(classifyLifecycleSettlement({
    ...settled("contradictory-review", "failure", "failure"),
    awaitingReview: true,
  }), "failure", "a failed task cannot be kept nonterminal by a contradictory review flag");
});

test("wireSubagents: typed background settlement reconciles by task id", async () => {
  const pi = fakePi();
  const store = setupStore(DOC);
  const reconciler = { reconcileSubagent: (d: string, ok: boolean) => store.reconcileSubagent(d, ok) };
  const tracker = new SubagentTracker();
  const unwind = wireSubagents(pi as never, tracker, reconciler, { reconcile: true });

  pi.events.emit(TASK_STARTED_EVENT, started("task-1"));
  assert.deepEqual(tracker.descriptions, ["write the tests"]);
  pi.events.emit(TASK_SETTLED_EVENT, settled("task-1", "success", "success"));

  const item = await waitFor(
    () => store.get().phases[0]!.body.find((e): e is Extract<typeof e, { type: "item" }> => e.type === "item" && e.item.content === "write tests"),
    (entry) => !!entry && entry.item.status === "completed",
  );
  assert.equal(item!.item.status, "completed");
  await waitFor(() => tracker.descriptions.length, (count) => count === 0);
  assert.deepEqual(tracker.descriptions, []);
  unwind();
});

test("wireSubagents: partial/blocked task never completes a TODO and duplicate settle is idempotent", async () => {
  const pi = fakePi();
  const calls: Array<{ description: string; success: boolean; note?: string }> = [];
  const reconciler = {
    async reconcileSubagent(description: string, success: boolean, note?: string) {
      calls.push({ description, success, note });
      return "applied" as const;
    },
  };
  wireSubagents(pi as never, new SubagentTracker(), reconciler, { reconcile: true });
  pi.events.emit(TASK_STARTED_EVENT, started("task-partial", "build feature"));
  const event = settled("task-partial", "partial", "partial", ["coverage incomplete"]);
  pi.events.emit(TASK_SETTLED_EVENT, event);
  pi.events.emit(TASK_SETTLED_EVENT, event);
  await waitFor(() => calls.length, (count) => count === 1);
  assert.deepEqual(calls, [{ description: "build feature", success: false, note: "coverage incomplete" }]);
});

test("wireSubagents: conflicting terminal replay keeps the first durable outcome", async () => {
  const pi = fakePi();
  const outcomes: boolean[] = [];
  wireSubagents(pi as never, new SubagentTracker(), {
    async reconcileSubagent(_description, success) {
      outcomes.push(success);
      return "applied" as const;
    },
  }, { reconcile: true });
  pi.events.emit(TASK_STARTED_EVENT, started("conflict", "build feature"));
  pi.events.emit(TASK_SETTLED_EVENT, settled("conflict", "partial", "partial", ["not ready"]));
  // Same task id with a contradictory terminal payload must not override the
  // first event or trigger a second TODO mutation.
  pi.events.emit(TASK_SETTLED_EVENT, settled("conflict", "success", "success"));
  await waitFor(() => outcomes.length, (count) => count === 1);
  assert.deepEqual(outcomes, [false]);
});

test("wireSubagents: out-of-order settle is retained until typed start supplies the description", async () => {
  const pi = fakePi();
  const calls: string[] = [];
  wireSubagents(pi as never, new SubagentTracker(), {
    async reconcileSubagent(description) { calls.push(description); return "applied" as const; },
  }, { reconcile: true });
  pi.events.emit(TASK_SETTLED_EVENT, settled("late-start", "success", "success"));
  assert.deepEqual(calls, []);
  pi.events.emit(TASK_STARTED_EVENT, started("late-start", "build feature"));
  await waitFor(() => calls.length, (count) => count === 1);
  assert.deepEqual(calls, ["build feature"]);
});

test("wireSubagents: typed lifecycle owns a call and suppresses duplicate native fallback", async () => {
  const pi = fakePi();
  const calls: boolean[] = [];
  wireSubagents(pi as never, new SubagentTracker(), {
    async reconcileSubagent(_description, success) { calls.push(success); return "applied" as const; },
  }, { reconcile: true });

  pi.dispatch("tool_execution_start", {
    toolCallId: "native-1",
    toolName: TASK_TOOL_NAME,
    args: { description: "build feature" },
  });
  pi.events.emit(TASK_STARTED_EVENT, started("typed-1", "build feature"));
  pi.events.emit(TASK_SETTLED_EVENT, settled("typed-1", "success", "success"));
  pi.dispatch("tool_execution_end", {
    toolCallId: "native-1",
    toolName: TASK_TOOL_NAME,
    result: { details: { phase: "done" } },
    isError: false,
  });

  await waitFor(() => calls.length, (count) => count === 1);
  assert.deepEqual(calls, [true]);
});

test("wireSubagents: typed-first event ordering also suppresses native fallback", async () => {
  const pi = fakePi();
  const calls: boolean[] = [];
  wireSubagents(pi as never, new SubagentTracker(), {
    async reconcileSubagent(_description, success) {
      calls.push(success);
      return "applied" as const;
    },
  }, { reconcile: true });

  pi.events.emit(TASK_STARTED_EVENT, started("typed-first", "build feature"));
  pi.dispatch("tool_execution_start", {
    toolCallId: "native-after-typed",
    toolName: TASK_TOOL_NAME,
    args: { description: "build feature" },
  });
  pi.events.emit(TASK_SETTLED_EVENT, settled("typed-first", "success", "success"));
  pi.dispatch("tool_execution_end", {
    toolCallId: "native-after-typed",
    toolName: TASK_TOOL_NAME,
    result: { details: { phase: "done" } },
    isError: false,
  });

  await waitFor(() => calls.length, (count) => count === 1);
  assert.deepEqual(calls, [true]);
});

test("wireSubagents: malformed legacy settlement without semantic outcomes is ignored", () => {
  const pi = fakePi();
  const calls: boolean[] = [];
  const tracker = new SubagentTracker();
  wireSubagents(pi as never, tracker, {
    async reconcileSubagent(_description, success) { calls.push(success); return "applied" as const; },
  }, { reconcile: true });
  pi.events.emit(TASK_STARTED_EVENT, started("legacy", "build feature"));
  pi.events.emit(TASK_SETTLED_EVENT, {
    protocolVersion: 1,
    taskId: "legacy",
    executionPhase: "completed",
    verificationPassed: true,
    awaitingReview: false,
    issues: [],
    timestamp: "2026-07-27T00:01:00.000Z",
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(tracker.descriptions, ["build feature"]);
});

test("SubagentTracker: typed lifecycle correlation survives process restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-todo-tracker-"));
  const statePath = join(dir, "subagent-tasks.json");
  const first = new SubagentTracker(statePath);
  first.onLifecycleStarted(started("durable", "build feature"));

  const restored = new SubagentTracker(statePath);
  assert.deepEqual(restored.descriptions, ["build feature"]);
  const result = restored.onLifecycleSettled(settled("durable", "success", "success"));
  assert.equal(result.description, "build feature");
  assert.equal(result.duplicate, false);
  restored.completeReconciliation("durable");

  const afterSettle = new SubagentTracker(statePath);
  assert.deepEqual(afterSettle.descriptions, []);
  assert.equal(afterSettle.onLifecycleSettled(settled("durable", "success", "success")).duplicate, true);
});

test("SubagentTracker: failed reconciliation remains durable and retries after restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-todo-tracker-retry-"));
  const statePath = join(dir, "subagent-tasks.json");
  const firstPi = fakePi();
  const firstTracker = new SubagentTracker(statePath);
  let attempts = 0;
  wireSubagents(firstPi as never, firstTracker, {
    async reconcileSubagent() {
      attempts += 1;
      throw new Error("transient TODO write failure");
    },
  }, { reconcile: true });
  firstPi.events.emit(TASK_STARTED_EVENT, started("retry-task", "build feature"));
  firstPi.events.emit(TASK_SETTLED_EVENT, settled("retry-task", "success", "success"));
  await waitFor(() => attempts, (count) => count === 1);
  assert.deepEqual(firstTracker.descriptions, ["build feature"], "failed work remains recoverable");

  const secondPi = fakePi();
  const restored = new SubagentTracker(statePath);
  let recovered = 0;
  wireSubagents(secondPi as never, restored, {
    async reconcileSubagent(description, success) {
      recovered += 1;
      assert.equal(description, "build feature");
      assert.equal(success, true);
      return "applied" as const;
    },
  }, { reconcile: true });
  await waitFor(() => recovered, (count) => count === 1);
  await waitFor(() => restored.descriptions.length, (count) => count === 0);
  assert.equal(new SubagentTracker(statePath).descriptions.length, 0);
});

test("SubagentTracker: unmatched reconciliation is not acknowledged and retries after restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-todo-tracker-unmatched-"));
  const statePath = join(dir, "subagent-tasks.json");
  const firstPi = fakePi();
  const firstTracker = new SubagentTracker(statePath);
  let firstAttempts = 0;
  wireSubagents(firstPi as never, firstTracker, {
    async reconcileSubagent() {
      firstAttempts += 1;
      return "unmatched" as const;
    },
  }, { reconcile: true });
  firstPi.events.emit(TASK_STARTED_EVENT, started("unmatched-task", "not in TODO yet"));
  firstPi.events.emit(TASK_SETTLED_EVENT, settled("unmatched-task", "success", "success"));
  await waitFor(() => firstAttempts, (count) => count === 1);
  assert.deepEqual(firstTracker.descriptions, ["not in TODO yet"]);

  const secondPi = fakePi();
  const restored = new SubagentTracker(statePath);
  let recovered = 0;
  wireSubagents(secondPi as never, restored, {
    async reconcileSubagent() {
      recovered += 1;
      return "applied" as const;
    },
  }, { reconcile: true });
  await waitFor(() => recovered, (count) => count === 1);
  await waitFor(() => restored.descriptions.length, (count) => count === 0);
});

test("SubagentTracker: crash after TODO write replays as already-applied and acknowledges", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-todo-tracker-post-write-"));
  const statePath = join(dir, "subagent-tasks.json");
  const tracker = new SubagentTracker(statePath);
  const store = setupStore(DOC);
  tracker.onLifecycleStarted(started("post-write", "build feature"));
  tracker.onLifecycleSettled(settled("post-write", "success", "success"));
  assert.equal(
    await store.reconcileSubagent("build feature", true),
    "applied",
  );
  // Simulate process loss before tracker.completeReconciliation().
  const restored = new SubagentTracker(statePath);
  wireSubagents(fakePi() as never, restored, {
    reconcileSubagent: (description, success, note) =>
      store.reconcileSubagent(description, success, note),
  }, { reconcile: true });
  await waitFor(() => restored.descriptions.length, (count) => count === 0);
  assert.equal(
    await store.reconcileSubagent("build feature", true),
    "already-applied",
  );
});

test("SubagentTracker: stale instances merge under the durable-state lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-todo-tracker-merge-"));
  const statePath = join(dir, "subagent-tasks.json");
  const first = new SubagentTracker(statePath);
  const staleSecond = new SubagentTracker(statePath);

  first.onLifecycleStarted(started("merge-a", "task A"));
  staleSecond.onLifecycleStarted(started("merge-b", "task B"));

  const restored = new SubagentTracker(statePath);
  assert.deepEqual(restored.descriptions.sort(), ["task A", "task B"]);
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.includes(".tmp-")),
    [],
    "durable atomic tracker writes must not leak temp files",
  );
});

test("SubagentTracker: optional description can arrive after terminal settlement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-todo-tracker-description-"));
  const statePath = join(dir, "subagent-tasks.json");
  const noDescription = {
    protocolVersion: 1 as const,
    taskId: "late-description",
    invocationId: "inv-late-description",
    timestamp: "2026-07-27T00:00:00.000Z",
  };
  const tracker = new SubagentTracker(statePath);
  tracker.onLifecycleStarted(noDescription);
  tracker.onLifecycleSettled(settled("late-description", "success", "success"));

  const pi = fakePi();
  const restored = new SubagentTracker(statePath);
  let reconciled = 0;
  wireSubagents(pi as never, restored, {
    async reconcileSubagent(description) {
      assert.equal(description, "build feature");
      reconciled += 1;
      return "applied" as const;
    },
  }, { reconcile: true });
  assert.deepEqual(restored.descriptions, []);
  pi.events.emit(TASK_STARTED_EVENT, started("late-description", "build feature"));
  await waitFor(() => reconciled, (count) => count === 1);
  await waitFor(() => restored.descriptions.length, (count) => count === 0);
});

test("SubagentTracker: opaque task ids cannot collide with Object.prototype", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-todo-tracker-opaque-id-"));
  const statePath = join(dir, "subagent-tasks.json");
  const tracker = new SubagentTracker(statePath);
  tracker.onLifecycleStarted(started("__proto__", "prototype task"));
  tracker.onLifecycleStarted(started("toString", "string task"));

  const restored = new SubagentTracker(statePath);
  assert.deepEqual(restored.descriptions.sort(), ["prototype task", "string task"]);
  assert.equal(
    restored.onLifecycleSettled(settled("__proto__", "success", "success")).duplicate,
    false,
  );
});

test("wireSubagents: disabled reconciliation consumes terminal typed state", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-todo-tracker-disabled-"));
  const statePath = join(dir, "subagent-tasks.json");
  const pi = fakePi();
  let calls = 0;
  wireSubagents(pi as never, new SubagentTracker(statePath), {
    async reconcileSubagent() {
      calls += 1;
      return "applied" as const;
    },
  }, { reconcile: false });
  pi.events.emit(TASK_STARTED_EVENT, started("disabled-task", "build feature"));
  pi.events.emit(TASK_SETTLED_EVENT, settled("disabled-task", "success", "success"));
  assert.equal(calls, 0);
  assert.deepEqual(new SubagentTracker(statePath).descriptions, []);
});

test("SubagentTracker: nested durable-state corruption is quarantined, not silently dropped", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-todo-tracker-corrupt-"));
  const statePath = join(dir, "subagent-tasks.json");
  writeFileSync(statePath, JSON.stringify({
    version: 1,
    active: { task: { taskId: "task", invocationId: 42, description: "build feature", startedAt: "nope" } },
    pendingSettlements: {},
    settled: {},
  }), "utf8");
  const tracker = new SubagentTracker(statePath);
  assert.deepEqual(tracker.descriptions, []);
  assert.equal(existsSync(statePath), false);
  assert.ok(readdirSync(dir).some((name) => name.startsWith("subagent-tasks.json.corrupt-")));
});

test("SubagentTracker: a non-file state path fails closed instead of discarding receipts", () => {
  const statePath = mkdtempSync(join(tmpdir(), "pi-todo-tracker-directory-"));
  assert.throws(
    () => new SubagentTracker(statePath),
    /not a regular file/,
  );
});
