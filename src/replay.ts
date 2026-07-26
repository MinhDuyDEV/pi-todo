import { createHash } from "node:crypto";
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

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  const input = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(input).sort().map((key) => [key, canonical(input[key])]));
}

function taggedDigest(value: unknown): string {
  return `sha256:v1:${createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")}`;
}

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
