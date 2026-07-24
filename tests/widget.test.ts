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

// --- P0: bounded widget height (no chatbox crush) ---

test("renderWidgetLines: total height bounded regardless of phase count", () => {
  // 20 active phases × 12 items each must NOT exceed widgetMaxLines.
  const doc = parseMarkdown(
    Array.from(
      { length: 20 },
      (_, i) =>
        `### Phase ${i + 1}\nstatus: active\n` +
        Array.from({ length: 12 }, (_, j) => `- [ ] item ${i + 1}-${j + 1}`).join("\n"),
    ).join("\n\n"),
  );
  const lines = renderWidgetLines(
    { doc, activeSubagentDescriptions: [], spinnerFrame: "◐" },
    { ...S, widgetMaxLines: 10 },
    fakeTheme(),
  );
  assert.ok(lines.length <= 10, `expected ≤10 lines, got ${lines.length}`);
});

test("renderWidgetLines: compact density → exactly 1 line", () => {
  const lines = renderWidgetLines(
    { doc: parseMarkdown(DOC), activeSubagentDescriptions: [], spinnerFrame: "◐" },
    { ...S, widgetDensity: "compact" },
    fakeTheme(),
  );
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.includes("Todos"));
});

test("renderWidgetLines: focused density collapses non-focus phases to one line", () => {
  // Phase A has an in_progress item → it is the focus (expanded).
  // Phase B is active too → must collapse to a single summary line (no item bodies).
  const doc = parseMarkdown(
    `### Phase A\nstatus: active\n\n- [/] doing the thing\n- [ ] then other\n\n` +
      `### Phase B\nstatus: active\n\n- [ ] b one\n- [ ] b two\n- [ ] b three\n`,
  );
  const lines = renderWidgetLines(
    { doc, activeSubagentDescriptions: [], spinnerFrame: "◐" },
    { ...S, widgetDensity: "focused", widgetCollapsedPhases: 3 },
    fakeTheme(),
  );
  const phaseBLines = lines.filter((l) => l.includes("Phase B"));
  assert.equal(phaseBLines.length, 1, `Phase B should be one collapsed line, got ${phaseBLines.length}`);
  assert.ok(!lines.some((l) => l.includes("b one")), "collapsed phase must not render its item bodies");
  assert.ok(lines.some((l) => l.includes("doing the thing")), "focus phase should render its items");
});

test("renderWidgetLines: focus = phase with an in_progress item", () => {
  const doc = parseMarkdown(
    `### Phase A\nstatus: active\n\n- [ ] a one\n\n` +
      `### Phase B\nstatus: active\n\n- [/] actively working\n- [ ] b two\n`,
  );
  const lines = renderWidgetLines(
    { doc, activeSubagentDescriptions: [], spinnerFrame: "◐" },
    { ...S, widgetDensity: "focused" },
    fakeTheme(),
  );
  assert.ok(lines.some((l) => l.includes("actively working")), "in_progress item should be in the focus phase");
  assert.ok(!lines.some((l) => l.includes("a one")), "non-focus phase items must be collapsed away");
});

test("renderWidgetLines: focus step cap respected (… more summary)", () => {
  const doc = parseMarkdown(
    `### Focus\nstatus: active\n\n` +
      Array.from({ length: 10 }, (_, i) => `- [ ] step ${i + 1}`).join("\n") + "\n",
  );
  const lines = renderWidgetLines(
    { doc, activeSubagentDescriptions: [], spinnerFrame: "◐" },
    { ...S, widgetDensity: "focused", widgetItemsPerPhase: 3 },
    fakeTheme(),
  );
  const stepLines = lines.filter((l) => l.includes("step "));
  assert.ok(stepLines.length <= 3, `expected ≤3 focus steps, got ${stepLines.length}`);
  assert.ok(lines.some((l) => l.includes("…")), "should show a 'more' summary when steps exceed the cap");
});

test("renderWidgetLines: widgetMaxLines is a hard safety net", () => {
  const doc = parseMarkdown(
    Array.from(
      { length: 8 },
      (_, i) =>
        `### P${i + 1}\nstatus: active\n` +
        Array.from({ length: 6 }, (_, j) => `- [ ] x${i + 1}-${j + 1}`).join("\n"),
    ).join("\n\n"),
  );
  const lines = renderWidgetLines(
    { doc, activeSubagentDescriptions: [], spinnerFrame: "◐" },
    { ...S, widgetDensity: "focused", widgetMaxLines: 5 },
    fakeTheme(),
  );
  assert.ok(lines.length <= 5, `safety net failed: got ${lines.length} lines, expected ≤5`);
});

test("renderWidgetLines: detailed mode raises the focus/collapse caps", () => {
  // 6 steps + 6 other phases: detailed should show more focus steps than focused.
  const doc = parseMarkdown(
    `### Focus\nstatus: active\n\n` +
      Array.from({ length: 6 }, (_, i) => `- [ ] step ${i + 1}`).join("\n") + "\n\n" +
      Array.from({ length: 6 }, (_, i) => `### Other ${i + 1}\nstatus: active\n\n- [ ] o\n`).join("\n"),
  );
  const focused = renderWidgetLines(
    { doc, activeSubagentDescriptions: [], spinnerFrame: "◐" },
    { ...S, widgetDensity: "focused", widgetItemsPerPhase: 5, widgetCollapsedPhases: 3, widgetMaxLines: 20 },
    fakeTheme(),
  );
  const detailed = renderWidgetLines(
    { doc, activeSubagentDescriptions: [], spinnerFrame: "◐" },
    { ...S, widgetDensity: "detailed", widgetItemsPerPhase: 5, widgetCollapsedPhases: 3, widgetMaxLines: 20 },
    fakeTheme(),
  );
  const focusedSteps = focused.filter((l) => l.includes("step ")).length;
  const detailedSteps = detailed.filter((l) => l.includes("step ")).length;
  assert.ok(detailedSteps >= focusedSteps && detailedSteps > 0, `detailed should show ≥ focused steps (f=${focusedSteps}, d=${detailedSteps})`);
  const focusedCollapsed = focused.filter((l) => l.includes("Other ")).length;
  const detailedCollapsed = detailed.filter((l) => l.includes("Other ")).length;
  assert.ok(detailedCollapsed >= focusedCollapsed, `detailed should collapse ≥ phases (f=${focusedCollapsed}, d=${detailedCollapsed})`);
});

test("renderWidgetLines: fully-done phases are hidden (don't waste a line)", () => {
  const doc = parseMarkdown(
    `### Done A\nstatus: active\n\n- [x] finished\n\n` +
      `### Working\nstatus: active\n\n- [/] still going\n- [ ] todo\n`,
  );
  const lines = renderWidgetLines(
    { doc, activeSubagentDescriptions: [], spinnerFrame: "◐" },
    { ...S, widgetDensity: "focused" },
    fakeTheme(),
  );
  assert.ok(!lines.some((l) => l.includes("Done A")), "a phase with all items completed should be hidden");
  assert.ok(lines.some((l) => l.includes("still going")), "a phase with open work should still be shown");
});

test("renderWidgetLines: every phase done → widget hidden entirely", () => {
  const doc = parseMarkdown(
    `### Done A\nstatus: active\n\n- [x] finished\n\n` +
      `### Done B\nstatus: active\n\n- [x] done\n`,
  );
  const lines = renderWidgetLines(
    { doc, activeSubagentDescriptions: [], spinnerFrame: "◐" },
    { ...S, widgetDensity: "focused" },
    fakeTheme(),
  );
  assert.equal(lines.length, 0);
});