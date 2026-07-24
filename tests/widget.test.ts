import { test } from "node:test";
import assert from "node:assert/strict";
import { renderWidgetLines, truncateLine } from "../src/widget";
import { parseMarkdown } from "../src/markdown";
import { DEFAULT_SETTINGS } from "../src/types";
import type { Theme } from "@earendil-works/pi-coding-agent";

// Minimal fake theme: wraps text with color tags so assertions can verify coloring.
function fakeTheme(): Theme {
  return {
    fg: (c: string, t: string) => `<${c}>${t}</${c}>`,
    bg: (_c: string, t: string) => t,
    bold: (t: string) => `<b>${t}</b>`,
    italic: (t: string) => t,
    underline: (t: string) => t,
    inverse: (t: string) => t,
    strikethrough: (t: string) => t,
  } as unknown as Theme;
}

const S = DEFAULT_SETTINGS;

const DOC = `### Phase one
status: active

- [/] active item
- [ ] next item
- [ ] later item
- [x] done item
`;

test("renderWidgetLines: empty doc → []", () => {
  const lines = renderWidgetLines({ doc: { preamble: [], phases: [] }, activeSubagentDescriptions: [], spinnerFrame: "◐" }, S, fakeTheme());
  assert.deepEqual(lines, []);
});

test("renderWidgetLines: root header + phase progress", () => {
  const lines = renderWidgetLines({ doc: parseMarkdown(DOC), activeSubagentDescriptions: [], spinnerFrame: "◐" }, S, fakeTheme());
  // root: 0 done phases / 1 active phase
  assert.ok(lines[0]!.includes("Todos · 0/1"));
  // phase line: "I. Phase one · 1/4"
  assert.ok(lines[1]!.includes("Phase one"));
  assert.ok(lines[1]!.includes("1/4"));
});

test("renderWidgetLines: crash-safe returns [] on bad input", () => {
  // Pass a malformed object that throws inside; the render guards with try/catch.
  const lines = renderWidgetLines(
    { doc: null as unknown as ReturnType<typeof parseMarkdown>, activeSubagentDescriptions: [], spinnerFrame: "◐" },
    S,
    fakeTheme(),
  );
  assert.deepEqual(lines, []);
});

test("renderWidgetLines: matched lighting glows pending item when subagent active", () => {
  const lines = renderWidgetLines(
    { doc: parseMarkdown(DOC), activeSubagentDescriptions: ["next item"], spinnerFrame: "◐" },
    S,
    fakeTheme(),
  );
  // "next item" should be colored accent (matched) even though pending.
  const nextLine = lines.find((l) => l.includes("next item"))!;
  assert.ok(nextLine.includes("<accent>"), `expected accent coloring on matched item, got: ${nextLine}`);
});

test("renderWidgetLines: caps visible items per phase (walking viewport)", () => {
  const big = `### P
status: active

- [/] active
${Array.from({ length: 12 }, (_, i) => `- [ ] pending ${i + 1}`).join("\n")}
`;
  const lines = renderWidgetLines({ doc: parseMarkdown(big), activeSubagentDescriptions: [], spinnerFrame: "◐" }, { ...S, widgetItemsPerPhase: 4 }, fakeTheme());
  // active first + 3 pending fill the cap → 4 items + 1 "… N more" line.
  const itemLines = lines.filter((l) => l.trimStart().startsWith("◻") || l.trimStart().startsWith("◐") || l.includes("active"));
  assert.ok(lines.some((l) => l.includes("…")));
  // Should not render all 12 pending.
  const pendingCount = lines.filter((l) => l.includes("pending")).length;
  assert.ok(pendingCount < 12, `expected capped view, got ${pendingCount} pending lines`);
});

test("truncateLine: ellipsizes to visible width", () => {
  assert.equal(truncateLine("short", 10), "short");
  assert.ok(truncateLine("a very long line here", 10).endsWith("…"));
  assert.ok(truncateLine("a very long line here", 10).length <= 10);
});