import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TodoStore } from "../src/store.js";
import { buildTodoTool } from "../src/tool.js";
import { renderWidgetLines } from "../src/widget.js";
import { DEFAULT_SETTINGS } from "../src/types.js";
import { parseMarkdown } from "../src/markdown.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
type ToolOut = { content: { type: string; text: string }[]; details: unknown };
function textOf(r: { content: { type: string; text?: string }[] }): string {
  return r.content[0]?.text ?? "";
}


const S = DEFAULT_SETTINGS;
const fakeTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as unknown as Theme;

function setup(doc = ""): { store: TodoStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "pi-todo-e2e-"));
  const file = join(dir, "TODO.md");
  if (doc) writeFileSync(file, doc, "utf8");
  return { store: new TodoStore(file), dir };
}

const DOC = `### A - sprint
status: active

- [ ] write tests
- [ ] wire up tool
`;

test("e2e: tool add → start → done → widget reflects", async () => {
  const { store } = setup(DOC);
  let uses = 0;
  const tool = buildTodoTool(store, S, () => uses++);

  const call = async (params: Record<string, unknown>) => {
    const r = await tool.execute("call-id", params, undefined as never, undefined as never, undefined as never);
    return textOf(r as ToolOut);
  };

  // add
  let out = await call({ op: "add", phase: "A - sprint", content: "new feature" });
  assert.ok(out.includes("✓"));
  assert.equal(uses, 1, "onUse (cadence reset) should fire on each tool call");

  // start the new item
  out = await call({ op: "start", ref: "new feature" });
  assert.ok(out.includes("✓"), out);

  // done
  out = await call({ op: "done", ref: "new feature" });
  assert.ok(out.includes("✓"));

  const doc = store.get();
  const it = doc.phases[0]!.body.find((e) => e.type === "item" && e.item.content === "new feature")!;
  assert.equal(it.type, "item");
  assert.equal(it.item.status, "completed");

  // widget renders the completed phase
  const lines = renderWidgetLines({ doc, activeSubagentDescriptions: [], spinnerFrame: "◐" }, S, fakeTheme);
  assert.ok(lines.some((l) => l.includes("A - sprint")), "widget should show the phase");
});

test("e2e: unknown op returns error text, does not throw", async () => {
  const { store } = setup(DOC);
  const tool = buildTodoTool(store, S, () => {});
  const r = await tool.execute("id", { op: "bogus" }, undefined as never, undefined as never, undefined as never);
  assert.ok(textOf(r as ToolOut).includes("✗"));
});

test("e2e: add missing phase+content returns guidance, no mutation", async () => {
  const { store } = setup(DOC);
  const tool = buildTodoTool(store, S, () => {});
  const r = await tool.execute("id", { op: "add" }, undefined as never, undefined as never, undefined as never);
  assert.ok(textOf(r as ToolOut).includes("✗"));
  assert.equal(store.get().phases.length, 1);
});

test("e2e: view op returns a structured list", async () => {
  const { store } = setup(DOC);
  const tool = buildTodoTool(store, S, () => {});
  const r = await tool.execute("id", { op: "view" }, undefined as never, undefined as never, undefined as never);
  const text = textOf(r as ToolOut);
  assert.ok(text.includes("A - sprint"));
  assert.ok(text.includes("write tests"));
});

test("e2e: subagent reconcile marks matching item done + widget lights up while in-flight", async () => {
  const { store } = setup(DOC);
  // simulate a live subagent working on "wire up tool"
  const linesBefore = renderWidgetLines(
    { doc: store.get(), activeSubagentDescriptions: ["wire up the tool"], spinnerFrame: "◐" },
    S,
    fakeTheme,
  );
  assert.ok(linesBefore.some((l) => l.includes("wire up tool")), "matched item should render");

  // subagent settles successfully → reconcile
  const result = await store.reconcileSubagent("wire up the tool", true);
  assert.equal(result, "applied");
  const it = store.get().phases[0]!.body.find((e) => e.type === "item" && e.item.content === "wire up tool")!;
  assert.equal(it.type, "item");
  assert.equal(it.item.status, "completed");
});
