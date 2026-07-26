import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const DIGEST = `sha256:v1:${"a".repeat(64)}`;
const MODULE_PATH = "../src/lifecycle-journal.js";

type LifecycleApi = {
  createLifecycleRecord(input: unknown): {
    streamId: string;
    sequence: number;
    completionEpoch: number;
    usage: { usageId: string; learningId: string };
  };
  parseLifecycleRecord(input: unknown): unknown;
};

async function lifecycle(): Promise<LifecycleApi> {
  return import(MODULE_PATH) as Promise<LifecycleApi>;
}

function usage(): Record<string, unknown> {
  return {
    version: 1,
    usageId: DIGEST,
    projectId: "project-1",
    trustEpoch: "trust-1",
    sessionGeneration: "session-1",
    consumer: { kind: "subagent", id: "task-1" },
    correlationId: "correlation-1",
    requestDigest: DIGEST,
    queryDigest: DIGEST,
    learningId: "learning-1",
    learningRevision: 1,
    learningDigest: DIGEST,
    returnedAt: "2026-07-26T00:00:00.000Z",
  };
}

function record(): Record<string, unknown> {
  return {
    version: 1,
    streamId: "todo-project-1",
    sequence: 1,
    eventId: "item-1:completed:1",
    idempotencyKey: "item-1:completed:1",
    occurredAt: "2026-07-26T00:00:00.000Z",
    itemId: "item-1",
    completionEpoch: 1,
    beforeDigest: DIGEST,
    afterDigest: `sha256:v1:${"b".repeat(64)}`,
    usage: usage(),
  };
}

test("correlated TODO lifecycle records carry stable transition identity and full usage binding", async () => {
  const api = await lifecycle();
  const created = api.createLifecycleRecord(record());
  assert.equal(created.streamId, "todo-project-1");
  assert.equal(created.sequence, 1);
  assert.equal(created.completionEpoch, 1);
  assert.equal(created.usage.usageId, DIGEST);
  assert.equal(created.usage.learningId, "learning-1");
});

test("receipt-id-only and unknown lifecycle fields are rejected", async () => {
  const api = await lifecycle();
  assert.throws(() => api.parseLifecycleRecord({ ...record(), usage: { usageId: DIGEST } }));
  assert.throws(() => api.parseLifecycleRecord({ ...record(), extra: true }));
});

test("recompletion requires a new completion epoch", async () => {
  const api = await lifecycle();
  const first = api.createLifecycleRecord(record());
  const second = api.createLifecycleRecord({
    ...record(),
    sequence: 2,
    eventId: "item-1:completed:2",
    idempotencyKey: "item-1:completed:2",
    completionEpoch: 2,
  });
  assert.notEqual(first.completionEpoch, second.completionEpoch);
});

test("pi-todo exports lifecycle protocols through a public events subpath", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { exports?: Record<string, unknown> };
  assert.ok(manifest.exports?.["./events"]);
});
