/**
 * pi-todo — model: pure transformation functions on `TodoPhase[]`.
 *
 * Zero IO, zero Pi coupling → trivially unit-testable. The store layer parses the
 * markdown, calls these, then serializes back. Mutations return *new* arrays
 * (immutably replacing the touched phase); invariants (single-active-task,
 * optional DAG validation) are enforced here.
 */
import type { BlockEntry, ItemStatus, TodoItem, TodoPhase } from "./types";

/* ----------------------------- matching utils ----------------------------- */

/** Normalize text for fuzzy matching: lowercase, collapse whitespace, strip punctuation. */
export function normalizeContent(s: string): string {
  return s
    .toLowerCase()
    .replace(/[`'"[\](){}:.,!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A similarity score in [0,1]; 0 = no match. Uses token containment + substring. */
export function similarity(haystack: string, needle: string): number {
  const h = normalizeContent(haystack);
  const n = normalizeContent(needle);
  if (!n) return 0;
  if (h === n) return 1;
  if (h.includes(n) || n.includes(h)) return 0.9;
  const hTokens = new Set(h.split(" ").filter(Boolean));
  const nTokens = n.split(" ").filter(Boolean);
  if (nTokens.length === 0) return 0;
  const hits = nTokens.filter((t) => hTokens.has(t)).length;
  const token = hits / nTokens.length;
  // Return the raw token-overlap (no extra discount) so a needle that is a
  // token-subset/superset of the haystack still matches. Gated by the caller.
  return token >= 0.5 ? token : 0;
}

/* ------------------------------- resolution -------------------------------- */

export interface Resolved {
  phaseIndex: number;
  itemIndex: number;
  phase: TodoPhase;
  item: TodoItem;
}

function phaseItemAt(phases: TodoPhase[], pi: number, ii: number): Resolved | null {
  const phase = phases[pi];
  if (!phase) return null;
  const items = itemsOf(phase);
  const item = items[ii];
  if (!item) return null;
  return { phaseIndex: pi, itemIndex: ii, phase, item };
}

/** All items of a phase, in order (flattening the body entries). */
export function itemsOf(phase: TodoPhase): TodoItem[] {
  return phase.body.filter((e): e is Extract<BlockEntry, { type: "item" }> => e.type === "item").map((e) => e.item);
}

/**
 * Resolve a reference to an item. Accepted forms:
 *  - `#id`          → item whose `id` equals `#id`
 *  - `<n>`          → 1-based index across all items in document order
 *  - `phase:content`→ scoped fuzzy content match within the named phase
 *  - `content`      → fuzzy content match across all items (best unique match)
 * Prefers in_progress > pending > others when multiple matches tie.
 */
export function resolveRef(phases: TodoPhase[], ref: string): Resolved | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;

  // #id
  if (/^#\w+$/.test(trimmed)) {
    for (let pi = 0; pi < phases.length; pi++) {
      const items = itemsOf(phases[pi]!);
      for (let ii = 0; ii < items.length; ii++) {
        if (items[ii]!.id === trimmed) return phaseItemAt(phases, pi, ii)!;
      }
    }
  }
  // 1-based numeric index across the whole document
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    let k = 0;
    for (let pi = 0; pi < phases.length; pi++) {
      const items = itemsOf(phases[pi]!);
      for (let ii = 0; ii < items.length; ii++) {
        k++;
        if (k === n) return phaseItemAt(phases, pi, ii)!;
      }
    }
  }
  // phase:content
  const colon = trimmed.lastIndexOf(":");
  if (colon > 0) {
    const phasePart = trimmed.slice(0, colon);
    const contentPart = trimmed.slice(colon + 1);
    const pi = findPhaseIndex(phases, phasePart);
    if (pi >= 0) return resolveInPhase(phases, pi, contentPart);
  }
  // fuzzy across all
  return resolveAcrossAll(phases, trimmed);
}

function findPhaseIndex(phases: TodoPhase[], titleRef: string): number {
  const t = normalizeContent(titleRef);
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < phases.length; i++) {
    const s = similarity(phases[i]!.title, titleRef);
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  }
  // Also exact index match.
  if (best < 0 && /^\d+$/.test(titleRef)) {
    const idx = Number(titleRef) - 1;
    if (idx >= 0 && idx < phases.length) return idx;
  }
  return bestScore >= 0.6 ? best : -1;
}

/** Find a phase by fuzzy title; returns null if no good match. */
export function findPhase(phases: TodoPhase[], titleRef: string): TodoPhase | null {
  const i = findPhaseIndex(phases, titleRef);
  return i >= 0 ? phases[i]! : null;
}

function resolveInPhase(phases: TodoPhase[], pi: number, contentRef: string): Resolved | null {
  const items = itemsOf(phases[pi]!);
  let best: { ii: number; score: number; status: ItemStatus } | null = null;
  for (let ii = 0; ii < items.length; ii++) {
    const it = items[ii]!;
    const score = similarity(it.content, contentRef);
    if (!best || score > best.score || (score === best.score && rankStatus(it.status) > rankStatus(best.status))) {
      best = { ii, score, status: it.status };
    }
  }
  if (best && best.score >= 0.6) return phaseItemAt(phases, pi, best.ii)!;
  // Fall back to numeric within phase.
  if (/^\d+$/.test(contentRef)) {
    const ii = Number(contentRef) - 1;
    if (ii >= 0 && ii < items.length) return phaseItemAt(phases, pi, ii)!;
  }
  return null;
}

function resolveAcrossAll(phases: TodoPhase[], contentRef: string): Resolved | null {
  let best: { pi: number; ii: number; score: number; status: ItemStatus } | null = null;
  for (let pi = 0; pi < phases.length; pi++) {
    const items = itemsOf(phases[pi]!);
    for (let ii = 0; ii < items.length; ii++) {
      const it = items[ii]!;
      const score = similarity(it.content, contentRef);
      if (!best || score > best.score || (score === best.score && rankStatus(it.status) > rankStatus(best.status))) {
        best = { pi, ii, score, status: it.status };
      }
    }
  }
  return best && best.score >= 0.6 ? phaseItemAt(phases, best.pi, best.ii)! : null;
}

function rankStatus(s: ItemStatus): number {
  return s === "in_progress" ? 3 : s === "pending" ? 2 : s === "blocked" ? 1 : 0;
}

/* ------------------------------ invariants -------------------------------- */

/**
 * Enforce the single-active-task invariant on a phase: keep only the first
 * `in_progress` item; demote any extra `in_progress` to `pending`. Optionally
 * auto-promote the first `pending` item when nothing is active.
 *
 * Returns a new phase (immutably) if changed, else the same reference.
 */
export function normalizePhase(phase: TodoPhase, opts: { autoPromote?: boolean } = {}): TodoPhase {
  const items = itemsOf(phase);
  const inProgress = items.filter((i) => i.status === "in_progress");
  let changed = false;
  if (inProgress.length > 1) {
    const keep = inProgress[0]!;
    changed = true;
    phase = mapItems(phase, (it) =>
      it.status === "in_progress" && it !== keep ? { ...it, status: "pending" as ItemStatus } : it,
    );
  }
  if (opts.autoPromote && phase.status === "active") {
    const stillInProgress = itemsOf(phase).some((i) => i.status === "in_progress");
    if (!stillInProgress) {
      const firstPendingIdx = phase.body.findIndex(
        (e) => e.type === "item" && e.item.status === "pending",
      );
      if (firstPendingIdx >= 0) {
        phase = mapItemAt(phase, firstPendingIdx, (it) => ({ ...it, status: "in_progress" as ItemStatus }));
        changed = true;
      }
    }
  }
  return changed ? phase : phase;
}

/** Enforce invariants across all phases. Returns new array only if changed. */
export function normalizeDoc(phases: TodoPhase[], opts: { autoPromote?: boolean } = {}): TodoPhase[] {
  let changed = false;
  const next = phases.map((p) => {
    const n = normalizePhase(p, opts);
    if (n !== p) changed = true;
    return n;
  });
  return changed ? next : phases;
}

/* ------------------------------ mutations --------------------------------- */

/** Immutably replace every item of a phase via `fn` (non-item entries preserved). */
function mapItems(phase: TodoPhase, fn: (it: TodoItem, idx: number) => TodoItem): TodoPhase {
  let n = 0;
  const body = phase.body.map((e) =>
    e.type === "item" ? { type: "item" as const, item: fn(e.item, n++) } : e,
  );
  return { ...phase, body };
}

/** Immutably replace the item at a body entry index via `fn`. */
function mapItemAt(phase: TodoPhase, bodyIdx: number, fn: (it: TodoItem) => TodoItem): TodoPhase {
  const body = phase.body.map((e, i) => (i === bodyIdx && e.type === "item" ? { type: "item" as const, item: fn(e.item) } : e));
  return { ...phase, body };
}

/** Find the body index of a resolved item. */
function bodyIndexOf(phase: TodoPhase, itemIndex: number): number {
  let n = -1;
  for (let i = 0; i < phase.body.length; i++) {
    if (phase.body[i]!.type === "item") {
      n++;
      if (n === itemIndex) return i;
    }
  }
  return -1;
}

function updateItemAt(phases: TodoPhase[], r: Resolved, fn: (it: TodoItem) => TodoItem): TodoPhase[] {
  const bi = bodyIndexOf(r.phase, r.itemIndex);
  if (bi < 0) return phases;
  const phase = mapItemAt(r.phase, bi, fn);
  return phases.map((p, i) => (i === r.phaseIndex ? phase : p));
}

/** Add an item to a phase, creating the phase if it does not exist. */
export function addItem(
  phases: TodoPhase[],
  phaseTitle: string,
  item: TodoItem,
  afterRef?: string,
): TodoPhase[] {
  // Fuzzy-match an existing phase (avoid spawning a near-duplicate on case/whitespace).
  let pi = phases.findIndex((p) => normalizeContent(p.title) === normalizeContent(phaseTitle));
  let next = phases;
  if (pi < 0) {
    const phase: TodoPhase = { title: phaseTitle, status: "active", body: [] };
    next = [...phases, phase];
    pi = next.length - 1;
  }
  let afterBi = -1;
  if (afterRef) {
    const r = resolveRef(next, afterRef);
    // Only splice after the ref if it resolves INSIDE the target phase; an
    // afterRef in another phase used that phase's body index (wrong array).
    if (r && r.phase === next[pi]) afterBi = bodyIndexOf(r.phase, r.itemIndex);
  }
  const phase = next[pi]!;
  const entry: BlockEntry = { type: "item", item };
  const body =
    afterBi >= 0
      ? [...phase.body.slice(0, afterBi + 1), entry, ...phase.body.slice(afterBi + 1)]
      : [...phase.body, entry];
  return next.map((p, i) => (i === pi ? { ...p, body } : p));
}

/** Start an item (set in_progress) and enforce single-active in its phase. */
export function startItem(phases: TodoPhase[], ref: string): TodoPhase[] {
  const r = resolveRef(phases, ref);
  if (!r) return phases;
  // Demote other in_progress in the same phase.
  let next = mapItems(r.phase, (it) =>
    it.status === "in_progress" && it !== r.item ? { ...it, status: "pending" as ItemStatus } : it,
  );
  next = mapItemAt(next, bodyIndexOf(next, r.itemIndex), (it) => ({ ...it, status: "in_progress" as ItemStatus }));
  return phases.map((p, i) => (i === r.phaseIndex ? next : p));
}

/** Set an item's status (and optional blocker note). */
export function setItemStatus(
  phases: TodoPhase[],
  ref: string,
  status: ItemStatus,
  blockerNote?: string,
): TodoPhase[] {
  const r = resolveRef(phases, ref);
  if (!r) return phases;
  // Setting to in_progress must enforce single-active in that phase (demote
  // any other in_progress), otherwise the invariant is bypassed and normalize
  // would later demote the WRONG item (the one we just set).
  if (status === "in_progress") {
    let phase = mapItems(r.phase, (it) =>
      it.status === "in_progress" && it !== r.item ? { ...it, status: "pending" as ItemStatus } : it,
    );
    const bi = bodyIndexOf(phase, r.itemIndex);
    phase = mapItemAt(phase, bi, (it) => ({ ...it, status }));
    return phases.map((p, i) => (i === r.phaseIndex ? phase : p));
  }
  return updateItemAt(phases, r, (it) => ({
    ...it,
    status,
    blockerNote: status === "blocked" ? blockerNote ?? it.blockerNote : undefined,
    blockedBy: it.blockedBy,
  }));
}

/** Mark completed. */
export function completeItem(phases: TodoPhase[], ref: string): TodoPhase[] {
  return setItemStatus(phases, ref, "completed");
}
/** Mark abandoned. */
export function abandonItem(phases: TodoPhase[], ref: string): TodoPhase[] {
  return setItemStatus(phases, ref, "abandoned");
}
/** Mark blocked. */
export function blockItem(phases: TodoPhase[], ref: string, note?: string): TodoPhase[] {
  return setItemStatus(phases, ref, "blocked", note);
}
/** Clear blocked → pending. */
export function unblockItem(phases: TodoPhase[], ref: string): TodoPhase[] {
  const r = resolveRef(phases, ref);
  if (!r) return phases;
  return updateItemAt(phases, r, (it) => ({ ...it, status: "pending", blockerNote: undefined, blockedBy: [] }));
}

/** Remove an item entirely (no tombstone). */
export function removeItem(phases: TodoPhase[], ref: string): TodoPhase[] {
  const r = resolveRef(phases, ref);
  if (!r) return phases;
  const bi = bodyIndexOf(r.phase, r.itemIndex);
  const body = r.phase.body.filter((_, i) => i !== bi);
  return phases.map((p, i) => (i === r.phaseIndex ? { ...p, body } : p));
}

/** Move an item to another phase (creating it if needed). Same-phase move is a no-op. */
export function moveItem(phases: TodoPhase[], ref: string, toPhaseTitle: string): TodoPhase[] {
  const r = resolveRef(phases, ref);
  if (!r) return phases;
  // No-op (and avoid relocating to end) when the target is the item's own phase.
  if (normalizeContent(r.phase.title) === normalizeContent(toPhaseTitle)) return phases;
  const bi = bodyIndexOf(r.phase, r.itemIndex);
  const moved = r.phase.body[bi];
  if (!moved || moved.type !== "item") return phases;
  let pi = phases.findIndex((p) => normalizeContent(p.title) === normalizeContent(toPhaseTitle));
  let next = phases;
  if (pi < 0) {
    next = [...phases, { title: toPhaseTitle, status: "active", body: [] }];
    pi = next.length - 1;
  }
  const fromBody = r.phase.body.filter((_, i) => i !== bi);
  next = next.map((p, i) => (i === r.phaseIndex ? { ...p, body: fromBody } : p));
  const toBody = [...next[pi]!.body, moved];
  return next.map((p, i) => (i === pi ? { ...p, body: toBody } : p));
}

/** Rename an item. */
export function editItem(phases: TodoPhase[], ref: string, content: string): TodoPhase[] {
  const r = resolveRef(phases, ref);
  if (!r) return phases;
  return updateItemAt(phases, r, (it) => ({ ...it, content }));
}

/** Promote the first pending item of a phase (or the first active phase) to in_progress. */
export function promoteNext(phases: TodoPhase[], phaseTitle?: string): TodoPhase[] {
  let pi = -1;
  if (phaseTitle) {
    pi = phases.findIndex((p) => normalizeContent(p.title) === normalizeContent(phaseTitle));
  } else {
    pi = phases.findIndex((p) => p.status === "active");
  }
  if (pi < 0) return phases;
  const phase = phases[pi]!;
  // Single-active guard: if an item is already in_progress, don't promote a second.
  if (phase.body.some((e) => e.type === "item" && e.item.status === "in_progress")) return phases;
  const bi = phase.body.findIndex((e) => e.type === "item" && e.item.status === "pending");
  if (bi < 0) return phases;
  return phases.map((p, i) => (i === pi ? mapItemAt(p, bi, (it) => ({ ...it, status: "in_progress" as ItemStatus })) : p));
}

/** Add/remove a dependency edge (opt-in). Returns unchanged if ref not found. */
export function addDependency(phases: TodoPhase[], ref: string, blocksRef: string): TodoPhase[] {
  const r = resolveRef(phases, ref);
  if (!r) return phases;
  return updateItemAt(phases, r, (it) =>
    it.blocks.includes(blocksRef) ? it : { ...it, blocks: [...it.blocks, blocksRef] },
  );
}

/* ------------------------------ DAG validation ---------------------------- */

export type DepIssue =
  | { kind: "self"; phase: string; ref: string }
  | { kind: "cycle"; path: string[] }
  | { kind: "dangling"; phase: string; ref: string; missing: string };

/** Canonical key for a dependency node: the `#id` if present, else normalized content. */
function depKey(it: TodoItem): string {
  return it.id ?? normalizeContent(it.content);
}

/** Resolve a dependency ref to a canonical node key (matching depKey), or null. */
function resolveDepRef(phases: TodoPhase[], ref: string): string | null {
  if (ref.startsWith("#")) {
    for (const p of phases) for (const it of itemsOf(p)) if (it.id === ref) return ref;
    return null;
  }
  // Content ref: normalize and match against item content keys (fuzzy-consistent
  // with resolveRef, not exact-set membership).
  const n = normalizeContent(ref);
  for (const p of phases) for (const it of itemsOf(p)) if (normalizeContent(it.content) === n) return n;
  // Loose fuzzy fallback so a ref that resolveRef would match isn't flagged dangling.
  for (const p of phases) for (const it of itemsOf(p)) if (similarity(it.content, ref) >= 0.6 || normalizeContent(it.content).includes(n) || n.includes(normalizeContent(it.content))) return n;
  return null;
}

/** Collect dependency issues: self-deps, cycles, dangling refs. */
export function validateDeps(phases: TodoPhase[]): DepIssue[] {
  const issues: DepIssue[] = [];

  for (const p of phases) {
    for (const it of itemsOf(p)) {
      const selfKey = depKey(it);
      for (const ref of [...it.blocks, ...it.blockedBy]) {
        // Dangling: the ref doesn't resolve to any item (via the same fuzzy
        // gate resolveRef uses, so a ref that resolves is never flagged).
        if (resolveDepRef(phases, ref) === null) {
          issues.push({ kind: "dangling", phase: p.title, ref: selfKey, missing: ref });
        }
      }
      if (it.blocks.includes(selfKey) || it.blockedBy.includes(selfKey)) {
        issues.push({ kind: "self", phase: p.title, ref: selfKey });
      }
    }
  }

  // Cycle detection on the blocks graph. Edges are normalized to the same key
  // space as nodes (so content refs with case/punctuation differences match).
  const graph = new Map<string, string[]>();
  for (const p of phases) {
    for (const it of itemsOf(p)) {
      const k = depKey(it);
      const edges: string[] = [];
      for (const ref of it.blocks) {
        const resolved = ref.startsWith("#") ? ref : resolveDepRef(phases, ref) ?? normalizeContent(ref);
        edges.push(resolved);
      }
      graph.set(k, edges);
    }
  }
  for (const start of graph.keys()) {
    const path: string[] = [];
    if (dfsCycle(graph, start, start, path, new Set())) {
      // The cycle path is the DFS path (already ends at the back-edge target);
      // don't append `start` again.
      issues.push({ kind: "cycle", path: [...path] });
      break;
    }
  }
  return issues;
}

/**
 * DFS cycle detection. Returns true if a cycle reachable from `start` is found.
 * `path` is the current DFS stack (ends at the node that closes the cycle).
 * Detection (verified correct): a node in `visiting` ∩ `path` is a true back-edge.
 */
function dfsCycle(g: Map<string, string[]>, start: string, node: string, path: string[], visiting: Set<string>): boolean {
  if (visiting.has(node)) return path.includes(node);
  visiting.add(node);
  path.push(node);
  for (const next of g.get(node) ?? []) {
    if (next === start) {
      path.push(start);
      return true;
    }
    if (dfsCycle(g, start, next, path, visiting)) return true;
  }
  path.pop();
  return false;
}