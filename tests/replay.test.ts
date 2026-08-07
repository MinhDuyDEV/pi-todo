import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLifecycleJournal, createLifecycleRecord } from "../src/lifecycle-journal.js";
import { createTodoReplayPort } from "../src/replay.js";

const digest = (value: string) => `sha256:v1:${value.repeat(64)}`;
const usage = {
  version: 1 as const,
  usageId: digest("a"),
  projectId: "project-1",
  trustEpoch: "trust-1",
  sessionGeneration: "session-1",
  consumer: { kind: "subagent" as const, id: "task-1" },
  correlationId: "corr-1",
  requestDigest: digest("b"),
  queryDigest: digest("c"),
  learningId: "learning-1",
  learningRevision: 1,
  learningDigest: digest("d"),
  returnedAt: "2026-07-26T00:00:00.000Z",
};

test("public replay port returns prefix-bound usage-complete lifecycle events", async () => {
  const projectDirectory = await mkdtemp(join(tmpdir(), "pi-todo-replay-"));
  try {
    const journal = createLifecycleJournal(
      join(projectDirectory, ".pi", "artifacts", "todo", "lifecycle"),
    );
    await journal.append(createLifecycleRecord({
      version: 1,
      streamId: journal.streamId,
      sequence: 1,
      eventId: digest("9"),
      idempotencyKey: "todo-event-1",
      occurredAt: "2026-07-26T00:00:01.000Z",
      itemId: "todo-1",
      completionEpoch: 1,
      beforeDigest: digest("e"),
      afterDigest: digest("f"),
      usage,
    }));
    const port = createTodoReplayPort({ projectDirectory });
    const first = await port.replay(undefined, 1);
    assert.equal(first.events[0]?.usageBindings[0]?.usageId, usage.usageId);
    assert.match(first.next?.prefixHash ?? "", /^sha256:v1:[0-9a-f]{64}$/);
    assert.deepEqual(await port.replay(first.next, 1), { events: [] });
  } finally {
    await rm(projectDirectory, { recursive: true, force: true });
  }
});

test("public replay port rejects unbounded page sizes", async () => {
  const projectDirectory = await mkdtemp(join(tmpdir(), "pi-todo-replay-limit-"));
  try {
    const port = createTodoReplayPort({ projectDirectory });
    await assert.rejects(port.replay(undefined, 1_001), /limit.*bounds/iu);
    await assert.rejects(port.replay(undefined, 0), /limit.*bounds/iu);
  } finally {
    await rm(projectDirectory, { recursive: true, force: true });
  }
});
