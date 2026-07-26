/**
 * Lossless round-trip tests: `serialize(parse(x)) === x`.
 *
 * These are DELIBERATELY separate from the idempotence tests in
 * `markdown.test.ts`. Idempotence only says the transform stabilises —
 * a transform that destroys data on the first pass and then leaves the wreckage
 * alone is perfectly idempotent. Every case below was a real data loss the
 * idempotence suite happily passed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown, serializeMarkdown } from "../src/markdown.js";

function assertLossless(label: string, input: string): void {
  const once = serializeMarkdown(parseMarkdown(input));
  assert.equal(once, input, `${label}: not lossless`);
  const twice = serializeMarkdown(parseMarkdown(once));
  assert.equal(twice, once, `${label}: not idempotent`);
}

test("lossless: a valid `status: done` survives an unparseable meta-looking note", () => {
  assertLossless(
    "status: done + status: paused",
    `### Refactor auth
status: done
status: paused

- [x] extract token parser
`,
  );
  // The specific regression: the canonical status line used to be suppressed by
  // the note, so the reparse fell back to the default `active`.
  const doc = parseMarkdown(
    serializeMarkdown(
      parseMarkdown(`### Refactor auth
status: done
status: paused

- [x] a
`),
    ),
  );
  assert.equal(doc.phases[0]!.status, "done");
});

test("lossless: sub-item indentation is not flattened", () => {
  assertLossless(
    "nested items",
    `### Plan
status: active

- [ ] parent
  - [ ] child
    - [ ] grandchild
`,
  );
});

test("lossless: aligned interior whitespace is preserved", () => {
  assertLossless(
    "aligned columns",
    `### Plan
status: active

- [ ] col1     col2
- [x] name          value
`,
  );
});

test("lossless: a mid-line (note: ...) keeps its position", () => {
  assertLossless(
    "mid-line note",
    `### Plan
status: active

- [ ] fix bug (note: only on linux) then ship
`,
  );
});

test("lossless: bullet characters and dependency annotations", () => {
  assertLossless(
    "bullets + deps",
    `### Plan
status: active

* [x] (#3) wire up token refresh [blocks #5]
+ [!] blocked thing [blocked by #3] (note: waiting on infra)
- [/] plain in progress
`,
  );
});

test("lossless: ordinary markdown links round-trip untouched", () => {
  assertLossless(
    "markdown link",
    `### Plan
status: active

- [ ] read [the docs](https://example.dev/a) before starting
`,
  );
});

test("lossless: combined status | updated meta line", () => {
  assertLossless(
    "combined meta",
    `# Preamble

### 2026-07-24 - Refactor auth
status: active | updated: 2026-07-25

- [ ] pending item
some prose

### Done thing
status: done

- [x] shipped
`,
  );
});

test("a mutated item is rebuilt canonically but keeps its indentation and bullet", () => {
  const doc = parseMarkdown(`### Plan
status: active

  * [ ] nested item
`);
  const phase = doc.phases[0]!;
  const entry = phase.body.find((e) => e.type === "item")!;
  assert.equal(entry.type, "item");
  if (entry.type !== "item") return;
  const changed = {
    ...phase,
    body: phase.body.map((e) =>
      e.type === "item" ? { type: "item" as const, item: { ...e.item, status: "completed" as const } } : e,
    ),
  };
  const out = serializeMarkdown({ preamble: [], phases: [changed] });
  assert.match(out, /^ {2}\* \[x\] nested item$/m);
});
