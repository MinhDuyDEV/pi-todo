/**
 * Real-session load test: simulates Pi loading the extension via `setup(pi)`
 * with a realistic fake `pi` (whose `on()` returns `void`, matching the real
 * ExtensionAPI), then exercises the full wiring — tool execute, slash command,
 * context-hook reminder, subagent reconcile (foreground done + background
 * running), widget register/render, and the session_shutdown path (the
 * previously-fatal TypeError). This is the closest to a live session without an
 * interactive TTY.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTodoReplayPort } from "../src/replay.js";

interface Handler {
  event: string;
  fn: (e: unknown, ctx?: unknown) => unknown;
}

function fakePi() {
  const handlers: Handler[] = [];
  const tools = new Map<string, { execute: (id: string, p: unknown, s: unknown, u: unknown, ctx: unknown) => Promise<unknown> }>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const bus = new Map<string, ((data: unknown) => void)[]>();
  return {
    on(event: string, fn: (e: unknown, ctx?: unknown) => unknown): void {
      handlers.push({ event, fn });
    },
    registerTool(t: { name: string; execute: (id: string, p: unknown, s: unknown, u: unknown, ctx: unknown) => Promise<unknown> }) {
      tools.set(t.name, t);
    },
    registerCommand(name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, def);
    },
    events: {
      on(ch: string, h: (data: unknown) => void) {
        (bus.get(ch) ?? bus.set(ch, []).get(ch)!).push(h);
        return () => {};
      },
      emit(ch: string, data: unknown) {
        for (const h of bus.get(ch) ?? []) h(data);
      },
    },
    handlers,
    tool: (name: string) => tools.get(name),
    command: (name: string) => commands.get(name),
    dispatch(event: string, e: unknown, ctx?: unknown) {
      for (const h of handlers) if (h.event === event) h.fn(e, ctx);
    },
  };
}

function fakeCtx(hasUI = true, trusted = true) {
  const widgets = new Map<string, unknown>();
  return {
    hasUI,
    cwd: process.cwd(),
    isProjectTrusted: () => trusted,
    ui: {
      _widgets: widgets,
      setWidget(key: string, fn: unknown, _opts?: unknown) {
        widgets.set(key, fn);
      },
      notify(_m: string, _t?: string) {},
      async editor(_t: string, _p?: string) {
        return undefined;
      },
    },
  };
}

async function withTempProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pi-todo-session-"));
  mkdirSync(join(dir, ".pi", "artifacts"), { recursive: true });
  writeFileSync(
    join(dir, ".pi", "settings.json"),
    JSON.stringify({ "pi-todo": { enabled: true, widget: true, reminderTurns: 1 } }),
  );
  writeFileSync(
    join(dir, ".pi", "artifacts", "TODO.md"),
    `### 2026-07-25 - Sprint
status: active | updated: 2026-07-25

- [/] write tests
- [ ] wire up tool
`,
  );
  const old = process.cwd();
  process.chdir(dir);
  try {
    return await fn(dir);
  } finally {
    process.chdir(old);
    rmSync(dir, { recursive: true, force: true });
  }
}

async function waitFor<T>(
  read: () => T,
  matches: (value: T) => boolean,
  timeoutMs = 2_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = read();
    if (matches(value)) return value;
    if (Date.now() >= deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("real-session load: setup() registers tool + command + lifecycle handlers without throwing", async () => {
  await withTempProject(async () => {
    const pi = fakePi();
    const mod = await import("../src/index.js");
    assert.equal(typeof mod.default, "function");
    mod.default(pi as never);
    assert.ok(pi.tool("todo"), "todo tool registered");
    assert.ok(pi.command("todo"), "/todo command registered");
    assert.ok(pi.handlers.some((h) => h.event === "session_start"));
    assert.ok(pi.handlers.some((h) => h.event === "session_shutdown"));
    assert.ok(pi.handlers.some((h) => h.event === "context"));
    // session_shutdown must NOT throw (previously a TypeError from bogus pi.on unsub)
    assert.doesNotThrow(() => pi.dispatch("session_shutdown", {}));
  });
});

test("real-session load: explicit usage IDs populate the durable lifecycle replay journal", async () => {
  await withTempProject(async (dir) => {
    const pi = fakePi();
    (await import("../src/index.js")).default(pi as never);
    // The lifecycle journal binds todo completions into a cross-package trust
    // ledger, so it only runs for a Pi-trusted project.
    pi.dispatch("session_start", {}, fakeCtx(false, true) as never);
    const tagged = (character: string) => `sha256:v1:${character.repeat(64)}`;
    pi.events.emit("pi-learning:v1:usage-receipts-issued", {
      version: 1,
      receipts: [{
        version: 1,
        usageId: tagged("a"),
        projectId: "project-1",
        trustEpoch: "trust-1",
        sessionGeneration: "session-1",
        consumer: { kind: "parent-turn", id: "parent-1" },
        correlationId: "corr-1",
        requestDigest: tagged("b"),
        queryDigest: tagged("c"),
        learningId: "learning-1",
        learningRevision: 1,
        learningDigest: tagged("d"),
        returnedAt: "2026-07-26T00:00:00.000Z",
      }],
    });
    const tool = pi.tool("todo")!;
    await tool.execute("id", { op: "add", phase: "Linked", content: "linked task" }, undefined, undefined, undefined);
    const done = await tool.execute("id", {
      op: "done",
      ref: "phase:Linked",
      usage_ids: [tagged("a")],
    }, undefined, undefined, undefined);
    assert.ok((done as { content: { text: string }[] }).content[0]!.text.includes("✓"));
    const page = await createTodoReplayPort({ projectDirectory: dir }).replay(undefined, 10);
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0]?.usageBindings[0]?.usageId, tagged("a"));
  });
});

test("real-session load: an UNTRUSTED project writes no usage bindings to the ledger", async () => {
  await withTempProject(async (dir) => {
    const pi = fakePi();
    (await import("../src/index.js")).default(pi as never);
    pi.dispatch("session_start", {}, fakeCtx(false, false) as never);
    const tagged = (character: string) => `sha256:v1:${character.repeat(64)}`;
    pi.events.emit("pi-learning:v1:usage-receipts-issued", {
      version: 1,
      receipts: [{
        version: 1,
        usageId: tagged("a"),
        projectId: "project-1",
        trustEpoch: "trust-1",
        sessionGeneration: "session-1",
        consumer: { kind: "parent-turn", id: "parent-1" },
        correlationId: "corr-1",
        requestDigest: tagged("b"),
        queryDigest: tagged("c"),
        learningId: "learning-1",
        learningRevision: 1,
        learningDigest: tagged("d"),
        returnedAt: "2026-07-26T00:00:00.000Z",
      }],
    });
    const tool = pi.tool("todo")!;
    await tool.execute("id", { op: "add", phase: "Linked", content: "linked task" }, undefined, undefined, undefined);
    // The todo itself still works — only the cross-package binding is withheld.
    const done = await tool.execute("id", {
      op: "done",
      ref: "phase:Linked",
      usage_ids: [tagged("a")],
    }, undefined, undefined, undefined);
    assert.ok((done as { content: { text: string }[] }).content[0]!.text.includes("✓"));
    const page = await createTodoReplayPort({ projectDirectory: dir }).replay(undefined, 10);
    assert.equal(page.events.length, 0, "no ledger events for an untrusted project");
  });
});

test("real-session load: tool execute mutates TODO.md and view works", async () => {
  await withTempProject(async (dir) => {
    const pi = fakePi();
    (await import("../src/index.js")).default(pi as never);
    const tool = pi.tool("todo")!;
    const add = await tool.execute("id", { op: "add", phase: "Sprint", content: "new task" }, undefined, undefined, undefined);
    assert.ok((add as { content: { text: string }[] }).content[0]!.text.includes("✓"));
    const view = await tool.execute("id", { op: "view" }, undefined, undefined, undefined);
    assert.ok((view as { content: { text: string }[] }).content[0]!.text.includes("new task"));
    // persisted to disk
    const { readFileSync } = await import("node:fs");
    const onDisk = readFileSync(join(dir, ".pi", "artifacts", "TODO.md"), "utf8");
    assert.ok(onDisk.includes("new task"));
  });
});

test("real-session load: session_start registers the widget and render produces lines", async () => {
  await withTempProject(async () => {
    const pi = fakePi();
    (await import("../src/index.js")).default(pi as never);
    const ctx = fakeCtx(true) as never;
    pi.dispatch("session_start", {}, ctx);
    const widgets = (ctx as unknown as { ui: { _widgets: Map<string, unknown> } }).ui._widgets;
    assert.ok(widgets.has("pi-todos"), "widget registered on session_start");
    const factory = widgets.get("pi-todos") as (tui: unknown, theme: unknown) => { render: (w: number) => string[] };
    const fakeTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as unknown;
    const comp = factory({ requestRender() {} }, fakeTheme);
    const lines = comp.render(80);
    assert.ok(lines.some((l) => l.includes("Sprint")), "widget renders the phase");
    assert.ok(lines.some((l) => l.includes("write tests")), "widget renders the in_progress item");
  });
});

test("real-session load: subagent reconcile (foreground done) marks item completed", async () => {
  await withTempProject(async () => {
    const pi = fakePi();
    (await import("../src/index.js")).default(pi as never);
    const ctx = fakeCtx() as never;
    pi.dispatch("session_start", {}, ctx);
    // foreground task: start → end with phase "done"
    pi.dispatch("tool_execution_start", { toolCallId: "t1", toolName: "task", args: { description: "write the tests" } }, undefined);
    pi.dispatch("tool_execution_end", { toolCallId: "t1", toolName: "task", result: { details: { phase: "done" } }, isError: false }, undefined);
    const todoPath = join(process.cwd(), ".pi", "artifacts", "TODO.md");
    const onDisk = await waitFor(
      () => readFileSync(todoPath, "utf8"),
      (contents) => contents.includes("- [x] write tests"),
    );
    assert.ok(onDisk.includes("- [x] write tests"), "foreground done → item completed on disk");
  });
});

test("real-session load: background task (phase running) is NOT marked completed at launch", async () => {
  await withTempProject(async () => {
    const pi = fakePi();
    (await import("../src/index.js")).default(pi as never);
    pi.dispatch("session_start", {}, fakeCtx() as never);
    pi.dispatch("tool_execution_start", { toolCallId: "b1", toolName: "task", args: { description: "write the tests" } }, undefined);
    pi.dispatch("tool_execution_end", { toolCallId: "b1", toolName: "task", result: { details: { phase: "running" } }, isError: false }, undefined);
    await new Promise((r) => setTimeout(r, 30));
    const onDisk = readFileSync(join(process.cwd(), ".pi", "artifacts", "TODO.md"), "utf8");
    assert.ok(!onDisk.includes("- [x] write tests"), "background task must not be completed at launch");
    assert.ok(onDisk.includes("- [/] write tests"), "background task item stays in_progress");
  });
});

test("real-session load: session_shutdown does not throw and clears subagent tracker", async () => {
  await withTempProject(async () => {
    const pi = fakePi();
    (await import("../src/index.js")).default(pi as never);
    pi.dispatch("session_start", {}, fakeCtx() as never);
    pi.dispatch("tool_execution_start", { toolCallId: "g1", toolName: "task", args: { description: "ghost" } }, undefined);
    // session switch before the task ends — tracker should be cleared, no throw
    assert.doesNotThrow(() => pi.dispatch("session_shutdown", {}));
  });
});
