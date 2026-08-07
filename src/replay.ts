import { taggedDigest } from "@minhduydev/pi-core";
import { join } from "node:path";
import {
  createLifecycleJournal,
  type LifecycleCursor,
  type LifecycleRecord,
} from "./lifecycle-journal.js";

export interface TodoReplayCursorV1 {
  version: 1;
  producer: "pi-todo";
  streamId: string;
  streamGeneration: string;
  sequence: number;
  eventId: string;
  prefixHash: string;
  payloadDigest: string;
}

export interface TodoReplayEventV1 {
  version: 1;
  eventId: string;
  sequence: number;
  occurredAt: string;
  type: "todo_item_completed" | "todo_phase_completed";
  completionEpoch: number;
  subjectDigest: string;
  usageBindings: [LifecycleRecord["usage"]];
}

// One of the audit's nine independent taggedDigest copies (§2.2) lived here;
// the digest and its canonicalization rules now come from pi-core.

function publicCursor(cursor: LifecycleCursor): TodoReplayCursorV1 {
  return {
    version: 1,
    producer: "pi-todo",
    streamId: cursor.streamId,
    streamGeneration: cursor.streamGeneration,
    sequence: cursor.sequence,
    eventId: cursor.eventId,
    prefixHash: taggedDigest(cursor),
    payloadDigest: cursor.recordDigest,
  };
}

function internalCursor(cursor: TodoReplayCursorV1): LifecycleCursor {
  if (cursor.version !== 1 || cursor.producer !== "pi-todo") {
    throw new Error("TODO replay cursor belongs to another producer");
  }
  const internal = {
    streamId: cursor.streamId,
    streamGeneration: cursor.streamGeneration,
    sequence: cursor.sequence,
    eventId: cursor.eventId,
    recordDigest: cursor.payloadDigest,
  };
  if (taggedDigest(internal) !== cursor.prefixHash) {
    throw new Error("TODO replay cursor prefix mismatch");
  }
  return internal;
}

function eventFor(record: LifecycleRecord): TodoReplayEventV1 {
  return {
    version: 1,
    eventId: record.eventId,
    sequence: record.sequence,
    occurredAt: record.occurredAt,
    type: record.phaseId && record.phaseId === record.itemId
      ? "todo_phase_completed"
      : "todo_item_completed",
    completionEpoch: record.completionEpoch,
    subjectDigest: record.afterDigest,
    usageBindings: [record.usage],
  };
}

export function createTodoReplayPort(input: { projectDirectory: string }): {
  replay(
    after?: TodoReplayCursorV1,
    limit?: number,
  ): Promise<{ events: TodoReplayEventV1[]; next?: TodoReplayCursorV1 }>;
} {
  const journal = createLifecycleJournal(
    join(input.projectDirectory, ".pi", "artifacts", "todo", "lifecycle"),
  );
  return {
    async replay(after, limit = 64) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw new Error("TODO replay limit must be within bounds 1..1000");
      }
      const page = await journal.replay(after ? internalCursor(after) : undefined, limit);
      return {
        events: page.records.map(eventFor),
        ...(page.records.length > 0 && page.nextCursor
          ? { next: publicCursor(page.nextCursor) }
          : {}),
      };
    },
  };
}
