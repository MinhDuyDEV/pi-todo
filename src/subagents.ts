/**
 * pi-todo — subagent integration via the native Pi tool lifecycle.
 *
 * The typed `pi-subagents:task-started` / `task-settled` lifecycle is the
 * authoritative path. Native `tool_execution_start` / `tool_execution_end`
 * remains as a compatibility fallback for older task runtimes and foreground
 * invocations that do not emit the typed settled event.
 *
 * NOTE — this is a host-level fallback, not the preferred path.
 * `@minhduydev/pi-subagents` DOES emit `pi-subagents:task-started` and
 * `pi-subagents:task-settled` at runtime (`orchestration/runtime.ts`). An older
 * comment here claimed it never did, and on the strength of that claim this
 * module gave up the typed contract and matched work by fuzzy `description`
 * string instead of by id.
 *
 * Correlation contract (roadmap 25): a task description that names explicit
 * item refs — "Fix the parser (#3)" — reconciles EXACTLY those `#id`s;
 * `TodoStore.reconcileSubagent` resolves them and never widens to text
 * matching when a ref is present. Fuzzy description matching survives only
 * for ref-less descriptions, and completes at most one best-scoring item.
 *
 * Two roles:
 *  1. Matched lighting — while a `task` tool call is in flight, expose its
 *     `description` so the widget can glow the matching pending todo.
 *  2. Reconciliation — when the `task` tool finishes, mark matching open items
 *     completed (success) or revert to pending + blocker note (failure).
 *
 * The compatibility fallback correlates by `toolCallId` (start ↔ end) and only
 * the explicit terminal phase `done` is success. Purely a *reflection* of
 * delegation: the native `task` tool owns delegation; subagents never write
 * TODO.md directly (the parent's `TodoStore` does, in the host process).
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { lockSync } from "proper-lockfile";
import {
  parseTaskSettledEvent,
  parseTaskStartedEvent,
  TASK_LIFECYCLE_EVENTS_V1,
  type ReportedTaskOutcomeV1,
  type TaskSettledEventV1,
  type TaskStartedEventV1,
  type TerminalTaskOutcomeV1,
} from "@minhduydev/pi-core/task-lifecycle";
import type { SubagentReconcileResult } from "./store.js";

export type {
  ReportedTaskOutcomeV1,
  TaskSettledEventV1,
  TaskStartedEventV1,
  TerminalTaskOutcomeV1,
};

/** Tool name the pi-subagents extension registers (env-overridable). */
export const TASK_TOOL_NAME = process.env.PI_TASK_TOOL_NAME || "task";

interface ToolExecStart {
  toolCallId: string;
  toolName: string;
  args: { description?: string; prompt?: string; agent_type?: string } | undefined;
}
interface ToolExecEnd {
  toolCallId: string;
  toolName: string;
  result: { details?: { phase?: string; error?: string; description?: string }; content?: unknown } | undefined;
  isError: boolean;
}

export const TASK_STARTED_EVENT = TASK_LIFECYCLE_EVENTS_V1.STARTED;
export const TASK_SETTLED_EVENT = TASK_LIFECYCLE_EVENTS_V1.SETTLED;

interface PersistedTask {
  taskId: string;
  invocationId: string;
  description?: string;
  startedAt: string;
}

interface TrackerStateV1 {
  version: 1;
  active: Record<string, PersistedTask>;
  pendingSettlements: Record<string, TaskSettledEventV1>;
  /** Terminal settlements awaiting a successful parent-side TODO reconciliation. */
  pendingReconciliations: Record<string, TaskSettledEventV1>;
  settled: Record<string, string>;
}

function emptyRecord<T>(): Record<string, T> {
  // Task ids cross a process boundary. A normal `{}` makes ids such as
  // `__proto__` and `toString` interact with Object.prototype instead of
  // behaving as opaque keys.
  return Object.create(null) as Record<string, T>;
}

const EMPTY_TRACKER_STATE = (): TrackerStateV1 => ({
  version: 1,
  active: emptyRecord<PersistedTask>(),
  pendingSettlements: emptyRecord<TaskSettledEventV1>(),
  pendingReconciliations: emptyRecord<TaskSettledEventV1>(),
  settled: emptyRecord<string>(),
});
const MAX_SETTLED_TASKS = 1_024;
const MAX_TRACKED_TASKS = 1_024;
const MAX_TRACKER_STATE_BYTES = 32 * 1024 * 1024;
const TRACKER_LOCK_STALE_MS = 10_000;
const TRACKER_LOCK_WAIT_MS = 2_000;
const TRACKER_LOCK_RETRY_MS = 10;
const TRACKER_WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadTrackerState(path: string | undefined): TrackerStateV1 {
  if (!path) return EMPTY_TRACKER_STATE();
  let serialized: string;
  try {
    const metadata = statSync(path);
    if (!metadata.isFile()) {
      throw new Error(`subagent tracker state is not a regular file: ${path}`);
    }
    if (metadata.size > MAX_TRACKER_STATE_BYTES) {
      throw new SyntaxError("tracker state exceeds byte bound");
    }
    serialized = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return EMPTY_TRACKER_STATE();
    }
    // Filesystem failures are operational errors, not corrupt data. Silently
    // replacing an unreadable state would lose durable lifecycle receipts.
    throw error;
  }
  try {
    if (Buffer.byteLength(serialized, "utf8") > MAX_TRACKER_STATE_BYTES) {
      throw new SyntaxError("tracker state exceeds byte bound");
    }
    const value = JSON.parse(serialized) as unknown;
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.active) ||
        !isRecord(value.pendingSettlements) ||
        (value.pendingReconciliations !== undefined && !isRecord(value.pendingReconciliations)) ||
        !isRecord(value.settled)) {
      throw new Error("invalid tracker state");
    }
    const pendingReconciliations = value.pendingReconciliations ?? {};
    if (
      Object.keys(value.active).length > MAX_TRACKED_TASKS ||
      Object.keys(value.pendingSettlements).length > MAX_TRACKED_TASKS ||
      Object.keys(pendingReconciliations).length > MAX_TRACKED_TASKS ||
      Object.keys(value.settled).length > MAX_SETTLED_TASKS
    ) {
      throw new Error("tracker state exceeds bounds");
    }
    const state = EMPTY_TRACKER_STATE();
    for (const [taskId, raw] of Object.entries(value.active)) {
      if (!isRecord(raw)) throw new Error("invalid active tracker task");
      if (raw.taskId !== taskId) throw new Error("active tracker task id/key mismatch");
      const parsed = parseTaskStartedEvent({
        protocolVersion: 1,
        taskId,
        invocationId: raw.invocationId,
        ...(raw.description !== undefined ? { description: raw.description } : {}),
        timestamp: raw.startedAt,
      });
      if (!parsed) throw new Error("invalid active tracker task");
      state.active[taskId] = {
        taskId,
        invocationId: parsed.invocationId,
        ...(parsed.description ? { description: parsed.description } : {}),
        startedAt: parsed.timestamp,
      };
    }
    for (const [taskId, raw] of Object.entries(value.pendingSettlements)) {
      const parsed = parseTaskSettledEvent(raw);
      if (!parsed || parsed.taskId !== taskId || state.active[taskId]) {
        throw new Error("invalid pending tracker settlement");
      }
      state.pendingSettlements[taskId] = parsed;
    }
    for (const [taskId, raw] of Object.entries(pendingReconciliations)) {
      const parsed = parseTaskSettledEvent(raw);
      if (!parsed || parsed.taskId !== taskId || !state.active[taskId] ||
          classifyLifecycleSettlement(parsed) === "nonterminal") {
        throw new Error("invalid pending tracker reconciliation");
      }
      state.pendingReconciliations[taskId] = parsed;
    }
    for (const [taskId, timestamp] of Object.entries(value.settled)) {
      const parsed = parseTaskStartedEvent({
        protocolVersion: 1,
        taskId,
        invocationId: "tracker-state",
        timestamp,
      });
      if (!parsed || state.active[taskId] || state.pendingSettlements[taskId] ||
          state.pendingReconciliations[taskId]) {
        throw new Error("invalid settled tracker task");
      }
      state.settled[taskId] = parsed.timestamp;
    }
    return state;
  } catch (error) {
    // Preserve the unreadable state for diagnosis instead of silently replacing it.
    try {
      renameSync(path, `${path}.corrupt-${Date.now()}-${randomUUID()}`);
      syncDirectorySync(dirname(path));
    } catch (quarantineError) {
      throw new Error(
        `invalid subagent tracker state could not be quarantined: ${
          quarantineError instanceof Error ? quarantineError.message : String(quarantineError)
        }`,
        { cause: error },
      );
    }
    return EMPTY_TRACKER_STATE();
  }
}

function writeTrackerState(path: string | undefined, state: TrackerStateV1): void {
  if (!path) return;
  const serialized = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_TRACKER_STATE_BYTES) {
    throw new Error("subagent tracker state exceeds byte bound");
  }
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let renamed = false;
  try {
    const descriptor = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(descriptor, serialized, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temp, path);
    renamed = true;
    syncDirectorySync(dirname(path));
  } finally {
    if (!renamed) {
      try { unlinkSync(temp); } catch {}
    }
  }
}

function syncDirectorySync(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function withTrackerLock<T>(path: string, fn: () => T): T {
  mkdirSync(dirname(path), { recursive: true });
  const startedAt = Date.now();
  let release: (() => void) | undefined;
  for (;;) {
    try {
      release = lockSync(path, {
        lockfilePath: `${path}.lock`,
        realpath: false,
        stale: TRACKER_LOCK_STALE_MS,
      });
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ELOCKED" || Date.now() - startedAt >= TRACKER_LOCK_WAIT_MS) {
        throw new Error(
          `could not acquire subagent tracker lock: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      // proper-lockfile's sync API intentionally does not support retries.
      // The tracker mutation itself is tiny; wait briefly for another process
      // instead of dropping a lifecycle event or overwriting its state.
      Atomics.wait(TRACKER_WAIT_ARRAY, 0, 0, TRACKER_LOCK_RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    release();
  }
}

/** Tracks in-flight `task` tool calls (toolCallId → description) for the widget. */
export class SubagentTracker {
  private active = new Map<string, string>();

  /** Native tool calls claimed by the authoritative typed lifecycle. */
  private typedToolCalls = new Map<string, string>();
  private typedTasksWithNativeCall = new Set<string>();

  private state: TrackerStateV1;

  constructor(private readonly statePath?: string) {
    this.state = statePath
      ? withTrackerLock(statePath, () => loadTrackerState(statePath))
      : EMPTY_TRACKER_STATE();
  }

  /** In-flight descriptions, for matched lighting. */
  get descriptions(): string[] {
    return [...new Set([
      ...this.active.values(),
      ...Object.values(this.state.active).map((task) => task.description),
    ])].filter((value): value is string => Boolean(value));
  }
  onStarted(toolCallId: string, description: string): void {
    this.active.set(toolCallId, description);
    // Pi normally emits tool_execution_start before the typed start, but event
    // bus scheduling must not be an ordering dependency. Associate in either
    // direction so the native terminal fallback cannot double-reconcile.
    const typedTask = Object.values(this.state.active).find(
      (task) =>
        task.description === description &&
        !this.typedTasksWithNativeCall.has(task.taskId),
    );
    if (typedTask) {
      this.typedToolCalls.set(toolCallId, typedTask.taskId);
      this.typedTasksWithNativeCall.add(typedTask.taskId);
    }
  }
  /** Remove an in-flight call; returns its description (or undefined). */
  onSettled(toolCallId: string): string | undefined {
    const d = this.active.get(toolCallId);
    this.active.delete(toolCallId);
    return d;
  }

  /** Record a typed start and return a previously out-of-order settlement, if any. */
  onLifecycleStarted(event: TaskStartedEventV1): TaskSettledEventV1 | undefined {
    let accepted = false;
    const pending = this.mutatePersistent((state) => {
      if (state.settled[event.taskId]) return undefined;
      const existing = state.active[event.taskId];
      if (existing) {
        // Idempotent replay may fill a description that was absent originally,
        // but a conflicting invocation or description cannot replace the
        // durable correlation chosen by the first valid start.
        if (
          existing.invocationId !== event.invocationId ||
          (existing.description && event.description &&
            existing.description !== event.description)
        ) {
          return undefined;
        }
        accepted = true;
        if (!existing.description && event.description) {
          existing.description = event.description;
        }
      } else {
        if (Object.keys(state.active).length >= MAX_TRACKED_TASKS) {
          throw new Error("subagent tracker active-task capacity exceeded");
        }
        accepted = true;
        state.active[event.taskId] = {
          taskId: event.taskId,
          invocationId: event.invocationId,
          ...(event.description ? { description: event.description } : {}),
          startedAt: event.timestamp,
        };
      }
      const waiting = state.pendingSettlements[event.taskId];
      if (waiting) {
        delete state.pendingSettlements[event.taskId];
        if (classifyLifecycleSettlement(waiting) !== "nonterminal") {
          state.pendingReconciliations[event.taskId] = waiting;
        }
        return waiting;
      }
      // A terminal event may already be waiting for correlation because the
      // original start omitted its optional description. A later idempotent
      // start that supplies it makes the reconciliation actionable.
      return state.pendingReconciliations[event.taskId];
    });
    if (accepted && event.description) {
      const nativeCall = [...this.active.entries()].find(
        ([toolCallId, description]) =>
          description === event.description && !this.typedToolCalls.has(toolCallId),
      );
      if (nativeCall && !this.typedTasksWithNativeCall.has(event.taskId)) {
        this.typedToolCalls.set(nativeCall[0], event.taskId);
        this.typedTasksWithNativeCall.add(event.taskId);
      }
    }
    return pending;
  }

  /** Consume whether a native tool call has a corresponding typed lifecycle. */
  consumeTypedToolCall(toolCallId: string): boolean {
    const taskId = this.typedToolCalls.get(toolCallId);
    this.typedToolCalls.delete(toolCallId);
    if (taskId) this.typedTasksWithNativeCall.delete(taskId);
    return taskId !== undefined;
  }

  /**
   * Record a typed settlement. A terminal event received before its start is
   * retained and replayed once the description arrives.
   */
  onLifecycleSettled(event: TaskSettledEventV1): {
    description?: string;
    duplicate: boolean;
  } {
    return this.mutatePersistent((state) => {
      if (state.settled[event.taskId]) return { duplicate: true };
      const reconciling = state.pendingReconciliations[event.taskId];
      if (reconciling) {
        // Conflicting reuse of a task id is ignored fail-closed; the first
        // durable terminal event remains authoritative.
        return { duplicate: true };
      }
      const active = state.active[event.taskId];
      const outcome = classifyLifecycleSettlement(event);
      if (!active) {
        const pending = state.pendingSettlements[event.taskId];
        if (pending) {
          return { duplicate: true };
        }
        if (Object.keys(state.pendingSettlements).length >= MAX_TRACKED_TASKS) {
          throw new Error("subagent tracker pending-settlement capacity exceeded");
        }
        state.pendingSettlements[event.taskId] = event;
        return { duplicate: false };
      }
      if (outcome !== "nonterminal") {
        // Keep the description and settlement durably until the parent TODO
        // write succeeds. Otherwise a transient store failure would be
        // acknowledged forever and could not be retried after restart.
        state.pendingReconciliations[event.taskId] = event;
      }
      return {
        ...(active.description ? { description: active.description } : {}),
        duplicate: false,
      };
    });
  }

  /** Settlements that survived a failed/interrupted parent-side reconcile. */
  pendingReconciliationEntries(): Array<{ event: TaskSettledEventV1; description: string }> {
    this.refreshPersistent();
    return Object.entries(this.state.pendingReconciliations).flatMap(([taskId, event]) => {
      const active = this.state.active[taskId];
      return active?.description ? [{ event, description: active.description }] : [];
    });
  }

  /** Acknowledge only after `reconcileSubagent` resolved successfully. */
  completeReconciliation(taskId: string): void {
    this.mutatePersistent((state) => {
      const settlement = state.pendingReconciliations[taskId];
      if (!settlement) return;
      delete state.pendingReconciliations[taskId];
      delete state.active[taskId];
      state.settled[taskId] = settlement.timestamp;
      this.pruneSettled(state);
    });
  }

  private pruneSettled(state: TrackerStateV1): void {
    const entries = Object.entries(state.settled);
    if (entries.length <= MAX_SETTLED_TASKS) return;
    entries.sort((a, b) => a[1].localeCompare(b[1]));
    for (const [taskId] of entries.slice(0, entries.length - MAX_SETTLED_TASKS)) {
      delete state.settled[taskId];
    }
  }

  private mutatePersistent<T>(mutate: (state: TrackerStateV1) => T): T {
    if (!this.statePath) {
      return mutate(this.state);
    }
    return withTrackerLock(this.statePath, () => {
      const current = loadTrackerState(this.statePath);
      const result = mutate(current);
      writeTrackerState(this.statePath, current);
      this.state = current;
      return result;
    });
  }

  private refreshPersistent(): void {
    if (!this.statePath) return;
    this.state = withTrackerLock(
      this.statePath,
      () => loadTrackerState(this.statePath),
    );
  }

  clear(): void {
    // Tool-call state is session-local. Typed lifecycle state intentionally
    // survives /clear, /resume and process restart until task-settled arrives.
    this.active.clear();
    this.typedToolCalls.clear();
    this.typedTasksWithNativeCall.clear();
  }
}

/** Decide a task tool's outcome from a `tool_execution_end` event. */
export type TaskOutcome = "success" | "failure" | "nonterminal";
export function classifyTaskEnd(e: Pick<ToolExecEnd, "isError" | "result">): TaskOutcome {
  if (e.isError) return "failure";
  if (e.result?.details?.error?.trim()) return "failure";
  const phase = e.result?.details?.phase;
  // Foreground tasks end terminally ("done"/"failed"/"verification_failed").
  // Background/scheduled tasks return IMMEDIATELY with "running"/"scheduled"
  // and deliver the final result later via a followUp message (NOT via
  // tool_execution_end) — so a non-terminal phase means "still running", and
  // we must NOT reconcile (would mark the todo done at launch).
  if (phase === "done") return "success";
  if (phase === "failed" || phase === "verification_failed") return "failure";
  return "nonterminal";
}

/** Typed task lifecycle is fail-closed: only an explicit semantic success completes a TODO. */
export function classifyLifecycleSettlement(e: TaskSettledEventV1): TaskOutcome {
  if (e.terminalOutcome === "awaiting-decision" ||
      e.reportedOutcome === "awaiting-decision") return "nonterminal";
  if (e.awaitingReview) {
    return e.terminalOutcome === "success" &&
      e.reportedOutcome === "success" &&
      (e.executionPhase === undefined || e.executionPhase === "completed")
      ? "nonterminal"
      : "failure";
  }
  if (e.terminalOutcome === "success" && e.reportedOutcome === "success" &&
      (e.executionPhase === undefined || e.executionPhase === "completed") &&
      e.verificationPassed !== false) return "success";
  return "failure";
}

/** @deprecated kept for compatibility; prefer classifyTaskEnd. */
export function isTaskSuccess(e: Pick<ToolExecEnd, "isError" | "result">): boolean {
  return classifyTaskEnd(e) === "success";
}

export interface Reconciler {
  reconcileSubagent(
    description: string,
    success: boolean,
    note?: string,
  ): Promise<SubagentReconcileResult | boolean>;
}

/**
 * Wire the tracker + reconciler to the native tool lifecycle events.
 *
 * NOTE: Pi's `pi.on()` returns `void` — there is NO unsubscribe (handlers are
 * process-lifetime, which is correct for cross-session persistence). So this
 * returns a cleanup that only clears in-process tracker state; it must NOT
 * try to invoke a (non-existent) unsubscribe.
 */
export function wireSubagents(
  pi: ExtensionAPI,
  tracker: SubagentTracker,
  reconciler: Reconciler,
  opts: { reconcile: boolean; onActivity?: () => void },
): () => void {
  const api = pi as unknown as {
    on(event: "tool_execution_start", h: (e: ToolExecStart) => void): void;
    on(event: "tool_execution_end", h: (e: ToolExecEnd) => void | Promise<void>): void;
  };
  const reconcilingTasks = new Set<string>();

  const reconcileLifecycle = (event: TaskSettledEventV1, description: string): void => {
    const outcome = classifyLifecycleSettlement(event);
    if (outcome === "nonterminal") return;
    if (reconcilingTasks.has(event.taskId)) return;
    if (!opts.reconcile) {
      // Reconciliation is disabled by the operator, but the terminal event is
      // still consumed so it cannot leave permanent matched-lighting state.
      tracker.completeReconciliation(event.taskId);
      return;
    }
    const success = outcome === "success";
    const note = success
      ? undefined
      : event.issues[0] ?? `subagent ${event.terminalOutcome ?? "did not report semantic success"}`;
    reconcilingTasks.add(event.taskId);
    void reconciler.reconcileSubagent(description, success, note)
      .then((result) => {
        if (result === "unmatched" || result === false) {
          // A successful Promise only proves the store call ran. With no
          // correlation, acknowledging here would permanently lose the event
          // and prevent a later startup from making it match.
          opts.onActivity?.();
          return;
        }
        // `superseded` means a human already moved the correlated item to a
        // terminal state; retaining the child event would only replay forever.
        tracker.completeReconciliation(event.taskId);
      })
      .catch(() => {
        // The pending reconciliation remains durable and is retried when this
        // extension is loaded again. Do not convert a failed TODO write into a
        // terminal tracker acknowledgement.
        opts.onActivity?.();
      })
      .finally(() => reconcilingTasks.delete(event.taskId));
  };

  pi.events.on(TASK_STARTED_EVENT, (value: unknown) => {
    const event = parseTaskStartedEvent(value);
    if (!event) return;
    const pending = tracker.onLifecycleStarted(event);
    opts.onActivity?.();
    if (pending && event.description) reconcileLifecycle(pending, event.description);
  });
  pi.events.on(TASK_SETTLED_EVENT, (value: unknown) => {
    const event = parseTaskSettledEvent(value);
    if (!event) return;
    const result = tracker.onLifecycleSettled(event);
    opts.onActivity?.();
    if (result.duplicate || !result.description) return;
    reconcileLifecycle(event, result.description);
  });

  // Resume only terminal events whose parent-side TODO write was not
  // acknowledged. This makes a crash/restart or transient store error safe.
  for (const entry of tracker.pendingReconciliationEntries()) {
    reconcileLifecycle(entry.event, entry.description);
  }

  api.on("tool_execution_start", (e) => {
    if (e.toolName !== TASK_TOOL_NAME) return;
    const desc = e.args?.description || e.args?.prompt || "";
    if (!desc) return;
    tracker.onStarted(e.toolCallId, desc);
    opts.onActivity?.();
  });
  api.on("tool_execution_end", (e) => {
    if (e.toolName !== TASK_TOOL_NAME) return;
    // Always remove from the in-flight set (unlit). For non-terminal phases
    // (background tasks that returned early) we do NOT reconcile.
    const typedLifecycleOwnsCall = tracker.consumeTypedToolCall(e.toolCallId);
    const desc = tracker.onSettled(e.toolCallId) ?? e.result?.details?.description ?? "";
    opts.onActivity?.();
    if (typedLifecycleOwnsCall) return;
    if (!opts.reconcile || !desc) return;
    const outcome = classifyTaskEnd(e);
    if (outcome === "nonterminal") return; // still running — don't mark done
    const success = outcome === "success";
    const note = !success ? e.result?.details?.error ?? "subagent failed" : undefined;
    void reconciler.reconcileSubagent(desc, success, note).catch(() => {
      // The native path has no durable typed task identity to retry, but it
      // must not create an unhandled rejection that destabilizes the host.
      opts.onActivity?.();
    });
  });
  // No pi.on unsubscribe exists; cleanup just clears in-process tracker state.
  return () => tracker.clear();
}
