import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, mkdir, appendFile, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const LIFECYCLE_PROTOCOL_VERSION = 1;
export const LIFECYCLE_STREAM_GENERATION = "sha256:v1:";

export interface UsageConsumer {
  kind: "parent-turn" | "subagent";
  id: string;
}

/** A complete, correlated usage binding. Receipt IDs alone are deliberately invalid. */
export interface UsageBinding {
  version: 1;
  usageId: string;
  projectId: string;
  trustEpoch: string;
  sessionGeneration: string;
  consumer: UsageConsumer;
  correlationId: string;
  requestDigest: string;
  queryDigest: string;
  learningId: string;
  learningRevision: number;
  learningDigest: string;
  returnedAt: string;
}

export interface LifecycleRecord {
  version: 1;
  streamId: string;
  sequence: number;
  eventId: string;
  idempotencyKey: string;
  occurredAt: string;
  itemId: string;
  phaseId?: string;
  completionEpoch: number;
  beforeDigest: string;
  afterDigest: string;
  usage: UsageBinding;
}

export interface LifecycleCursor {
  streamId: string;
  streamGeneration: string;
  sequence: number;
  eventId: string;
  recordDigest: string;
}

export interface ReplayPage {
  records: LifecycleRecord[];
  nextCursor?: LifecycleCursor;
  hasMore: boolean;
}

export interface LifecycleReplayPort {
  replay(cursor?: LifecycleCursor, limit?: number): Promise<ReplayPage>;
}

const RECORD_KEYS = new Set([
  "version", "streamId", "sequence", "eventId", "idempotencyKey", "occurredAt",
  "itemId", "phaseId", "completionEpoch", "beforeDigest", "afterDigest", "usage",
]);
const USAGE_KEYS = new Set([
  "version", "usageId", "projectId", "trustEpoch", "sessionGeneration", "consumer",
  "correlationId", "requestDigest", "queryDigest", "learningId", "learningRevision",
  "learningDigest", "returnedAt",
]);
const CONSUMER_KEYS = new Set(["kind", "id"]);
const DIGEST = /^sha256:v1:[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
  }
}

function assertSafeToken(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error(`${label} must be a non-empty token`);
  }
  // Durable learning records never carry text, credentials, or filesystem paths.
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)) {
    throw new Error(`${label} must be an opaque identifier, not text or a path`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new Error(`${label} must be a v1 digest`);
}

export function parseUsageBinding(input: unknown): UsageBinding {
  if (!isRecord(input)) throw new Error("usage must be an object");
  assertKeys(input, USAGE_KEYS, "usage");
  if (input.version !== 1) throw new Error("usage.version must be 1");
  assertDigest(input.usageId, "usage.usageId");
  assertSafeToken(input.projectId, "usage.projectId");
  assertSafeToken(input.trustEpoch, "usage.trustEpoch");
  assertSafeToken(input.sessionGeneration, "usage.sessionGeneration");
  if (!isRecord(input.consumer)) throw new Error("usage.consumer must be an object");
  assertKeys(input.consumer, CONSUMER_KEYS, "usage.consumer");
  if (input.consumer.kind !== "parent-turn" && input.consumer.kind !== "subagent") {
    throw new Error("usage.consumer.kind is invalid");
  }
  assertSafeToken(input.consumer.id, "usage.consumer.id");
  assertSafeToken(input.correlationId, "usage.correlationId");
  assertDigest(input.requestDigest, "usage.requestDigest");
  assertDigest(input.queryDigest, "usage.queryDigest");
  assertSafeToken(input.learningId, "usage.learningId");
  const learningRevision = input.learningRevision;
  if (!Number.isSafeInteger(learningRevision) || typeof learningRevision !== "number" || learningRevision < 1) {
    throw new Error("usage.learningRevision must be a positive integer");
  }
  assertDigest(input.learningDigest, "usage.learningDigest");
  if (typeof input.returnedAt !== "string" || !Number.isFinite(Date.parse(input.returnedAt))) {
    throw new Error("usage.returnedAt must be an ISO timestamp");
  }
  return {
    version: 1,
    usageId: input.usageId,
    projectId: input.projectId,
    trustEpoch: input.trustEpoch,
    sessionGeneration: input.sessionGeneration,
    consumer: { kind: input.consumer.kind, id: input.consumer.id },
    correlationId: input.correlationId,
    requestDigest: input.requestDigest,
    queryDigest: input.queryDigest,
    learningId: input.learningId,
    learningRevision,
    learningDigest: input.learningDigest,
    returnedAt: input.returnedAt,
  };
}

/** Strict parser for the public producer contract. */
export function parseLifecycleRecord(input: unknown): LifecycleRecord {
  if (!isRecord(input)) throw new Error("lifecycle record must be an object");
  assertKeys(input, RECORD_KEYS, "lifecycle record");
  if (input.version !== 1) throw new Error("unsupported lifecycle record version");
  assertSafeToken(input.streamId, "streamId");
  const sequence = input.sequence;
  if (!Number.isSafeInteger(sequence) || typeof sequence !== "number" || sequence < 1) throw new Error("sequence must be positive");
  assertSafeToken(input.eventId, "eventId");
  assertSafeToken(input.idempotencyKey, "idempotencyKey");
  if (typeof input.occurredAt !== "string" || Number.isNaN(Date.parse(input.occurredAt))) {
    throw new Error("occurredAt must be an ISO timestamp");
  }
  assertSafeToken(input.itemId, "itemId");
  if (input.phaseId !== undefined) assertSafeToken(input.phaseId, "phaseId");
  const completionEpoch = input.completionEpoch;
  if (!Number.isSafeInteger(completionEpoch) || typeof completionEpoch !== "number" || completionEpoch < 1) {
    throw new Error("completionEpoch must be a positive integer");
  }
  assertDigest(input.beforeDigest, "beforeDigest");
  assertDigest(input.afterDigest, "afterDigest");
  return {
    version: 1,
    streamId: input.streamId,
    sequence,
    eventId: input.eventId,
    idempotencyKey: input.idempotencyKey,
    occurredAt: new Date(input.occurredAt).toISOString(),
    itemId: input.itemId,
    ...(input.phaseId === undefined ? {} : { phaseId: input.phaseId }),
    completionEpoch,
    beforeDigest: input.beforeDigest,
    afterDigest: input.afterDigest,
    usage: parseUsageBinding(input.usage),
  };
}

export function createLifecycleRecord(input: unknown): LifecycleRecord {
  return parseLifecycleRecord(input);
}

/** Generate an opaque identity. It intentionally has no content or path input. */
export function createStableIdentity(namespace = "item"): string {
  assertSafeToken(namespace, "namespace");
  return `${namespace}:${randomUUID()}`;
}

export function createStableItemId(): string {
  return createStableIdentity("item");
}

export function assertNewCompletionEpoch(previous: LifecycleRecord | undefined, next: LifecycleRecord): void {
  if (previous && previous.itemId === next.itemId && next.completionEpoch <= previous.completionEpoch) {
    throw new Error(`completion epoch must increase for ${next.itemId}`);
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return `sha256:v1:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function streamGeneration(streamId: string): string {
  return digest({ streamId, protocol: LIFECYCLE_PROTOCOL_VERSION });
}

interface WalEntry {
  version: 1;
  streamGeneration: string;
  previousDigest: string;
  recordDigest: string;
  record: LifecycleRecord;
}

export class LifecycleIdempotencyConflictError extends Error {
  constructor(key: string) {
    super(`lifecycle idempotency key reused with different payload: ${key}`);
    this.name = "LifecycleIdempotencyConflictError";
  }
}

export interface LifecycleJournalOptions {
  directory: string;
  streamId?: string;
  fsync?: boolean;
}

interface LoadedWal {
  entries: WalEntry[];
  repairedTail: boolean;
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function appendDurably(path: string, line: string, shouldFsync: boolean): Promise<void> {
  await appendFile(path, line, "utf8");
  if (shouldFsync) await syncFile(path);
}

export class LifecycleJournal implements LifecycleReplayPort {
  readonly directory: string;
  readonly streamId: string;
  readonly streamGeneration: string;
  private readonly shouldFsync: boolean;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: string | LifecycleJournalOptions) {
    if (typeof options === "string") {
      this.directory = options;
      this.streamId = "todo";
      this.shouldFsync = true;
    } else {
      this.directory = options.directory;
      this.streamId = options.streamId ?? "todo";
      this.shouldFsync = options.fsync ?? true;
    }
    assertSafeToken(this.streamId, "streamId");
    this.streamGeneration = streamGeneration(this.streamId);
  }

  get walPath(): string { return join(this.directory, "lifecycle.wal"); }
  get snapshotPath(): string { return join(this.directory, "lifecycle.snapshot.json"); }
  get outboxPath(): string { return join(this.directory, "lifecycle.outbox"); }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.chain.then(task, task) as Promise<T>;
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }

  private async readWal(repairTail: boolean): Promise<LoadedWal> {
    let text: string;
    try { text = await readFile(this.walPath, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], repairedTail: false };
      throw error;
    }
    if (text.length === 0) return { entries: [], repairedTail: false };
    const rawLines = text.split("\n");
    const hasPartialTail = rawLines.at(-1) !== "";
    const lines = hasPartialTail ? rawLines : rawLines.slice(0, -1);
    const entries: WalEntry[] = [];
    let previousDigest = "";
    for (let index = 0; index < lines.length; index++) {
      let parsed: unknown;
      try { parsed = JSON.parse(lines[index]!); }
      catch {
        // Only a physically incomplete final line is repairable. A complete line
        // (including one ending in a newline) is an interior corruption signal.
        if (hasPartialTail && index === lines.length - 1 && repairTail) {
          const prefix = lines.slice(0, -1).join("\n");
          await truncate(this.walPath, Buffer.byteLength(prefix ? `${prefix}\n` : ""));
          if (this.shouldFsync) await syncFile(this.walPath);
          return { entries, repairedTail: true };
        }
        throw new Error(`lifecycle WAL corruption at line ${index + 1}`);
      }
      if (!isRecord(parsed)) throw new Error(`lifecycle WAL entry ${index + 1} is not an object`);
      const entry = parsed as unknown as WalEntry;
      if (entry.version !== 1 || entry.streamGeneration !== this.streamGeneration || typeof entry.recordDigest !== "string" || typeof entry.previousDigest !== "string") {
        throw new Error(`invalid lifecycle WAL entry ${index + 1}`);
      }
      const record = parseLifecycleRecord(entry.record);
      if (record.streamId !== this.streamId || record.sequence !== index + 1 || entry.previousDigest !== previousDigest || entry.recordDigest !== digest(record)) {
        throw new Error(`lifecycle WAL hash or sequence mismatch at line ${index + 1}`);
      }
      entries.push({ version: 1, streamGeneration: entry.streamGeneration, previousDigest: entry.previousDigest, recordDigest: entry.recordDigest, record });
      previousDigest = entry.recordDigest;
    }
    if (hasPartialTail && repairTail) {
      await appendFile(this.walPath, "\n", "utf8");
      if (this.shouldFsync) await syncFile(this.walPath);
      return { entries, repairedTail: true };
    }
    if (hasPartialTail) throw new Error("lifecycle WAL has an unterminated tail");
    return { entries, repairedTail: false };
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
  }

  private async writeSnapshot(entries: WalEntry[]): Promise<void> {
    const snapshot = JSON.stringify({ version: 1, streamId: this.streamId, streamGeneration: this.streamGeneration, entries }, null, 2) + "\n";
    const tmp = `${this.snapshotPath}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(tmp, snapshot, "utf8");
    if (this.shouldFsync) await syncFile(tmp);
    await rename(tmp, this.snapshotPath);
    if (this.shouldFsync) await syncDirectory(this.directory);
  }

  private async readOutbox(repairTail: boolean): Promise<LifecycleRecord[]> {
    let text: string;
    try { text = await readFile(this.outboxPath, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (!text) return [];
    const rawLines = text.split("\n");
    const hasPartialTail = rawLines.at(-1) !== "";
    const lines = hasPartialTail ? rawLines : rawLines.slice(0, -1);
    const records: LifecycleRecord[] = [];
    for (let index = 0; index < lines.length; index++) {
      let parsed: unknown;
      try { parsed = JSON.parse(lines[index]!); } catch {
        if (hasPartialTail && index === lines.length - 1 && repairTail) {
          const prefix = lines.slice(0, -1).join("\n");
          await truncate(this.outboxPath, Buffer.byteLength(prefix ? `${prefix}\n` : ""));
          if (this.shouldFsync) await syncFile(this.outboxPath);
          return records;
        }
        throw new Error(`lifecycle outbox corruption at line ${index + 1}`);
      }
      if (!isRecord(parsed) || typeof parsed.recordDigest !== "string") throw new Error("lifecycle outbox entry is invalid");
      const record = { ...parsed };
      delete record.recordDigest;
      const parsedRecord = parseLifecycleRecord(record);
      if (parsed.recordDigest !== digest(parsedRecord)) throw new Error(`lifecycle outbox hash mismatch at line ${index + 1}`);
      records.push(parsedRecord);
    }
    if (hasPartialTail && repairTail) {
      await appendFile(this.outboxPath, "\n", "utf8");
      if (this.shouldFsync) await syncFile(this.outboxPath);
    } else if (hasPartialTail) {
      throw new Error("lifecycle outbox has an unterminated tail");
    }
    return records;
  }

  private async reconcileOutbox(entries: WalEntry[]): Promise<void> {
    const existing = await this.readOutbox(true);
    const existingKeys = new Set(existing.map((record) => record.idempotencyKey));
    for (const entry of entries) {
      if (existingKeys.has(entry.record.idempotencyKey)) continue;
      await appendDurably(this.outboxPath, JSON.stringify({ recordDigest: entry.recordDigest, ...entry.record }) + "\n", this.shouldFsync);
      existingKeys.add(entry.record.idempotencyKey);
    }
  }

  /** Repair a partial final WAL line and reject all interior corruption. */
  async repairTail(): Promise<boolean> {
    return this.enqueue(async () => (await this.readWal(true)).repairedTail);
  }

  /** Complete the snapshot/outbox side of a WAL commit after a crash window. */
  private async recoverNow(): Promise<LifecycleRecord[]> {
    await this.ensureDirectory();
    const loaded = await this.readWal(true);
    if (loaded.entries.length > 0) {
      await this.writeSnapshot(loaded.entries);
      await this.reconcileOutbox(loaded.entries);
    }
    return loaded.entries.map((entry) => entry.record);
  }

  async recover(): Promise<LifecycleRecord[]> {
    return this.enqueue(() => this.recoverNow());
  }

  async append(input: unknown): Promise<LifecycleRecord> {
    const record = parseLifecycleRecord(input);
    if (record.streamId !== this.streamId) throw new Error("record belongs to another stream");
    return this.enqueue(async () => {
      await this.ensureDirectory();
      const loaded = await this.readWal(true);
      const existing = loaded.entries.find((entry) => entry.record.idempotencyKey === record.idempotencyKey);
      if (existing) {
        if (digest(existing.record) !== digest(record)) throw new LifecycleIdempotencyConflictError(record.idempotencyKey);
        return existing.record;
      }
      const previous = loaded.entries.at(-1);
      if (record.sequence !== loaded.entries.length + 1) throw new Error("lifecycle sequence is not contiguous");
      const previousForItem = [...loaded.entries].reverse().find((entry) => entry.record.itemId === record.itemId);
      assertNewCompletionEpoch(previousForItem?.record, record);
      const entry: WalEntry = {
        version: 1,
        streamGeneration: this.streamGeneration,
        previousDigest: previous?.recordDigest ?? "",
        recordDigest: digest(record),
        record,
      };
      // WAL is durable before the snapshot is replaced. Recovery can finish the
      // commit if the process dies between these operations.
      await appendDurably(this.walPath, JSON.stringify(entry) + "\n", this.shouldFsync);
      const all = [...loaded.entries, entry];
      await this.writeSnapshot(all);
      await this.reconcileOutbox(all);
      return record;
    });
  }

  async replay(cursor?: LifecycleCursor, limit = 100): Promise<ReplayPage> {
    return this.enqueue(async () => {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("replay limit must be positive");
      await this.recoverNow();
      const loaded = await this.readWal(false);
      if (cursor && (cursor.streamId !== this.streamId || cursor.streamGeneration !== this.streamGeneration)) {
        throw new Error("cursor belongs to another lifecycle stream");
      }
      const start = cursor ? loaded.entries.findIndex((entry) => entry.recordDigest === cursor.recordDigest) + 1 : 0;
      if (cursor && start === 0) throw new Error("cursor is not in lifecycle stream");
      const selected = loaded.entries.slice(start, start + limit);
      const last = selected.at(-1);
      const nextCursor = last ? {
        streamId: this.streamId,
        streamGeneration: this.streamGeneration,
        sequence: last.record.sequence,
        eventId: last.record.eventId,
        recordDigest: last.recordDigest,
      } : cursor;
      return { records: selected.map((entry) => entry.record), nextCursor, hasMore: start + selected.length < loaded.entries.length };
    });
  }

  async outbox(): Promise<LifecycleRecord[]> {
    return this.enqueue(async () => {
      await this.recoverNow();
      return this.readOutbox(true);
    });
  }
}

export function createLifecycleJournal(options: string | LifecycleJournalOptions): LifecycleJournal {
  return new LifecycleJournal(options);
}

export function createLifecycleReplayPort(journal: LifecycleJournal): LifecycleReplayPort {
  return { replay: (cursor, limit) => journal.replay(cursor, limit) };
}

export function isCorrelatedLifecycleRecord(value: unknown): value is LifecycleRecord {
  try { parseLifecycleRecord(value); return true; } catch { return false; }
}
