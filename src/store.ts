/**
 * pi-todo — store: parse → mutate → serialize with atomic writes + concurrency
 * safety + a debounced fs.watch.
 *
 * Concurrency model (hardened after adversarial review):
 *  - **Inter-process lock** (`proper-lockfile` on `<path>.lock`): the whole
 *    read → mutate → rename critical section runs under it, so a second Pi
 *    process, a second `TodoStore` instance, or an external writer cannot land
 *    between the CAS check and the rename. Optimistic concurrency alone left
 *    that TOCTOU window open and lost updates under real contention.
 *  - **In-process mutex**: all mutations (`apply`, `writeRaw`, `reconcileSubagent`)
 *    funnel through a single promise chain so tool ↔ reconcile ↔ `/todo edit`
 *    never overlap, without paying for the file lock on every queued call.
 *  - **Unique temp file per write** (`${path}.tmp-${randomUUID()}`): two store
 *    instances in one process used to derive the same first temp name from
 *    `${pid}-${seq}` and clobber each other; a UUID cannot collide.
 *  - **Optimistic-concurrency (CAS)** for external writers: `apply` fingerprints
 *    the file *content* before read and before rename; if it changed in the
 *    window, it re-reads + re-applies. Retries are bounded, and exhausting them
 *    THROWS — it never falls through to an unconditional last-write-wins.
 *    (`mtime:size` missed same-millisecond, same-length edits.)
 *  - **Narrowed error handling**: only `ENOENT` means "missing → empty"; an
 *    unreadable/invalid TODO.md (EISDIR/EACCES/parse) throws so we surface it
 *    instead of clobbering real content.
 *  - **fs.watch** filters by basename and diffs before firing `onDocChange`, so
 *    unrelated artifacts writes (PLAN/PROGRESS/MEMORY) don't reset the cadence
 *    or trigger a re-read.
 *
 * No Pi coupling; `onDocChange` is wired by the integration layer.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync, watch, type FSWatcher, type Stats } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { lock } from "proper-lockfile";

import { parseMarkdown, serializeMarkdown, type TodoDoc } from "./markdown.js";
import {
  abandonItem,
  addItem,
  blockItem,
  completeRef,
  completePhase,
  editItem,
  moveItem,
  normalizeDoc,
  parsePhaseRef,
  promoteNext,
  removeItem,
  setItemStatus,
  startItem,
  unblockItem,
  addDependency,
} from "./model.js";
import type { ItemStatus, TodoItem, TodoPhase } from "./types.js";

/**
 * Result of a mutation. `before` is included so a caller can report exactly
 * which items a write touched — a `done` on a phase completes every open item
 * in it, and "✓ Completed" alone hid that blast radius.
 */
export type ApplyResult = { doc: TodoDoc; changed: boolean; before: TodoDoc };

const EMPTY_DOC: TodoDoc = { preamble: [], phases: [] };

/** A held lock older than this is assumed abandoned (crashed process). */
const LOCK_STALE_MS = 10_000;
/** ~2s of patience before we give up waiting for a peer. */
const LOCK_RETRIES = 20;
const LOCK_RETRY_MS = 100;

export class TodoStore {
  private cache: TodoDoc = EMPTY_DOC;
  private watcher: FSWatcher | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<unknown> = Promise.resolve(); // in-process mutex

  constructor(
    private readonly path: string,
    private readonly onDocChange?: (doc: TodoDoc) => void,
    private readonly onAfterWrite?: (prev: TodoDoc, next: TodoDoc) => void | Promise<void>,
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

  /**
   * Opaque fingerprint of the file's current contents. Pass it back to
   * {@link writeRaw} to make an out-of-band edit (e.g. `/todo edit`) refuse
   * rather than clobber a change that landed while the editor was open.
   */
  version(): string {
    return this.versionKey();
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

  /**
   * A content fingerprint for optimistic concurrency.
   *
   * `mtime:size` was cheaper but blind: an external edit landing in the same
   * millisecond that keeps the byte length identical (a one-character swap, a
   * status flip) produced the same key and was silently overwritten.
   */
  private versionKey(): string {
    try {
      const st = statSync(this.path);
      if (!st.isFile()) return "not-a-file";
      return createHash("sha256").update(readFileSync(this.path)).digest("hex");
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "err";
    }
  }

  /**
   * Run `fn` holding the inter-process lock for this TODO file.
   *
   * The lock file lives next to the todo file (`TODO.md.lock`). `startWatch`
   * filters by basename, so lock churn never triggers a re-read.
   */
  private async withFileLock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true });
    let release: () => Promise<void>;
    try {
      release = await lock(this.path, {
        lockfilePath: `${this.path}.lock`,
        realpath: false,
        stale: LOCK_STALE_MS,
        update: LOCK_STALE_MS / 2,
        retries: {
          retries: LOCK_RETRIES,
          factor: 1,
          minTimeout: LOCK_RETRY_MS,
          maxTimeout: LOCK_RETRY_MS,
          randomize: true,
        },
      });
    } catch (e) {
      throw new Error(
        `could not acquire the TODO.md lock (${this.path}.lock): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    try {
      return await fn();
    } finally {
      await release().catch(() => undefined);
    }
  }

  /**
   * Apply a pure transformation to the phases, normalize invariants, and
   * atomically write back — serialized, locked, and CAS-checked.
   */
  async apply(
    fn: (phases: TodoPhase[]) => TodoPhase[],
    opts: { autoPromote?: boolean } = {},
  ): Promise<ApplyResult> {
    return this.enqueue(() => this.withFileLock(async () => {
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
        const mutated = fn(input);
        // Auto-promotion is a CONSEQUENCE of a mutation, never a standalone
        // write. A `done`/`drop` whose ref matched nothing used to still promote
        // the first pending item of every active phase — a ref typo silently
        // started work items. The single-active invariant still always runs.
        const didMutate = serializeMarkdown({ preamble: [], phases: mutated }) !== beforeKey;
        const next = normalizeDoc(mutated, { autoPromote: didMutate && (opts.autoPromote ?? false) });
        if (serializeMarkdown({ preamble: [], phases: next }) === beforeKey) {
          this.cache = before;
          return { doc: before, changed: false, before };
        }
        // CAS: if the file changed between read and write, retry (re-read +
        // re-apply). No `attempt < 4` escape hatch — that made the final
        // attempt an unconditional overwrite, so a writer losing every race
        // still clobbered the file and the throw below was unreachable.
        if (this.versionKey() !== vBefore) continue;
        const doc: TodoDoc = { preamble: before.preamble, phases: next };
        await this.write(doc);
        this.cache = doc;
        this.onDocChange?.(doc);
        try {
          await this.onAfterWrite?.(before, doc);
        } catch {
          // fail open: never let event emission crash the store
        }
        return { doc, changed: true, before };
      }
      throw new Error("TODO.md changed repeatedly during write (CAS retries exhausted)");
    }));
  }

  /**
   * Atomic write with a UNIQUE temp file per call.
   *
   * The name is a UUID, not `${pid}-${seq}`: two `TodoStore` instances in the
   * same process each start their own `seq` at 0, so their first writes used to
   * pick the identical temp path and race — one `writeFile` clobbering the
   * other's bytes, or the loser's `rename` hitting ENOENT.
   */
  private async write(doc: TodoDoc): Promise<void> {
    const md = serializeMarkdown(doc);
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = this.tempPath();
    await writeFile(tmp, md, "utf8");
    await rename(tmp, this.path);
  }

  private tempPath(): string {
    return `${this.path}.tmp-${randomUUID()}`;
  }

  /**
   * Write raw markdown verbatim (`/todo edit`). Serialized + unique temp +
   * compare-and-swap against the version the caller last read, so an external
   * editor or another writer that changed the file in the meantime is not
   * silently overwritten.
   */
  async writeRaw(md: string, expectedVersion?: string): Promise<void> {
    return this.enqueue(() => this.withFileLock(async () => {
      if (expectedVersion !== undefined && this.versionKey() !== expectedVersion) {
        throw new Error("TODO.md changed since it was read (refusing to overwrite)");
      }
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = this.tempPath();
      await writeFile(tmp, md, "utf8");
      await rename(tmp, this.path);
      const prev = this.cache;
      this.cache = this.readSync();
      this.onDocChange?.(this.cache);
      try {
        await this.onAfterWrite?.(prev, this.cache);
      } catch {
        // fail open
      }
    }));
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
  /**
   * Complete one item, or — only for an explicit `phase:<title>` ref — a whole
   * phase. The branch is decided from the ref STRING, not from the cached
   * document: the old code read `this.get().phases` (a cache that may be stale)
   * to choose the branch and then re-read from disk inside `apply()`, so a
   * stale cache could send a ref down the wrong branch.
   */
  async done(ref: string): Promise<ApplyResult> {
    const phaseTitle = parsePhaseRef(ref);
    if (phaseTitle !== null) {
      // Closing a phase promotes only the next active phase, preserving the
      // single-active-task invariant.
      return this.apply((p) => completePhase(p, phaseTitle), { autoPromote: false });
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
      // Explicit `#id` refs in the task description are THE correlation
      // (roadmap 25): "Fix the parser (#3)" reconciles exactly item #3.
      // Fuzzy description matching remains only as a fallback for tasks that
      // carry no refs — and completes at most ONE best match. It used to
      // complete EVERY item that cleared a 0.5 similarity bar, so one
      // successful subagent could close half a phase it never worked on.
      const explicitIds = new Set(description.match(/#\w+/g) ?? []);

      const reconcilable = (it: TodoItem): boolean =>
        it.status === "pending" || it.status === "in_progress" || it.status === "blocked";

      const targets = new Set<TodoItem>();
      if (explicitIds.size > 0) {
        for (const phase of phases) {
          for (const entry of phase.body) {
            if (entry.type !== "item") continue;
            if (!entry.item.id || !explicitIds.has(entry.item.id)) continue;
            if (!reconcilable(entry.item)) continue;
            targets.add(entry.item);
          }
        }
      } else {
        let best: { item: TodoItem; score: number } | undefined;
        for (const phase of phases) {
          for (const entry of phase.body) {
            if (entry.type !== "item") continue;
            const it = entry.item;
            if (!reconcilable(it)) continue;
            if (!fuzzyMatchDesc(it.content, description)) continue;
            const score = similarity(it.content, description);
            if (!best || score > best.score) best = { item: it, score };
          }
        }
        if (best) targets.add(best.item);
      }
      if (targets.size === 0) return phases;

      return phases.map((phase) => ({
        ...phase,
        body: phase.body.map((entry) =>
          entry.type === "item" && targets.has(entry.item)
            ? {
                type: "item" as const,
                item: success
                  ? { ...entry.item, status: "completed" as const }
                  : {
                      ...entry.item,
                      status: "pending" as const,
                      blockerNote: note ?? entry.item.blockerNote,
                    },
              }
            : entry,
        ),
      }));
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

import { normalizeContent, similarity } from "./model.js";
function fuzzyMatchDesc(content: string, description: string): boolean {
  const c = normalizeContent(content);
  const d = normalizeContent(description);
  return similarity(content, description) >= 0.5 || c.includes(d) || d.includes(c);
}