/**
 * pi-todo — markdown round-trip (pure, zero Pi coupling).
 *
 * `parseMarkdown` → `serializeMarkdown` is idempotent for well-formed input and
 * lossless for: phase headers, status/updated meta lines, checkbox items (with
 * optional `#id` and dependency annotations), and free-form prose "notes"
 * interleaved between items. Unknown meta lines are preserved as notes.
 *
 * Backwards-compatible: accepts both the pi-harness markers (`[ ]`, `[x]`) and
 * the oh-my-pi markers (`[/]`, `[-]`, `>` in_progress, `~` abandoned, `[!]` blocked).
 */
import type { BlockEntry, ItemStatus, PhaseStatus, TodoItem, TodoPhase } from "./types";

/** A parsed todo document: leading preamble + ordered phases. */
export interface TodoDoc {
  /** Lines before the first `### ` heading, preserved verbatim. */
  preamble: string[];
  /** Phases in document order. */
  phases: TodoPhase[];
}

const PHASE_STATUS: readonly PhaseStatus[] = ["active", "done", "abandoned"];
const ITEM_STATUS: readonly ItemStatus[] = [
  "pending",
  "in_progress",
  "completed",
  "abandoned",
  "blocked",
];

function isPhaseStatus(s: string): s is PhaseStatus {
  return (PHASE_STATUS as readonly string[]).includes(s);
}
function isItemStatus(s: string): s is ItemStatus {
  return (ITEM_STATUS as readonly string[]).includes(s);
}

/** Parse the canonical `.pi/artifacts/TODO.md` into a structured document. */
export function parseMarkdown(md: string): TodoDoc {
  const lines = md.split(/\r?\n/);
  const phases: TodoPhase[] = [];
  let i = 0;
  // Preamble: everything before the first level-3 heading.
  while (i < lines.length && !isHeading(lines[i])) {
    i++;
  }
  const preamble = lines.slice(0, i);

  while (i < lines.length) {
    const header = lines[i]!;
    if (!isHeading(header)) {
      // Shouldn't happen (preamble consumed), but skip defensively.
      i++;
      continue;
    }
    const { date, title } = parseHeader(header);
    i++;
    const body: BlockEntry[] = [];
    let status: PhaseStatus = "active";
    let updated: string | undefined;
    // Body runs until the next `### ` heading or EOF.
    while (i < lines.length && !isHeading(lines[i]!)) {
      const line = lines[i]!;
      // parseMeta returns non-null ONLY for valid meta we should consume.
      // Unrecognized `status:`/`updated:` lines (e.g. `status: paused`) are
      // kept as notes (not consumed) so we don't silently drop or duplicate them.
      const meta = parseMeta(line);
      if (meta) {
        if (meta.status) status = meta.status;
        if (meta.updated) updated = meta.updated;
        i++;
        continue;
      }
      const item = parseItemLine(line);
      if (item) {
        body.push({ type: "item", item });
      } else {
        // Keep every non-item line verbatim as a note, INCLUDING blank lines,
        // so the round-trip is lossless (blank separators between items and
        // `####` sub-sections are preserved). Idempotence is maintained by the
        // serializer, which never adds a blank the body already has.
        body.push({ type: "note", text: line });
      }
      i++;
    }
    phases.push({ title, date, status, updated, body });
  }
  return { preamble, phases };
}

/** Serialize a structured document back to markdown (round-trip). */
export function serializeMarkdown(doc: TodoDoc): string {
  const out: string[] = [...doc.preamble];
  if (doc.preamble.length > 0 && doc.preamble[doc.preamble.length - 1] !== "") {
    out.push("");
  }
  for (const phase of doc.phases) {
    out.push(serializeHeader(phase));
    const hasMetaNote = phase.body.some(
      (e) => e.type === "note" && /^(status|updated):/i.test(e.text),
    );
    if (!hasMetaNote) {
      out.push(phase.updated ? `status: ${phase.status} | updated: ${phase.updated}` : `status: ${phase.status}`);
    }
    // Ensure a blank line between meta and the first body entry (only if the
    // body doesn't already start with a blank), then emit entries verbatim,
    // then ensure a trailing blank before the next phase (only if the body
    // doesn't already end with one). This is lossless AND idempotent: we never
    // add a blank that already exists.
    if (phase.body.length > 0) {
      // Emit body entries verbatim (blank lines are preserved as notes), so the
      // round-trip is lossless: a phase that had no blank after `status:` stays
      // compact; one that had a blank keeps it. We only ensure a trailing blank
      // before the next phase if the body doesn't already end with one.
      for (const entry of phase.body) {
        out.push(entry.type === "item" ? serializeItem(entry.item) : entry.text);
      }
      const last = phase.body[phase.body.length - 1]!;
      const lastIsBlank = last.type === "note" && last.text === "";
      if (!lastIsBlank) out.push("");
    } else {
      out.push("");
    }
  }
  // Trailing newline for POSIX files.
  return out.join("\n").replace(/\n*$/, "\n");
}

function isHeading(line: string | undefined): boolean {
  return !!line && /^#{3}\s+\S/.test(line);
}

function parseHeader(line: string): { date?: string; title: string } {
  const m = line.match(/^#{3}\s+(\d{4}-\d{2}-\d{2})\s*-\s+(.+?)\s*$/);
  if (m) return { date: m[1], title: m[2]! };
  const m2 = line.match(/^#{3}\s+(.+?)\s*$/);
  return { title: m2?.[1] ?? line.replace(/^#{3}\s*/, "") };
}

function serializeHeader(phase: TodoPhase): string {
  return phase.date ? `### ${phase.date} - ${phase.title}` : `### ${phase.title}`;
}

function parseMeta(line: string): { status?: PhaseStatus; updated?: string } | null {
  // Canonical pi-harness format: `status: <s> | updated: <d>` (combined, one line).
  let m = line.match(/^status:\s*(\w+)\s*\|\s*updated:\s*(\S+)\s*$/i);
  if (m) {
    const s = m[1]!.toLowerCase();
    return isPhaseStatus(s) ? { status: s, updated: m[2]! } : null;
  }
  // `status: <s>` (separate line).
  m = line.match(/^status:\s*(\w+)\s*$/i);
  if (m) {
    const s = m[1]!.toLowerCase();
    return isPhaseStatus(s) ? { status: s } : null;
  }
  // `updated: <d>` (separate line).
  m = line.match(/^updated:\s*(\S+)\s*$/i);
  if (m) return { updated: m[1]! };
  // Unrecognized meta (e.g. `status: paused`, `status : active` with space) → null
  // so the caller keeps the line as a note (lossless, no silent drop).
  return null;
}

const CHECKBOX_MAP: Record<string, ItemStatus> = {
  " ": "pending",
  x: "completed",
  X: "completed",
  "/": "in_progress",
  "-": "abandoned",
  "!": "blocked",
};

/** Parse a single item line; returns null if the line is not an item. */
export function parseItemLine(line: string): TodoItem | null {
  // Standard checkbox:  - [x] content
  let m = line.match(/^\s*[-*+]\s+\[([ xX/\-!])\]\s*(.*)$/);
  if (m) {
    const mark = m[1]!;
    const status = CHECKBOX_MAP[mark] ?? "pending";
    return parseItemContent(m[2]!, status);
  }
  // oh-my-pi in_progress alias:  - > content
  m = line.match(/^\s*[-*+]\s*>\s+(.*)$/);
  if (m) return parseItemContent(m[1]!, "in_progress");
  // oh-my-pi abandoned alias:  - ~ content
  m = line.match(/^\s*[-*+]\s*~\s+(.*)$/);
  if (m) return parseItemContent(m[1]!, "abandoned");
  return null;
}

/**
 * Parse item content: optional leading `(#id)`, the body text, and trailing
 * dependency annotations `[blocks #1, #2]` / `[blocked by #3]` plus an optional
 * blocker note `(note: ...)`. A single left-to-right pass collects refs in
 * document order and removes all annotation spans (no fixed-iteration cap,
 * which previously broke idempotence for >8 annotations).
 */
function parseItemContent(rest: string, status: ItemStatus): TodoItem {
  let text = rest.trim();
  let id: string | undefined;
  let m = text.match(/^\(#(\w+)\)\s*(.*)$/);
  if (m) {
    id = `#${m[1]}`;
    text = m[2]!.trim();
  }
  const blocks: string[] = [];
  const blockedBy: string[] = [];
  let blockerNote: string | undefined;
  const re = /\s*\[(blocks|blocked by)\s+([^\]]+)\]\s*|\s*\(note:\s*([^)]+)\)\s*/g;
  for (const mm of text.matchAll(re)) {
    if (mm[1] === "blocks") {
      for (const r of mm[2]!.split(",").map((s) => s.trim()).filter(Boolean)) blocks.push(r);
    } else if (mm[1] === "blocked by") {
      for (const r of mm[2]!.split(",").map((s) => s.trim()).filter(Boolean)) blockedBy.push(r);
    } else if (mm[3]) {
      blockerNote = mm[3]!.trim();
    }
  }
  text = text.replace(re, " ").replace(/\s+/g, " ").trim();
  return { id, content: text, status, blockerNote, blocks, blockedBy };
}

const STATUS_MARK: Record<ItemStatus, string> = {
  pending: " ",
  in_progress: "/",
  completed: "x",
  abandoned: "-",
  blocked: "!",
};

/** Serialize a single item back to its markdown line. */
export function serializeItem(item: TodoItem): string {
  const mark = STATUS_MARK[item.status];
  const idPart = item.id ? `(${item.id}) ` : "";
  let line = `- [${mark}] ${idPart}${item.content}`;
  if (item.blocks.length > 0) line += ` [blocks ${item.blocks.join(", ")}]`;
  if (item.blockedBy.length > 0) line += ` [blocked by ${item.blockedBy.join(", ")}]`;
  if (item.blockerNote) line += ` (note: ${item.blockerNote})`;
  return line;
}