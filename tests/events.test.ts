import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TodoStore } from "../src/store";
import {
  emitLifecycleEvents,
  contentDigest,
  titleDigest,
  projectDigest,
  computeDocDigest,
  computeIdempotencyKey,
  CHANNEL_ITEM_COMPLETED,
  CHANNEL_PHASE_CLOSED,
} from "../src/events";
import type { TodoDoc } from "../src/markdown";
import type {
  TodoItemCompletedEvent,
  TodoPhaseClosedEvent,
} from "../src/events";
import type { ItemStatus } from "../src/types";

const EMPTY_TODO = "# TODO\n\n";

function doc(
  phases: Array<{
    title: string;
    status: string;
    date?: string;
    items: Array<{ content: string; status: string; id?: string }>;
  }>,
): TodoDoc {
  return {
    preamble: [],
    phases: phases.map((p) => ({
      title: p.title,
      status: p.status as TodoDoc["phases"][number]["status"],
      date: p.date,
      body: p.items.map((i) => ({
        type: "item" as const,
        item: {
          content: i.content,
          status: i.status as ItemStatus,
          id: i.id,
          blocks: [],
          blockedBy: [],
        },
      })),
    })),
  };
}

function createStore(): {
  store: TodoStore;
  afterWriteCalls: Array<{ prev: TodoDoc; next: TodoDoc }>;
  dir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "pi-todo-events-"));
  const todoPath = join(dir, "TODO.md");
  writeFileSync(todoPath, EMPTY_TODO, "utf8");

  const afterWriteCalls: Array<{ prev: TodoDoc; next: TodoDoc }> = [];
  const store = new TodoStore(
    todoPath,
    undefined,
    (prev, next) => {
      afterWriteCalls.push({ prev, next });
    },
  );
  return { store, afterWriteCalls, dir };
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

describe("emitLifecycleEvents", () => {
  it("emits item-completed when a pending item transitions to completed", () => {
    const emitted: Array<{ channel: string; data: unknown }> = [];
    const emit = (channel: string, data: unknown) => {
      emitted.push({ channel, data });
    };

    const prev = doc([
      {
        title: "Phase 1",
        status: "active",
        items: [
          { content: "task A", status: "pending" },
          { content: "task B", status: "in_progress" },
        ],
      },
    ]);
    const next = doc([
      {
        title: "Phase 1",
        status: "active",
        items: [
          { content: "task A", status: "completed" },
          { content: "task B", status: "in_progress" },
        ],
      },
    ]);

    emitLifecycleEvents(emit, "/test/path", prev, next);

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.channel, CHANNEL_ITEM_COMPLETED);
    const event = emitted[0]!.data as TodoItemCompletedEvent;
    assert.equal(event.type, CHANNEL_ITEM_COMPLETED);
    assert.equal(event.projectId, projectDigest("/test/path"));
    assert.equal(event.item.contentDigest, contentDigest("task A"));
    assert.equal(event.item.phaseTitleDigest, titleDigest("Phase 1"));
    assert.equal(event.item.id, undefined);
    assert.ok(event.eventId, "has eventId");
    assert.ok(event.idempotencyKey, "has idempotencyKey");
    assert.equal(event.eventId, event.idempotencyKey);
    assert.ok(event.occurredAt, "has occurredAt");
    assert.ok(event.docDigest, "has docDigest");
    assert.equal(event.docDigest, computeDocDigest(next));
    assert.equal((event as unknown as Record<string, unknown>).projectPath, undefined);
    assert.equal((event.item as unknown as Record<string, unknown>).content, undefined);
    assert.equal((event.item as unknown as Record<string, unknown>).phaseTitle, undefined);
  });

  it("emits a bounded opaque digest when item has an id", () => {
    const emitted: Array<{ channel: string; data: unknown }> = [];
    const emit = (channel: string, data: unknown) => {
      emitted.push({ channel, data });
    };

    const prev = doc([
      {
        title: "Phase 1",
        status: "active",
        items: [{ content: "task with id", status: "pending", id: "42" }],
      },
    ]);
    const next = doc([
      {
        title: "Phase 1",
        status: "active",
        items: [{ content: "task with id", status: "completed", id: "42" }],
      },
    ]);

    emitLifecycleEvents(emit, "/p", prev, next);

    assert.equal(emitted.length, 1);
    const event = emitted[0]!.data as TodoItemCompletedEvent;
    assert.equal(event.item.id, undefined);
    assert.match(event.item.idDigest ?? "", /^[a-f0-9]{64}$/);
    assert.equal(event.item.contentDigest, contentDigest("task with id"));
  });

  it("emits phase-closed when a phase transitions to done", () => {
    const emitted: Array<{ channel: string; data: unknown }> = [];
    const emit = (channel: string, data: unknown) => {
      emitted.push({ channel, data });
    };

    const prev = doc([
      {
        title: "Alpha",
        status: "active",
        items: [
          { content: "item 1", status: "pending" },
          { content: "item 2", status: "completed" },
        ],
      },
    ]);
    const next = doc([
      {
        title: "Alpha",
        status: "done",
        items: [
          { content: "item 1", status: "completed" },
          { content: "item 2", status: "completed" },
        ],
      },
    ]);

    emitLifecycleEvents(emit, "/p", prev, next);

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.channel, CHANNEL_PHASE_CLOSED);
    const event = emitted[0]!.data as TodoPhaseClosedEvent;
    assert.equal(event.type, CHANNEL_PHASE_CLOSED);
    assert.equal(event.phase.titleDigest, titleDigest("Alpha"));
    assert.equal(event.phase.date, undefined);
    assert.equal(event.completedCount, 2);
    assert.ok(event.eventId);
    assert.ok(event.idempotencyKey);
    assert.equal(event.eventId, event.idempotencyKey);
    assert.ok(event.occurredAt);
    assert.ok(event.docDigest);
    assert.equal(event.docDigest, computeDocDigest(next));
    assert.equal((event as unknown as Record<string, unknown>).projectPath, undefined);
    assert.equal((event.phase as unknown as Record<string, unknown>).title, undefined);
  });

  it("does NOT emit item-completed for items in a phase that was just closed", () => {
    const emitted: Array<{ channel: string; data: unknown }> = [];
    const emit = (channel: string, data: unknown) => {
      emitted.push({ channel, data });
    };

    const prev = doc([
      {
        title: "Beta",
        status: "active",
        items: [
          { content: "x", status: "pending" },
          { content: "y", status: "in_progress" },
        ],
      },
    ]);
    const next = doc([
      {
        title: "Beta",
        status: "done",
        items: [
          { content: "x", status: "completed" },
          { content: "y", status: "completed" },
        ],
      },
    ]);

    emitLifecycleEvents(emit, "/p", prev, next);

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.channel, CHANNEL_PHASE_CLOSED);
  });

  it("emits nothing when prev and next are identical", () => {
    const emitted: Array<{ channel: string; data: unknown }> = [];
    const emit = (channel: string, data: unknown) => {
      emitted.push({ channel, data });
    };

    const d = doc([
      {
        title: "Gamma",
        status: "active",
        items: [{ content: "same", status: "pending" }],
      },
    ]);

    emitLifecycleEvents(emit, "/p", d, d);

    assert.equal(emitted.length, 0);
  });

  it("emits nothing when no status transition occurred", () => {
    const emitted: Array<{ channel: string; data: unknown }> = [];
    const emit = (channel: string, data: unknown) => {
      emitted.push({ channel, data });
    };

    const prev = doc([
      {
        title: "Delta",
        status: "active",
        items: [{ content: "a", status: "pending" }],
      },
    ]);
    const next = doc([
      {
        title: "Delta",
        status: "active",
        items: [{ content: "a", status: "in_progress" }],
      },
    ]);

    emitLifecycleEvents(emit, "/p", prev, next);

    assert.equal(emitted.length, 0);
  });

  it("emits multiple item-completed events for multiple items", () => {
    const emitted: Array<{ channel: string; data: unknown }> = [];
    const emit = (channel: string, data: unknown) => {
      emitted.push({ channel, data });
    };

    const prev = doc([
      {
        title: "Epsilon",
        status: "active",
        items: [
          { content: "a", status: "pending" },
          { content: "b", status: "pending" },
        ],
      },
    ]);
    const next = doc([
      {
        title: "Epsilon",
        status: "active",
        items: [
          { content: "a", status: "completed" },
          { content: "b", status: "completed" },
        ],
      },
    ]);

    emitLifecycleEvents(emit, "/p", prev, next);

    assert.equal(emitted.length, 2);
    assert.equal(emitted[0]!.channel, CHANNEL_ITEM_COMPLETED);
    assert.equal(emitted[1]!.channel, CHANNEL_ITEM_COMPLETED);
  });

  it("handles items inserted before the completed item (content-keyed matching)", () => {
    const emitted: Array<{ channel: string; data: unknown }> = [];
    const emit = (channel: string, data: unknown) => {
      emitted.push({ channel, data });
    };

    const prev = doc([
      {
        title: "Zeta",
        status: "active",
        items: [
          { content: "existing", status: "pending" },
          { content: "to-complete", status: "pending" },
        ],
      },
    ]);
    const next = doc([
      {
        title: "Zeta",
        status: "active",
        items: [
          { content: "new item", status: "pending" },
          { content: "existing", status: "pending" },
          { content: "to-complete", status: "completed" },
        ],
      },
    ]);

    emitLifecycleEvents(emit, "/p", prev, next);

    assert.equal(emitted.length, 1);
    const event = emitted[0]!.data as TodoItemCompletedEvent;
    assert.equal(event.item.contentDigest, contentDigest("to-complete"));
  });

  it("fail-open: emit function throwing does not propagate", () => {
    const emit = (_channel: string, _data: unknown) => {
      throw new Error("emit failure");
    };

    const prev = doc([
      {
        title: "Eta",
        status: "active",
        items: [{ content: "x", status: "pending" }],
      },
    ]);
    const next = doc([
      {
        title: "Eta",
        status: "active",
        items: [{ content: "x", status: "completed" }],
      },
    ]);

    emitLifecycleEvents(emit, "/p", prev, next);
  });

  it("fail-open: emit function throwing does not prevent other events", () => {
    let callCount = 0;
    const emit = (_channel: string, _data: unknown) => {
      callCount++;
      if (callCount === 1) throw new Error("first emit fails");
    };

    const prev = doc([
      {
        title: "Theta",
        status: "active",
        items: [
          { content: "a", status: "pending" },
          { content: "b", status: "pending" },
        ],
      },
    ]);
    const next = doc([
      {
        title: "Theta",
        status: "active",
        items: [
          { content: "a", status: "completed" },
          { content: "b", status: "completed" },
        ],
      },
    ]);

    emitLifecycleEvents(emit, "/p", prev, next);
    assert.equal(callCount, 2);
  });

  it("no-op when emit is a no-op (no listener exists)", () => {
    let called = false;
    const emit = (_channel: string, _data: unknown) => {
      called = true;
    };

    const prev = doc([
      {
        title: "Iota",
        status: "active",
        items: [{ content: "x", status: "pending" }],
      },
    ]);
    const next = doc([
      {
        title: "Iota",
        status: "active",
        items: [{ content: "x", status: "completed" }],
      },
    ]);

    emitLifecycleEvents(emit, "/p", prev, next);
    assert.equal(called, true);
  });

  it("phase-closed includes date when phase has one", () => {
    const emitted: Array<{ channel: string; data: unknown }> = [];
    const emit = (channel: string, data: unknown) => {
      emitted.push({ channel, data });
    };

    const prev = doc([
      {
        title: "Kappa",
        status: "active",
        date: "2024-01-15",
        items: [],
      },
    ]);
    const next = doc([
      {
        title: "Kappa",
        status: "done",
        date: "2024-01-15",
        items: [],
      },
    ]);

    emitLifecycleEvents(emit, "/p", prev, next);

    assert.equal(emitted.length, 1);
    const event = emitted[0]!.data as TodoPhaseClosedEvent;
    assert.equal(event.phase.date, "2024-01-15");
  });

  it("deterministic idempotencyKey: same transition produces same key", () => {
    const emitted1: Array<{ channel: string; data: unknown }> = [];
    const emitted2: Array<{ channel: string; data: unknown }> = [];
    const emit1 = (channel: string, data: unknown) => { emitted1.push({ channel, data }); };
    const emit2 = (channel: string, data: unknown) => { emitted2.push({ channel, data }); };

    const prev = doc([
      {
        title: "Lambda",
        status: "active",
        items: [{ content: "replay", status: "pending" }],
      },
    ]);
    const next = doc([
      {
        title: "Lambda",
        status: "active",
        items: [{ content: "replay", status: "completed" }],
      },
    ]);

    emitLifecycleEvents(emit1, "/project", prev, next);
    emitLifecycleEvents(emit2, "/project", prev, next);

    assert.equal(emitted1.length, 1);
    assert.equal(emitted2.length, 1);
    const e1 = emitted1[0]!.data as TodoItemCompletedEvent;
    const e2 = emitted2[0]!.data as TodoItemCompletedEvent;
    assert.equal(e1.idempotencyKey, e2.idempotencyKey);
    assert.equal(e1.eventId, e2.eventId);
  });

  it("deterministic idempotencyKey: different doc produces different key", () => {
    const emitted1: Array<{ channel: string; data: unknown }> = [];
    const emitted2: Array<{ channel: string; data: unknown }> = [];
    const emit1 = (channel: string, data: unknown) => { emitted1.push({ channel, data }); };
    const emit2 = (channel: string, data: unknown) => { emitted2.push({ channel, data }); };

    const prev = doc([
      {
        title: "Mu",
        status: "active",
        items: [{ content: "task", status: "pending" }],
      },
    ]);
    const next1 = doc([
      {
        title: "Mu",
        status: "active",
        items: [{ content: "task", status: "completed" }],
      },
    ]);
    const next2 = doc([
      {
        title: "Mu",
        status: "active",
        items: [{ content: "task", status: "completed" }, { content: "extra", status: "pending" }],
      },
    ]);

    emitLifecycleEvents(emit1, "/project", prev, next1);
    emitLifecycleEvents(emit2, "/project", prev, next2);

    assert.equal(emitted1.length, 1);
    assert.equal(emitted2.length, 1);
    const e1 = emitted1[0]!.data as TodoItemCompletedEvent;
    const e2 = emitted2[0]!.data as TodoItemCompletedEvent;
    assert.notEqual(e1.idempotencyKey, e2.idempotencyKey);
  });

  it("privacy: no absolute project path or raw content in payload", () => {
    const emitted: Array<{ channel: string; data: unknown }> = [];
    const emit = (channel: string, data: unknown) => {
      emitted.push({ channel, data });
    };

    const prev = doc([
      {
        title: "Nu",
        status: "active",
        items: [{ content: "secret content", status: "pending" }],
      },
    ]);
    const next = doc([
      {
        title: "Nu",
        status: "active",
        items: [{ content: "secret content", status: "completed" }],
      },
    ]);

    emitLifecycleEvents(emit, "/home/user/secret-project/TODO.md", prev, next);

    assert.equal(emitted.length, 1);
    const event = emitted[0]!.data as TodoItemCompletedEvent;
    assert.equal(event.projectId, projectDigest("/home/user/secret-project/TODO.md"));
    assert.notEqual(event.projectId, "/home/user/secret-project/TODO.md");
    assert.equal((event as unknown as Record<string, unknown>).projectPath, undefined);
    assert.equal(event.item.contentDigest, contentDigest("secret content"));
    assert.notEqual(event.item.contentDigest, "secret content");
    assert.equal((event.item as unknown as Record<string, unknown>).content, undefined);
    assert.equal((event.item as unknown as Record<string, unknown>).phaseTitle, undefined);
    assert.equal(event.item.phaseTitleDigest, titleDigest("Nu"));
    assert.notEqual(event.item.phaseTitleDigest, "Nu");
  });

  it("duplicate phase titles: uses index-based matching, not title", () => {
    const emitted: Array<{ channel: string; data: unknown }> = [];
    const emit = (channel: string, data: unknown) => {
      emitted.push({ channel, data });
    };

    const prev = doc([
      {
        title: "Same",
        status: "active",
        items: [{ content: "item A", status: "pending" }],
      },
      {
        title: "Same",
        status: "active",
        items: [{ content: "item B", status: "pending" }],
      },
    ]);
    const next = doc([
      {
        title: "Same",
        status: "active",
        items: [{ content: "item A", status: "completed" }],
      },
      {
        title: "Same",
        status: "active",
        items: [{ content: "item B", status: "pending" }],
      },
    ]);

    emitLifecycleEvents(emit, "/p", prev, next);

    assert.equal(emitted.length, 1);
    const event = emitted[0]!.data as TodoItemCompletedEvent;
    assert.equal(event.item.contentDigest, contentDigest("item A"));
  });

  it("duplicate items in same phase: uses occurrence index for subject", () => {
    const emitted: Array<{ channel: string; data: unknown }> = [];
    const emit = (channel: string, data: unknown) => {
      emitted.push({ channel, data });
    };

    const prev = doc([
      {
        title: "Xi",
        status: "active",
        items: [
          { content: "duplicate", status: "pending" },
          { content: "duplicate", status: "pending" },
        ],
      },
    ]);
    const next = doc([
      {
        title: "Xi",
        status: "active",
        items: [
          { content: "duplicate", status: "completed" },
          { content: "duplicate", status: "pending" },
        ],
      },
    ]);

    emitLifecycleEvents(emit, "/p", prev, next);

    assert.equal(emitted.length, 1);
    const event = emitted[0]!.data as TodoItemCompletedEvent;
    assert.equal(event.item.contentDigest, contentDigest("duplicate"));
  });

  it("duplicate items in same phase with mixed statuses match each occurrence once", () => {
    const emitted: Array<{ channel: string; data: unknown }> = [];
    const emit = (channel: string, data: unknown) => {
      emitted.push({ channel, data });
    };

    const prev = doc([
      {
        title: "Omicron",
        status: "active",
        items: [
          { content: "duplicate", status: "pending", id: "same-id" },
          { content: "duplicate", status: "completed", id: "same-id" },
        ],
      },
    ]);
    const next = doc([
      {
        title: "Omicron",
        status: "active",
        items: [
          { content: "duplicate", status: "completed", id: "same-id" },
          { content: "duplicate", status: "completed", id: "same-id" },
        ],
      },
    ]);

    emitLifecycleEvents(emit, "/p", prev, next);

    assert.equal(emitted.length, 1);
    const event = emitted[0]!.data as TodoItemCompletedEvent;
    assert.equal(event.item.contentDigest, contentDigest("duplicate"));
    assert.match(event.item.idDigest ?? "", /^[a-f0-9]{64}$/);
  });

  it("phase-closed: aligns inserted and reordered phases by title, not index", () => {
    const emitted: Array<{ channel: string; data: unknown }> = [];
    const emit = (channel: string, data: unknown) => {
      emitted.push({ channel, data });
    };

    const prev = doc([
      {
        title: "Alpha",
        status: "active",
        items: [{ content: "alpha item", status: "pending" }],
      },
      {
        title: "Beta",
        status: "done",
        items: [{ content: "beta item", status: "completed" }],
      },
    ]);
    const next = doc([
      {
        title: "Beta",
        status: "done",
        items: [{ content: "beta item", status: "completed" }],
      },
      {
        title: "Inserted",
        status: "active",
        items: [],
      },
      {
        title: " alpha ",
        status: "done",
        items: [{ content: "alpha item", status: "completed" }],
      },
    ]);

    emitLifecycleEvents(emit, "/p", prev, next);

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.channel, CHANNEL_PHASE_CLOSED);
    const event = emitted[0]!.data as TodoPhaseClosedEvent;
    assert.equal(event.phase.titleDigest, titleDigest("Alpha"));
  });

  it("item-completed: aligns inserted and reordered phases by title", () => {
    const emitted: Array<{ channel: string; data: unknown }> = [];
    const emit = (channel: string, data: unknown) => {
      emitted.push({ channel, data });
    };

    const prev = doc([
      {
        title: "Alpha",
        status: "active",
        items: [{ content: "alpha item", status: "pending" }],
      },
      {
        title: "Beta",
        status: "active",
        items: [{ content: "beta item", status: "pending" }],
      },
    ]);
    const next = doc([
      {
        title: "Beta",
        status: "active",
        items: [{ content: "beta item", status: "pending" }],
      },
      {
        title: "Inserted",
        status: "active",
        items: [],
      },
      {
        title: " ALPHA ",
        status: "active",
        items: [{ content: "alpha item", status: "completed" }],
      },
    ]);

    emitLifecycleEvents(emit, "/p", prev, next);

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.channel, CHANNEL_ITEM_COMPLETED);
    const event = emitted[0]!.data as TodoItemCompletedEvent;
    assert.equal(event.item.phaseTitleDigest, titleDigest("Alpha"));
  });

  it("phase-closed: only emits once per phase transition", () => {
    const emitted: Array<{ channel: string; data: unknown }> = [];
    const emit = (channel: string, data: unknown) => {
      emitted.push({ channel, data });
    };

    const prev = doc([
      {
        title: "Pi",
        status: "active",
        items: [{ content: "x", status: "pending" }],
      },
    ]);
    const next = doc([
      {
        title: "Pi",
        status: "done",
        items: [{ content: "x", status: "completed" }],
      },
    ]);

    emitLifecycleEvents(emit, "/p", prev, next);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.channel, CHANNEL_PHASE_CLOSED);

    const emitted2: Array<{ channel: string; data: unknown }> = [];
    const emit2 = (channel: string, data: unknown) => { emitted2.push({ channel, data }); };
    emitLifecycleEvents(emit2, "/p", next, next);
    assert.equal(emitted2.length, 0);
  });

  it("custom oversized ids never appear raw or exceed bounded event metadata", () => {
    const emitted: Array<{ channel: string; data: unknown }> = [];
    const emit = (channel: string, data: unknown) => {
      emitted.push({ channel, data });
    };
    const customId = "custom-" + "x".repeat(100_000);

    const prev = doc([
      {
        title: "Sigma",
        status: "active",
        items: [{ content: "private task", status: "pending", id: customId }],
      },
    ]);
    const next = doc([
      {
        title: "Sigma",
        status: "active",
        items: [{ content: "private task", status: "completed", id: customId }],
      },
    ]);

    emitLifecycleEvents(emit, "/p", prev, next);

    assert.equal(emitted.length, 1);
    const event = emitted[0]!.data as TodoItemCompletedEvent;
    const itemPayload = event.item as unknown as Record<string, unknown>;
    assert.equal(itemPayload.id, undefined);
    assert.equal(typeof event.item.idDigest, "string");
    assert.equal(event.item.idDigest?.length, 64);
    assert.ok(!JSON.stringify(event).includes(customId));
    assert.ok(JSON.stringify(event).length < 2_000);
  });

  it("listener throw: fail-open does not crash emitLifecycleEvents", () => {
    let throwOnCall = 0;
    const emit = (_channel: string, _data: unknown) => {
      throwOnCall++;
      if (throwOnCall === 1) throw new Error("listener crash");
    };

    const prev = doc([
      {
        title: "Rho",
        status: "active",
        items: [
          { content: "a", status: "pending" },
          { content: "b", status: "pending" },
        ],
      },
    ]);
    const next = doc([
      {
        title: "Rho",
        status: "active",
        items: [
          { content: "a", status: "completed" },
          { content: "b", status: "completed" },
        ],
      },
    ]);

    emitLifecycleEvents(emit, "/p", prev, next);
    assert.equal(throwOnCall, 2);
  });
});

describe("TodoStore onAfterWrite", () => {
  let store: TodoStore;
  let afterWriteCalls: Array<{ prev: TodoDoc; next: TodoDoc }>;
  let dir: string;

  before(() => {
    const ctx = createStore();
    store = ctx.store;
    afterWriteCalls = ctx.afterWriteCalls;
    dir = ctx.dir;
  });

  after(() => cleanup(dir));

  it("calls onAfterWrite after a successful done() mutation", async () => {
    await store.add("Phase 1", "test item");
    afterWriteCalls.length = 0;

    const result = await store.done("test item");
    assert.equal(result.changed, true);
    assert.equal(afterWriteCalls.length, 1);

    const { prev, next } = afterWriteCalls[0]!;
    const prevItem = prev.phases[0]?.body.find(
      (e): e is Extract<typeof e, { type: "item" }> =>
        e.type === "item" && e.item.content === "test item",
    );
    const nextItem = next.phases[0]?.body.find(
      (e): e is Extract<typeof e, { type: "item" }> =>
        e.type === "item" && e.item.content === "test item",
    );
    assert.ok(prevItem);
    assert.ok(nextItem);
    assert.equal(prevItem.type === "item" && prevItem.item.status, "pending");
    assert.equal(nextItem.type === "item" && nextItem.item.status, "completed");
  });

  it("does NOT call onAfterWrite on no-op done() (already completed)", async () => {
    afterWriteCalls.length = 0;
    const result = await store.done("test item");
    assert.equal(result.changed, false);
    assert.equal(afterWriteCalls.length, 0);
  });

  it("does NOT call onAfterWrite on unknown ref", async () => {
    afterWriteCalls.length = 0;
    const result = await store.done("nonexistent");
    assert.equal(result.changed, false);
    assert.equal(afterWriteCalls.length, 0);
  });

  it("calls onAfterWrite after a successful phase done()", async () => {
    await store.add("Phase 2", "phase item");
    afterWriteCalls.length = 0;

    const result = await store.done("Phase 2");
    assert.equal(result.changed, true);
    assert.equal(afterWriteCalls.length, 1);

    const { prev, next } = afterWriteCalls[0]!;
    const prevPhase = prev.phases.find((p) => p.title === "Phase 2");
    const nextPhase = next.phases.find((p) => p.title === "Phase 2");
    assert.ok(prevPhase);
    assert.ok(nextPhase);
    assert.equal(prevPhase.status, "active");
    assert.equal(nextPhase.status, "done");
  });

  it("does NOT call onAfterWrite on no-op phase done() (already done)", async () => {
    afterWriteCalls.length = 0;
    const result = await store.done("Phase 2");
    assert.equal(result.changed, false);
    assert.equal(afterWriteCalls.length, 0);
  });

  it("calls onAfterWrite after writeRaw()", async () => {
    afterWriteCalls.length = 0;
    await store.writeRaw("# TODO\n\n## Phase 3\n- [ ] raw item\n");
    assert.equal(afterWriteCalls.length, 1);
  });

  it("fail-open: error in onAfterWrite does not crash the store", async () => {
    const dir2 = mkdtempSync(join(tmpdir(), "pi-todo-failopen-"));
    const todoPath = join(dir2, "TODO.md");
    writeFileSync(todoPath, EMPTY_TODO, "utf8");

    const store2 = new TodoStore(
      todoPath,
      undefined,
      () => {
        throw new Error("onAfterWrite crash");
      },
    );

    await store2.add("FailOpen", "item");
    const result = await store2.done("item");
    assert.equal(result.changed, true);

    rmSync(dir2, { recursive: true, force: true });
  });

  it("no onAfterWrite when store write is a true no-op", async () => {
    const dir2 = mkdtempSync(join(tmpdir(), "pi-todo-noop-"));
    const todoPath = join(dir2, "TODO.md");
    writeFileSync(todoPath, EMPTY_TODO, "utf8");

    const calls: Array<{ prev: TodoDoc; next: TodoDoc }> = [];
    const store2 = new TodoStore(todoPath, undefined, (p, n) => { calls.push({ prev: p, next: n }); });

    await store2.add("Test", "item");
    calls.length = 0;

    // done on already-completed item is a true no-op (no auto-promote needed)
    await store2.done("item");
    calls.length = 0;

    const result = await store2.done("item");
    assert.equal(result.changed, false);
    assert.equal(calls.length, 0);

    rmSync(dir2, { recursive: true, force: true });
  });
});
