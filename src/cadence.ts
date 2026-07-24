/**
 * pi-todo — reminder cadence (pure, zero Pi coupling).
 *
 * Inspired by pi-tasks' `ReminderCadence`: a turn-based cadence fed by agent
 * lifecycle events. The cadence decides *when* to nudge and *what* to say; the
 * Pi integration layer injects the returned text transiently via the `context`
 * hook (never persisted to disk or session history).
 *
 * Rules:
 *  - If there are no open items → nudge to start a TODO block every `reminderTurns`.
 *  - If there are open items → nudge every `reminderTurnsActive` while an item is
 *    `in_progress`, else `reminderTurns`. The nudge names the active phase, the
 *    in_progress item, and the next pending item (capped to a few lines).
 *  - Any `todo` tool call resets the idle counter; a status change resets the
 *    staleness counter (so actively-progressing work stays quiet).
 */
import type { ItemStatus, PhaseStatus, PiTodoSettings, TodoPhase } from "./types";
import { itemsOf } from "./model";

export interface CadenceSnapshot {
  phases: TodoPhase[];
  turnsSinceTodoTool: number;
  turnsSinceStatusChange: number;
  /** True once any `todo` tool call has ever happened this session. */
  hasUsedTodoTool: boolean;
}

/** Mutable turn counters; call from the integration layer's event handlers. */
export class Cadence {
  turnsSinceTodoTool = 0;
  turnsSinceStatusChange = 0;
  hasUsedTodoTool = false;

  onTurnStart(): void {
    this.turnsSinceTodoTool += 1;
    this.turnsSinceStatusChange += 1;
  }
  onTodoToolCall(): void {
    this.turnsSinceTodoTool = 0;
    this.hasUsedTodoTool = true;
  }
  onStatusChange(): void {
    this.turnsSinceStatusChange = 0;
    this.turnsSinceTodoTool = 0;
  }
  snapshot(phases: TodoPhase[]): CadenceSnapshot {
    return {
      phases,
      turnsSinceTodoTool: this.turnsSinceTodoTool,
      turnsSinceStatusChange: this.turnsSinceStatusChange,
      hasUsedTodoTool: this.hasUsedTodoTool,
    };
  }
}

const OPEN_STATUSES: ReadonlySet<ItemStatus> = new Set(["pending", "in_progress", "blocked"]);
const ACTIVE_PHASE: ReadonlySet<PhaseStatus> = new Set(["active"]);

/** Decide whether to nudge this turn and, if so, build the reminder text.
 *  Always returns a single compact line so the cadence never stacks a multi-line
 *  block of vertical noise on top of the (already bounded) widget. */
export function buildReminder(s: CadenceSnapshot, s_: Required<PiTodoSettings>): string | null {
  const openPhases = s.phases.filter((p) => ACTIVE_PHASE.has(p.status));
  const openItems = openPhases.flatMap((p) => itemsOf(p).filter((i) => OPEN_STATUSES.has(i.status)));
  const hasInProgress = openItems.some((i) => i.status === "in_progress");

  // Empty list nudge — one line.
  if (openItems.length === 0) {
    if (s.turnsSinceTodoTool < Math.max(1, s_.reminderTurns)) return null;
    return "📋 No open todos — if this is non-trivial work, record progress with `todo add` or append a `### YYYY-MM-DD - <title>` block to .pi/artifacts/TODO.md.";
  }

  const threshold = hasInProgress ? s_.reminderTurnsActive : s_.reminderTurns;
  if (s.turnsSinceTodoTool < threshold) return null;

  // Show the first active phase with an in_progress or next pending item — one line.
  const phase = openPhases.find((p) => itemsOf(p).some((i) => i.status === "in_progress")) ?? openPhases[0]!;
  const pItems = itemsOf(phase);
  const inProgress = pItems.find((i) => i.status === "in_progress");
  const nextPending = pItems.find((i) => i.status === "pending");
  const doneCount = pItems.filter((i) => i.status === "completed").length;
  const blocked = openItems.filter((i) => i.status === "blocked").length;

  const head = `📋 Todo · "${truncate(phase.title, 40)}" (${doneCount}/${pItems.length} done)`;
  const parts: string[] = [];
  if (inProgress) parts.push(`[/] ${truncate(inProgress.content, 50)}`);
  if (nextPending) parts.push(`next: ${truncate(nextPending.content, 50)}`);
  if (blocked > 0) parts.push(`⚠ ${blocked} blocked`);
  return parts.length > 0 ? `${head} · ${parts.join(" · ")}` : head;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}