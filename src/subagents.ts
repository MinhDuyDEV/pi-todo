/**
 * pi-todo — subagent integration via the native Pi tool lifecycle.
 *
 * The pinned `@minhduydev/pi-subagents` declares `pi-subagents:task-started` /
 * `task-settled` eventbus events in its *types*, but never emits them at
 * runtime — so subscribing to the eventbus is dead code. The real lifecycle
 * signal is the native `task` delegation tool going through Pi's standard
 * `tool_execution_start` / `tool_execution_end` events (the same events every
 * tool fires). We hook those instead.
 *
 * Two roles:
 *  1. Matched lighting — while a `task` tool call is in flight, expose its
 *     `description` so the widget can glow the matching pending todo.
 *  2. Reconciliation — when the `task` tool finishes, mark matching open items
 *     completed (success) or revert to pending + blocker note (failure).
 *
 * Correlation is by `toolCallId` (start ↔ end). Success = `!isError &&`
 * `result.details.phase !== "failed"`. Purely a *reflection* of delegation: the
 * native `task` tool owns delegation; subagents never write TODO.md directly
 * (the parent's `TodoStore` does, in the host process).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

/** Tracks in-flight `task` tool calls (toolCallId → description) for the widget. */
export class SubagentTracker {
  private active = new Map<string, string>();

  /** In-flight descriptions, for matched lighting. */
  get descriptions(): string[] {
    return [...this.active.values()].filter(Boolean);
  }
  onStarted(toolCallId: string, description: string): void {
    this.active.set(toolCallId, description);
  }
  /** Remove an in-flight call; returns its description (or undefined). */
  onSettled(toolCallId: string): string | undefined {
    const d = this.active.get(toolCallId);
    this.active.delete(toolCallId);
    return d;
  }
  clear(): void {
    this.active.clear();
  }
}

/** Decide a task tool's outcome from a `tool_execution_end` event. */
export type TaskOutcome = "success" | "failure" | "nonterminal";
export function classifyTaskEnd(e: Pick<ToolExecEnd, "isError" | "result">): TaskOutcome {
  if (e.isError) return "failure";
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

/** @deprecated kept for compatibility; prefer classifyTaskEnd. */
export function isTaskSuccess(e: Pick<ToolExecEnd, "isError" | "result">): boolean {
  return classifyTaskEnd(e) === "success";
}

export interface Reconciler {
  reconcileSubagent(description: string, success: boolean, note?: string): Promise<boolean>;
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
    const desc = tracker.onSettled(e.toolCallId) ?? e.result?.details?.description ?? "";
    opts.onActivity?.();
    if (!opts.reconcile || !desc) return;
    const outcome = classifyTaskEnd(e);
    if (outcome === "nonterminal") return; // still running — don't mark done
    const success = outcome === "success";
    const note = !success ? e.result?.details?.error ?? "subagent failed" : undefined;
    void reconciler.reconcileSubagent(desc, success, note);
  });
  // No pi.on unsubscribe exists; cleanup just clears in-process tracker state.
  return () => tracker.clear();
}