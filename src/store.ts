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
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { lock } from "proper-lockfile";
import { redactSecrets } from "@minhduydev/pi-core";

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

/**
 * Result of correlating a terminal delegated task with the canonical TODO.
 *
 * This is intentionally richer than a mutation boolean. A crash can happen
 * after TODO.md is durably replaced but before the lifecycle tracker records
 * its acknowledgement. On restart the same settlement must be distinguishable
 * from a genuinely unmatched description so the former can be acknowledged
 * and the latter remains retryable.
 */
export type SubagentReconcileResult =
  | "applied"
  | "already-applied"
  | "superseded"
  | "unmatched";

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
   * Durable atomic write with a UNIQUE temp file per call.
   *
   * The name is a UUID, not `${pid}-${seq}`: two `TodoStore` instances in the
   * same process each start their own `seq` at 0, so their first writes used to
   * pick the identical temp path and race — one `writeFile` clobbering the
   * other's bytes, or the loser's `rename` hitting ENOENT.
   *
   * The temp file is fsynced before rename and the containing directory is
   * fsynced afterwards. Rename alone prevents torn readers but does not make
   * the replacement durable across a machine crash or power loss.
   */
  private async write(doc: TodoDoc): Promise<void> {
    const md = serializeMarkdown(doc);
    await this.durableReplace(md);
  }

  private tempPath(): string {
    return `${this.path}.tmp-${randomUUID()}`;
  }

  private async durableReplace(contents: string): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true });
    const tmp = this.tempPath();
    let renamed = false;
    try {
      const handle = await open(tmp, "wx", 0o666);
      try {
        await handle.writeFile(contents, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, this.path);
      renamed = true;
      await syncDirectory(directory);
    } finally {
      if (!renamed) await unlink(tmp).catch(() => undefined);
    }
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
      await this.durableReplace(md);
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
   *
   * Explicit refs are fail-closed: every requested id must resolve exactly
   * once, otherwise nothing is changed. Ref-less descriptions choose one
   * unambiguous best open match, falling back to a terminal match only so a
   * post-write crash can be acknowledged idempotently.
   */
  async reconcileSubagent(
    description: string,
    success: boolean,
    note?: string,
  ): Promise<SubagentReconcileResult> {
    // Native fallback callers do not pass through pi-core's bounded parser.
    // Refuse empty/oversized descriptions here rather than letting an empty
    // substring match every TODO item.
    if (
      typeof description !== "string" ||
      typeof success !== "boolean" ||
      (note !== undefined && typeof note !== "string") ||
      description.length === 0 ||
      description.length > 4_000 ||
      (note !== undefined && note.length > 1_000)
    ) {
      return "unmatched";
    }
    const safeNote = note === undefined ? undefined : redactSecrets(note.normalize("NFKC"));
    let result: SubagentReconcileResult = "unmatched";
    await this.apply((phases) => {
      // `apply()` may retry after an out-of-band writer wins the CAS race.
      // Recompute the result against the attempt that will actually persist.
      result = "unmatched";
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
        const byId = new Map<string, TodoItem[]>();
        for (const id of explicitIds) byId.set(id, []);
        for (const phase of phases) {
          for (const entry of phase.body) {
            if (entry.type !== "item" || !entry.item.id) continue;
            byId.get(entry.item.id)?.push(entry.item);
          }
        }
        // Missing or duplicated ids are ambiguous. Do not partially reconcile
        // a multi-ref task and do not widen to fuzzy text.
        if ([...byId.values()].some((matches) => matches.length !== 1)) {
          return phases;
        }
        for (const matches of byId.values()) targets.add(matches[0]!);
      } else {
        const openCandidates: Array<{ item: TodoItem; score: number }> = [];
        const terminalCandidates: Array<{ item: TodoItem; score: number }> = [];
        for (const phase of phases) {
          for (const entry of phase.body) {
            if (entry.type !== "item") continue;
            const it = entry.item;
            if (!fuzzyMatchDesc(it.content, description)) continue;
            const score = similarity(it.content, description);
            (reconcilable(it) ? openCandidates : terminalCandidates).push({ item: it, score });
          }
        }
        const best = unambiguousBest(
          openCandidates.length > 0 ? openCandidates : terminalCandidates,
        );
        if (best) targets.add(best);
      }
      if (targets.size === 0) return phases;

      let changed = false;
      let superseded = false;
      const next = phases.map((phase) => ({
        ...phase,
        body: phase.body.map((entry) => {
          if (entry.type !== "item" || !targets.has(entry.item)) return entry;
          if (!reconcilable(entry.item)) {
            const alreadyApplied = success && entry.item.status === "completed";
            if (!alreadyApplied) superseded = true;
            return entry;
          }
          const item = success
            ? { ...entry.item, status: "completed" as const }
            : {
                ...entry.item,
                status: "pending" as const,
                blockerNote: safeNote ?? entry.item.blockerNote,
              };
          if (
            item.status !== entry.item.status ||
            item.blockerNote !== entry.item.blockerNote
          ) {
            changed = true;
          }
          return { type: "item" as const, item };
        }),
      }));
      result = changed
        ? "applied"
        : superseded
          ? "superseded"
          : "already-applied";
      return next;
    }, { autoPromote: false });
    return result;
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

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Some filesystems/platforms do not permit opening or syncing directories.
    // The file itself was still fsynced before rename.
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function unambiguousBest(
  candidates: ReadonlyArray<{ item: TodoItem; score: number }>,
): TodoItem | undefined {
  if (candidates.length === 0) return undefined;
  const highest = Math.max(...candidates.map((candidate) => candidate.score));
  const best = candidates.filter((candidate) => candidate.score === highest);
  return best.length === 1 ? best[0]!.item : undefined;
}

function fuzzyMatchDesc(content: string, description: string): boolean {
  const c = normalizeContent(content);
  const d = normalizeContent(description);
  return similarity(content, description) >= 0.5 || c.includes(d) || d.includes(c);
}
