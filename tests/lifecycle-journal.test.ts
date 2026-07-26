import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import {
  LifecycleIdempotencyConflictError,
  LifecycleJournal,
  createLifecycleRecord,
  parseLifecycleRecord,
} from "../src/lifecycle-journal.js";

const digest = (hex: string) => `sha256:v1:${hex.repeat(64 / hex.length)}`;
const usage = {
  version: 1 as const,
  usageId: digest("a"),
  projectId: "project-1",
  trustEpoch: "trust-1",
  sessionGeneration: "session-1",
  consumer: { kind: "subagent" as const, id: "agent-1" },
  correlationId: "corr-1",
  requestDigest: digest("b"),
  queryDigest: digest("d"),
  learningId: "learning-1",
  learningRevision: 1,
  learningDigest: digest("c"),
  returnedAt: "2025-01-01T00:00:00.000Z",
};
const record = (sequence: number, key = `key-${sequence}`, itemId = "item-1", epoch = 1) => createLifecycleRecord({
  version: 1,
  streamId: "stream-1",
  sequence,
  eventId: `event-${sequence}`,
  idempotencyKey: key,
  occurredAt: "2025-01-01T00:00:00.000Z",
  itemId,
  completionEpoch: epoch,
  beforeDigest: digest("0"),
  afterDigest: digest("1"),
  usage,
});

test("lifecycle producer rejects receipt-only usage and unknown fields", () => {
  assert.throws(() => parseLifecycleRecord({ ...record(1), usage: { usageId: digest("a") } }));
  assert.throws(() => parseLifecycleRecord({ ...record(1), unexpected: true }));
});

test("lifecycle journal replays idempotently and repairs a partial WAL tail", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-todo-lifecycle-"));
  const journal = new LifecycleJournal({ directory, streamId: "stream-1" });
  await journal.append(record(1));
  assert.deepEqual(await journal.append(record(1)), record(1));
  await assert.rejects(journal.append({ ...record(1), afterDigest: digest("2") }), LifecycleIdempotencyConflictError);

  await writeFile(journal.walPath, `${await readFile(journal.walPath, "utf8")}partial`);
  assert.equal(await journal.repairTail(), true);
  assert.equal((await journal.replay()).records.length, 1);
});

test("lifecycle journal fails closed on interior corruption and requires a new completion epoch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-todo-lifecycle-"));
  const journal = new LifecycleJournal({ directory, streamId: "stream-1" });
  await journal.append(record(1));
  await assert.rejects(journal.append(record(2, "key-2", "item-1", 1)), /epoch/);
  await journal.append(record(2, "key-2", "item-1", 2));
  const text = await readFile(journal.walPath, "utf8");
  await writeFile(journal.walPath, `${text.replace(/^.*\n/, "broken\n")}`);
  await assert.rejects(journal.replay(), /corruption|invalid|hash/);
});
