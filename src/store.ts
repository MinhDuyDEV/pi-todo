/**
 * pi-todo — store: parse → mutate → serialize with atomic writes + concurrency
 * safety + a debounced fs.watch.
 *
 * Concurrency model (hardened after adversarial review):
 *  - **In-process mutex**: all mutations (`apply`, `writeRaw`, `reconcileSubagent`)
 *    funnel through a single promise chain so tool ↔ reconcile ↔ `/todo edit`
 *    never overlap. (A lockless read-modify-write previously lost updates.)
 *  - **Unique temp file per write** (`${path}.tmp-${pid}-${seq}`): concurrent
 *    writes no longer share one temp → no ENOENT, no lost-update via rename.
 *  - **Optimistic-concurrency (CAS)** for external writers: `apply` stats the
 *    file (mtime+size) before read and before rename; if the file changed in
 *    the window, it re-reads + re-applies (bounded retries). External edits
 *    ($EDITOR, model bash) are no longer silently clobbered.
 *  - **Narrowed error handling**: only `ENOENT` means "missing → empty"; an
 *    unreadable/invalid TODO.md (EISDIR/EACCES/parse) throws so we surface it
 *    instead of clobbering real content.
 *  - **fs.watch** filters by basename and diffs before firing `onDocChange`, so
 *    unrelated artifacts writes (PLAN/PROGRESS/MEMORY) don't reset the cadence
 *    or trigger a re-read.
 *
 * No Pi coupling; `onDocChange` is wired by the integration layer.
 */
import { readFileSync, statSync, watch, type FSWatcher, type Stats } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

import { parseMarkdown, serializeMarkdown, type TodoDoc } from "./markdown";
import {
  abandonItem,
  addItem,
  blockItem,
  completeRef,
  completePhase,
  editItem,
  findPhase,
  moveItem,
  normalizeDoc,
  promoteNext,
  removeItem,
  resolveRef,
  setItemStatus,
  startItem,
  unblockItem,
  addDependency,
} from "./model";
import type { ItemStatus, TodoItem, TodoPhase } from "./types";

export type ApplyResult = { doc: TodoDoc; changed: boolean };

const EMPTY_DOC: TodoDoc = { preamble: [], phases: [] };

export class TodoStore {
  private cache: TodoDoc = EMPTY_DOC;
  private watcher: FSWatcher | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private writeSeq = 0;
  private chain: Promise<unknown> = Promise.resolve(); // in-process mutex

  constructor(
    private readonly path: string,
    private readonly onDocChange?: (doc: TodoDoc) => void,
    private readonly onAfterWrite?: (prev: TodoDoc, next: TodoDoc) => void,
  ) {
    try {
      this.cache = this.readSync();
    } catch {
      // Tolerant at load: if the file is transiently unreadable, start empty
      // rather than crashing the extension. apply() stays strict (surfaces errors).
      this.cache = EMPTY_DOC;
    }
  }

  /**
   * Read + parse the canonical file. `ENOENT` → empty doc (no throw). Any other
   * fs error (EISDIR/EACCES/…) or parse error THROWS so the caller surfaces it
   * instead of clobbering real content with an empty doc.
   */
  readSync(): TodoDoc {
    let st: Stats;
    try {
      st = statSync(this.path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_DOC;
      throw e;
    }
    if (!st.isFile()) throw new Error(`TODO path is not a regular file: ${this.path}`);
    return parseMarkdown(readFileSync(this.path, "utf8"));
  }

  /** Refresh the cache from disk (fs.watch handler). Best-effort; keeps cache on transient error. */
  refresh(): TodoDoc {
    try {
      const next = this.readSync();
      if (serializeMarkdown(next) !== serializeMarkdown(this.cache)) {
        this.cache = next;
        this.onDocChange?.(next);
      }
    } catch {
      // Transient unreadable state — keep the cached doc.
    }
    return this.cache;
  }

  get(): TodoDoc {
    return this.cache;
  }

  get filePath(): string {
    return this.path;
  }

  /** Serialize `task` onto the in-process mutation chain (mutex). */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task) as Promise<T>;
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** A composite file-version key (mtime + size) for optimistic concurrency. */
  private versionKey(): string {
    try {
      const st = statSync(this.path);
      return `${st.mtimeMs}:${st.size}`;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "err";
    }
  }

  /**
   * Apply a pure transformation to the phases, normalize invariants, and
   * atomically write back — serialized + optimistic-concurrency-safe.
   */
  async apply(
    fn: (phases: TodoPhase[]) => TodoPhase[],
    opts: { autoPromote?: boolean } = {},
  ): Promise<ApplyResult> {
    return this.enqueue(async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const vBefore = this.versionKey();
        let before: TodoDoc;
        try {
          before = this.readSync();
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") before = EMPTY_DOC;
          else throw e;
        }
        // Pass a shallow clone so an in-place-mutating `fn` can't corrupt `before`.
        const input = before.phases.map((p) => ({ ...p, body: [...p.body] }));
        const beforeKey = serializeMarkdown({ preamble: [], phases: before.phases });
        const next = normalizeDoc(fn(input), { autoPromote: opts.autoPromote ?? false });
        if (serializeMarkdown({ preamble: [], phases: next }) === beforeKey) {
          this.cache = before;
          return { doc: before, changed: false };
        }
        // CAS: if the file changed between read and write, retry (re-read + re-apply).
        if (this.versionKey() !== vBefore && attempt < 4) continue;
        const doc: TodoDoc = { preamble: before.preamble, phases: next };
        await this.write(doc);
        this.cache = doc;
        this.onDocChange?.(doc);
        try {
          this.onAfterWrite?.(before, doc);
        } catch {
          // fail open: never let event emission crash the store
        }
        return { doc, changed: true };
      }
      throw new Error("TODO.md changed repeatedly during write (CAS retries exhausted)");
    });
  }

  /** Atomic write with a UNIQUE temp file per call (no shared-temp collision). */
  private async write(doc: TodoDoc): Promise<void> {
    const md = serializeMarkdown(doc);
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}-${this.writeSeq++}`;
    await writeFile(tmp, md, "utf8");
    await rename(tmp, this.path);
  }

  /** Write raw markdown verbatim (`/todo edit`). Serialized + unique temp. */
  async writeRaw(md: string): Promise<void> {
    return this.enqueue(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp-${process.pid}-${this.writeSeq++}`;
      await writeFile(tmp, md, "utf8");
      await rename(tmp, this.path);
      const prev = this.cache;
      this.cache = this.readSync();
      this.onDocChange?.(this.cache);
      try {
        this.onAfterWrite?.(prev, this.cache);
      } catch {
        // fail open
      }
    });
  }

  /* --------------------------- mutation wrappers --------------------------- */

  async add(phaseTitle: string, content: string, afterRef?: string): Promise<ApplyResult> {
    const item: TodoItem = { content, status: "pending", blocks: [], blockedBy: [] };
    return this.apply((p) => addItem(p, phaseTitle, item, afterRef));
  }
  async start(ref: string): Promise<ApplyResult> {
    return this.apply((p) => startItem(p, ref));
  }
  async setStatus(ref: string, status: ItemStatus, note?: string): Promise<ApplyResult> {
    return this.apply((p) => setItemStatus(p, ref, status, note));
  }
  async done(ref: string): Promise<ApplyResult> {
    const phases = this.get().phases;
      // A phase ref closes the whole phase and promotes only the next active phase
      // (preserving the single-active-task invariant); an item ref keeps the existing
      // same-phase + cross-phase auto-promote behavior.
      if (!resolveRef(phases, ref) && findPhase(phases, ref)) {
        return this.apply((p) => completePhase(p, ref), { autoPromote: false });
      }
      return this.apply((p) => completeRef(p, ref), { autoPromote: true });
  }
  async drop(ref: string): Promise<ApplyResult> {
    return this.apply((p) => abandonItem(p, ref), { autoPromote: true });
  }
  async block(ref: string, note?: string): Promise<ApplyResult> {
    return this.apply((p) => blockItem(p, ref, note));
  }
  async unblock(ref: string): Promise<ApplyResult> {
    return this.apply((p) => unblockItem(p, ref));
  }
  async rm(ref: string): Promise<ApplyResult> {
    return this.apply((p) => removeItem(p, ref));
  }
  async move(ref: string, toPhase: string): Promise<ApplyResult> {
    return this.apply((p) => moveItem(p, ref, toPhase));
  }
  async edit(ref: string, content: string): Promise<ApplyResult> {
    return this.apply((p) => editItem(p, ref, content));
  }
  async promote(phaseTitle?: string): Promise<ApplyResult> {
    return this.apply((p) => promoteNext(p, phaseTitle));
  }
  async addDependency(ref: string, blocksRef: string): Promise<ApplyResult> {
    return this.apply((p) => addDependency(p, ref, blocksRef));
  }

  /**
   * Reconcile a subagent's outcome: on success, mark matching open items
   * completed; on failure, revert a matching in_progress item to pending and
   * record the blocker note. Serialized with other mutations via apply().
   */
  async reconcileSubagent(description: string, success: boolean, note?: string): Promise<boolean> {
    const r = await this.apply((phases) => {
      let next = phases;
      for (const phase of next) {
        for (const entry of phase.body) {
          if (entry.type !== "item") continue;
          const it = entry.item;
          if (it.status !== "pending" && it.status !== "in_progress" && it.status !== "blocked") continue;
          if (!fuzzyMatchDesc(it.content, description)) continue;
          next = next.map((p) =>
            p === phase
              ? {
                  ...p,
                  body: p.body.map((e) =>
                    e.type === "item" && e.item === it
                      ? {
                          type: "item" as const,
                          item: success
                            ? { ...it, status: "completed" as const }
                            : { ...it, status: "pending" as const, blockerNote: note ?? it.blockerNote },
                        }
                      : e,
                  ),
                }
              : p,
          );
        }
      }
      return next;
    }, { autoPromote: false });
    return r.changed;
  }

  /* ------------------------------- watching -------------------------------- */

  /** Watch the file's directory for changes to THIS file only (basename filter). */
  startWatch(): void {
    if (this.watcher) return;
    const base = basename(this.path);
    try {
      this.watcher = watch(dirname(this.path), (_event, filename) => {
        if (filename !== base) return; // ignore sibling files (PLAN/PROGRESS/MEMORY)
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.refresh(), 100);
      });
      // Don't let the passive file watcher keep the event loop alive. In a live
      // Pi session the TUI keeps the loop running so the watcher fires normally;
      // in headless/test contexts this lets Node exit instead of hanging.
      this.watcher.unref();
    } catch {
      // Directory may not exist yet; `write()` will create it. Retry not needed —
      // the first mutation re-reads from disk anyway.
    }
  }

  stop(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.watcher?.close();
    this.watcher = null;
  }
}

import { normalizeContent, similarity } from "./model";
function fuzzyMatchDesc(content: string, description: string): boolean {
  const c = normalizeContent(content);
  const d = normalizeContent(description);
  return similarity(content, description) >= 0.5 || c.includes(d) || d.includes(c);
}