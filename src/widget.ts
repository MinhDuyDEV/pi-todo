/**
 * pi-todo — widget rendering (markdown-first, crash-safe).
 *
 * Renders a bounded projection of the parsed TODO.md via the Pi `setWidget` API.
 * Steals the best ideas from oh-my-pi and pi-tasks:
 *  - walking-viewport selection (oh-my-pi `selectCollapsedTodos`): active items
 *    first, then following pending, capped per phase; `… N more` summary.
 *  - phase progress `· 3/5` + root header `Todos · <done>/<total>`.
 *  - matched lighting: a pending item glows accent when a live subagent is
 *    working on it (fuzzy match against active descriptions).
 *  - status icons + theme colors (oh-my-pi `#formatTodoLine`).
 *  - crash-safe: the whole render is wrapped so a render bug never crashes the
 *    host TUI (returns `[]` on error).
 *
 * `renderWidget` is pure (no Pi imports) → unit-testable; `makeWidgetContent`
 * returns the `Component` factory consumed by `ctx.ui.setWidget`.
 */
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ItemStatus, PiTodoSettings, TodoItem, TodoPhase } from "./types.js";
import { itemsOf, normalizeContent, similarity } from "./model.js";
import type { TodoDoc } from "./markdown.js";

const ICON: Record<ItemStatus, string> = {
  pending: "◻",
  in_progress: "◐",
  completed: "✔",
  abandoned: "✗",
  blocked: "⚠",
};
const OPEN: ReadonlySet<ItemStatus> = new Set(["pending", "in_progress", "blocked"]);

export interface WidgetInput {
  doc: TodoDoc;
  activeSubagentDescriptions: string[];
  spinnerFrame: string;
}

/**
 * Build the widget lines for the given doc. Pure + crash-safe (returns `[]`
 * on any error). Exposed for unit tests.
 */
export function renderWidgetLines(input: WidgetInput, settings: Required<PiTodoSettings>, theme: Theme): string[] {
  try {
    const phases = input.doc.phases.filter((p) => p.status === "active");
    const allItems = input.doc.phases.flatMap((p) => itemsOf(p));
    if (allItems.length === 0) return [];

    // A phase is "done" when every item is completed/abandoned — hide those entirely
    // so finished work never wastes a widget line.
    const isDone = (p: TodoPhase): boolean => {
      const items = itemsOf(p);
      return items.length > 0 && items.every((i) => i.status === "completed" || i.status === "abandoned");
    };
    const rootDone = phases.filter(isDone).length;
    const visible = phases.filter((p) => !isDone(p));
    if (visible.length === 0) return []; // all done → hide the widget completely

    const focus = pickFocus(visible);

    // Compact: a single line — never grows, never crushes the editor.
    if (settings.widgetDensity === "compact") {
      return [compactLine(phases, rootDone, focus, settings, input, theme)];
    }

    // Focused / detailed: one phase expanded, the rest collapsed to a line each.
    const detailed = settings.widgetDensity === "detailed";
    const focusCap = Math.max(1, detailed ? Math.max(settings.widgetItemsPerPhase, 6) : settings.widgetItemsPerPhase);
    const collapsedPhases = Math.max(1, detailed ? Math.max(settings.widgetCollapsedPhases, 4) : settings.widgetCollapsedPhases);

    const lines: string[] = [];
    lines.push(theme.bold(`Todos · ${rootDone}/${phases.length}`));

    if (focus) {
      const items = itemsOf(focus);
      const done = items.filter((i) => i.status === "completed" || i.status === "abandoned").length;
      lines.push(
        theme.fg("accent", `▾ ${roman(indexOfPhase(input.doc, focus) + 1)}. ${focus.title}`) +
          theme.fg("muted", ` · ${done}/${items.length}`),
      );
      const selected = selectCollapsed(items, input.activeSubagentDescriptions, focusCap);
      for (const it of selected.shown) lines.push(formatItem(it, input, theme));
      if (selected.hidden > 0) lines.push(theme.fg("dim", `   … ${selected.hidden} more`));
    }

    const rest = visible.filter((p) => p !== focus);
    for (const phase of rest.slice(0, collapsedPhases)) {
      const items = itemsOf(phase);
      const done = items.filter((i) => i.status === "completed" || i.status === "abandoned").length;
      lines.push(
        theme.fg("accent", `▸ ${roman(indexOfPhase(input.doc, phase) + 1)}. ${phase.title}`) +
          theme.fg("muted", ` · ${done}/${items.length}`),
      );
    }
    if (rest.length > collapsedPhases) {
      lines.push(theme.fg("dim", `  +${rest.length - collapsedPhases} more phase(s)`));
    }

    return capToMaxLines(lines, settings.widgetMaxLines, theme);
  } catch {
    return [];
  }
}

/** Pick the phase to expand: most in_progress, then most pending, then first. */
function pickFocus(phases: TodoPhase[]): TodoPhase | undefined {
  const score = (p: TodoPhase): [number, number] => {
    const items = itemsOf(p);
    return [
      items.filter((i) => i.status === "in_progress").length,
      items.filter((i) => i.status === "pending").length,
    ];
  };
  return [...phases].sort((a, b) => {
    const [ai, ap] = score(a);
    const [bi, bp] = score(b);
    return bi - ai || bp - ap || 0;
  })[0];
}

/** One-line compact summary: spinner + root progress + focus phase progress. */
function compactLine(
  phases: TodoPhase[],
  rootDone: number,
  focus: TodoPhase | undefined,
  settings: Required<PiTodoSettings>,
  input: WidgetInput,
  theme: Theme,
): string {
  const head = `${input.spinnerFrame} ${theme.bold(`Todos · ${rootDone}/${phases.length}`)}`;
  if (!focus) return head;
  const items = itemsOf(focus);
  const done = items.filter((i) => i.status === "completed" || i.status === "abandoned").length;
  return `${head} · ${truncateLine(focus.title, 40)} · ${done}/${items.length}`;
}

/** Hard safety net: never let the widget exceed `max` lines, regardless of data. */
function capToMaxLines(lines: string[], max: number, theme: Theme): string[] {
  const cap = Math.max(0, max);
  if (cap === 0) return [];
  if (lines.length <= cap) return lines;
  const overflow = lines.length - cap + 1;
  return [...lines.slice(0, cap - 1), theme.fg("dim", `… +${overflow} (widget bounded)`)];
}

function formatItem(it: TodoItem, input: WidgetInput, theme: Theme): string {
  const icon = it.status === "in_progress" ? `${input.spinnerFrame} ` : `${ICON[it.status]} `;
  const matched = isMatched(it, input.activeSubagentDescriptions);
  let text = it.content;
  if (it.status === "blocked") {
    text = it.blockerNote ? `${text} (blocked: ${it.blockerNote})` : text;
  }
  if (it.status === "in_progress" && matched) {
    return `   ${theme.fg("accent", icon + text)}`;
  }
  if (matched) {
    return `   ${theme.fg("accent", icon + text)}`;
  }
  switch (it.status) {
    case "completed":
      return `   ${theme.fg("dim", icon + text)}`;
    case "abandoned":
      return `   ${theme.fg("error", icon + text)}`;
    case "blocked":
      return `   ${theme.fg("warning", icon + text)}`;
    case "in_progress":
      return `   ${theme.fg("accent", icon + text)}`;
    default:
      return `   ${theme.fg("dim", icon + text)}`;
  }
}

/** oh-my-pi `selectCollapsedTodos`: actives first, then following pending, capped. */
function selectCollapsed(items: TodoItem[], activeDescs: string[], cap: number): { shown: TodoItem[]; hidden: number } {
  const actives = items.filter((i) => i.status === "in_progress" || (i.status === "pending" && isMatched(i, activeDescs)));
  const following = items.filter((i) => !actives.includes(i) && i.status === "pending");
  const blocked = items.filter((i) => i.status === "blocked" && !actives.includes(i));
  const pool = [...actives, ...blocked, ...following];
  if (pool.length <= cap) return { shown: pool, hidden: 0 };
  if (actives.length >= cap) return { shown: actives.slice(0, cap), hidden: pool.length - cap };
  const remaining = cap - actives.length;
  const shown = [...actives, ...following.slice(0, remaining)];
  return { shown, hidden: pool.length - shown.length };
}

function isMatched(it: TodoItem, activeDescs: string[]): boolean {
  if (activeDescs.length === 0) return false;
  if (it.status !== "pending" && it.status !== "in_progress") return false;
  const c = normalizeContent(it.content);
  for (const d of activeDescs) {
    const dn = normalizeContent(d);
    if (similarity(it.content, d) >= 0.5 || c.includes(dn) || dn.includes(c)) return true;
  }
  return false;
}

function indexOfPhase(doc: TodoDoc, phase: TodoPhase): number {
  return doc.phases.indexOf(phase);
}

function roman(n: number): string {
  const map: [number, string][] = [
    [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
  ];
  let out = "";
  for (const [v, s] of map) while (n >= v) { out += s; n -= v; }
  return out || "0";
}

/** Truncate text to a visible width with an ellipsis. */
export function truncateLine(text: string, maxWidth: number): string {
  if (visibleWidth(text) <= maxWidth) return text;
  if (maxWidth <= 1) return "…";
  return text.slice(0, Math.max(1, maxWidth - 1)) + "…";
}

/**
 * A widget Component that recomputes its lines on every `render(width)` call,
 * so the spinner + live subagent lighting update without re-registering. The
 * Pi TUI calls `render` on each frame/invalidation; the integration layer calls
 * `tui.requestRender()` from a spinner interval to trigger re-renders.
 */
export class TodoWidgetComponent implements Component {
  constructor(
    private readonly getter: () => WidgetInput,
    private readonly settings: Required<PiTodoSettings>,
    private readonly theme: Theme,
  ) {}
  render(width: number): string[] {
    const max = Math.max(20, width - 2);
    return renderWidgetLines(this.getter(), this.settings, this.theme).map((l) => truncateLine(l, max));
  }
  invalidate(): void {
    // Stateless — nothing to invalidate.
  }
}

/** Component factory consumed by `ctx.ui.setWidget(key, fn, opts)`. */
export function makeWidgetContent(
  input: () => WidgetInput,
  settings: Required<PiTodoSettings>,
): (tui: unknown, theme: Theme) => Component {
  return (_tui: unknown, theme: Theme) => new TodoWidgetComponent(input, settings, theme);
}