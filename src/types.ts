/**
 * pi-todo — core types.
 *
 * Markdown-first: `.pi/artifacts/TODO.md` is the canonical, human-readable,
 * git-diffable store. The structured model below is a *projection* of that
 * file — tools parse the file, mutate the model, then serialize back. The
 * file is always the truth a human can read/edit/grep/diff.
 *
 * Format (backwards-compatible with pi-harness's artifact-format skill; the
 * canonical combined `status: X | updated: Y` line round-trips byte-for-byte):
 *
 *   ### 2026-07-24 - Refactor auth
 *   status: active | updated: 2026-07-25
 *
 *   - [ ] pending item
 *   - [/] in_progress item   (also accepts ">" prefix)
 *   - [x] completed item
 *   - [-] abandoned item       (also accepts "~" prefix)
 *   - [!] blocked item (blocked by #2)
 *   - [/] (#3) wire up token refresh [blocks #5]
 *
 * Optional `#id` after content gives a stable reference for dependencies when
 * content is long or duplicated. Dep annotations: trailing `[blocks #5]` /
 * `[blocked by #2]`. Non-item lines (prose, blank separators, `####` sub-sections)
 * are preserved verbatim (lossless, idempotent round-trip).
 */

/** Phase-level status, parsed from the block's `status:` line. */
export type PhaseStatus = "active" | "done" | "abandoned";

/** Per-item status. */
export type ItemStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "abandoned"
  | "blocked";

/**
 * A single todo item. Identity = (phase title, content) + optional numeric #id.
 *
 * `indent` / `bullet` / `raw` are **formatting provenance**, not semantics. They
 * let the serializer reproduce the author's exact line when nothing semantic
 * changed, so a parse → serialize round-trip does not flatten sub-item
 * indentation, collapse aligned whitespace, or relocate a mid-line `(note: …)`.
 * They are absent on items constructed programmatically, which serialize
 * canonically. See `markdown.ts`.
 */
export interface TodoItem {
  /** Optional stable id (e.g. `#3`) used for dependency references. */
  id?: string;
  /** Item text, without checkbox / id / dependency annotations. */
  content: string;
  status: ItemStatus;
  /** Free-text note explaining why an item is blocked. */
  blockerNote?: string;
  /** Refs this item blocks. A ref is an id (`#3`) or `phaseTitle:content`. */
  blocks: string[];
  /** Refs that block this item. */
  blockedBy: string[];
  /** Leading whitespace of the source line (sub-item nesting). */
  indent?: string;
  /** Bullet character used in the source line (`-`, `*`, `+`). */
  bullet?: string;
  /** The source line verbatim; re-emitted when the item is semantically unchanged. */
  raw?: string;
}

/** A phase = one `### YYYY-MM-DD - <title>` block. */
export interface TodoPhase {
  /** Title after the ` - ` separator. */
  title: string;
  /** Leading date token (`YYYY-MM-DD`) from the header, if present. */
  date?: string;
  /** Parsed from the block's `status:` line. Defaults to "active". */
  status: PhaseStatus;
  /** Parsed from `updated: <date>`. */
  updated?: string;
  /**
   * True when a **valid** `status:` / `updated:` meta line was consumed from the
   * source. Distinguishes "this phase declared its status" from "a note merely
   * looks like meta" — without it, a phase carrying both `status: done` and an
   * unparseable `status: paused` note silently lost the `done`.
   */
  hasExplicitMeta?: boolean;
  /** Ordered block body: items interleaved with preserved prose notes. */
  body: BlockEntry[];
}

/** Ordered entry in a phase body. */
export type BlockEntry =
  | { type: "item"; item: TodoItem }
  | { type: "note"; text: string };

/** Convenience: items of a phase, in order. */
export function phaseItems(phase: TodoPhase): TodoItem[] {
  return phase.body.filter((e): e is { type: "item"; item: TodoItem } => e.type === "item").map((e) => e.item);
}

/** A resolved reference target. */
export interface ItemRef {
  phaseTitle: string;
  content: string;
  id?: string;
}

/** Settings for the pi-todo extension (read from settings.json `pi-todo` block). */
export interface PiTodoSettings {
  /** Enable the extension. Default true. */
  enabled?: boolean;
  /** Canonical todo file, relative to cwd or absolute. Default ".pi/artifacts/TODO.md". */
  todoFile?: string;
  /** Turn interval for the idle reminder cadence. Default 6. */
  reminderTurns?: number;
  /** Turn interval when an item is in_progress (shorter). Default 3. */
  reminderTurnsActive?: number;
  /** Enable the below-editor widget. Default true (see DEFAULT_SETTINGS). */
  widget?: boolean;
  /** Widget placement. Default "belowEditor". */
  widgetPlacement?: "aboveEditor" | "belowEditor";
  /** Max items rendered under the focused phase in the widget. Default 5. */
  widgetItemsPerPhase?: number;
  /** Widget density: "compact" (one line) | "focused" (one phase expanded, rest collapsed)
   *  | "detailed" (focused with higher caps). Default "focused". */
  widgetDensity?: "compact" | "focused" | "detailed";
  /** Hard cap on total widget lines — a data-independent safety net so the widget
   *  can never crush the editor/chatbox. Default 10. */
  widgetMaxLines?: number;
  /** Max non-focus phases shown as one-line collapsed summaries. Default 3. */
  widgetCollapsedPhases?: number;
  /** Enable auto-reconciliation on subagent settle. Default true. */
  reconcileSubagents?: boolean;
  /** Losslessly archive terminal phases after trusted-project writes. Default true. */
  autoArchive?: boolean;
  /** Enable the optional opt-in dependency/DAG features. Default false. */
  dependencies?: boolean;
}

export const DEFAULT_SETTINGS: Required<PiTodoSettings> = {
  enabled: true,
  todoFile: ".pi/artifacts/TODO.md",
  reminderTurns: 6,
  reminderTurnsActive: 3,
  widget: true,
  widgetPlacement: "belowEditor",
  widgetItemsPerPhase: 5,
  widgetDensity: "focused",
  widgetMaxLines: 10,
  widgetCollapsedPhases: 3,
  reconcileSubagents: true,
  autoArchive: true,
  dependencies: false,
};

/** Normalize user settings against defaults. */
export function resolveSettings(input: PiTodoSettings | undefined): Required<PiTodoSettings> {
  return { ...DEFAULT_SETTINGS, ...(input ?? {}) };
}

/** A reference string: an id (`#3`), an index (`#3` is id, `3` is 1-based item index), or content (fuzzy). */
export type Ref = string;
