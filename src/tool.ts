/**
 * pi-todo — the single `todo` op-discriminator LLM tool.
 *
 * One strict tool with an `op` discriminator + optional params; params IS the
 * op (oh-my-pi style). Every mutating op goes through `TodoStore` which parses
 * the canonical TODO.md → mutates the structured model → enforces invariants →
 * atomically writes back. The file stays the source of truth.
 */
import { Type } from "typebox";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { TodoStore } from "./store.js";
import { itemsOf, parsePhaseRef } from "./model.js";
import type { ApplyResult } from "./store.js";
import type { ItemStatus, PiTodoSettings, TodoPhase } from "./types.js";

export interface TodoUsageScope {
  begin(usageIds: readonly string[]): void;
  end(): void;
}

export function buildTodoTool(
  store: TodoStore,
  settings: Required<PiTodoSettings>,
  onUse: () => void,
  usageScope?: TodoUsageScope,
): ToolDefinition {
  return {
    name: "todo",
    label: "Todo",
    description:
      "Manage the structured markdown todo list at .pi/artifacts/TODO.md. " +
      "The file is the canonical store (human-readable, git-diffable). " +
      "Ops: view | add | start | done | drop | block | unblock | rm | move | edit | promote | deps. " +
      "Refs address ONE item: `#id`, a 1-based index, or fuzzy content (optionally scoped as `<phaseTitle>:<content>`). " +
      "To close an entire phase and complete every open item in it, the ref must be `phase:<title>` — nothing else does that. " +
      "Always `view` after mutating to confirm the result.",
    promptGuidelines: [
      "Prefer the `todo` tool over hand-editing TODO.md so invariants (single-active-task) and atomic writes are enforced.",
      "Append new phases only for distinct work sessions; reuse the active phase for the current task.",
    ],
    parameters: Type.Object({
      op: Type.String({ description: "Operation: view|add|start|done|drop|block|unblock|rm|move|edit|promote|deps" }),
      phase: Type.Optional(Type.String({ description: "Phase title (for add/move/promote)" })),
      content: Type.Optional(Type.String({ description: "Item content (for add/edit)" })),
      ref: Type.Optional(
        Type.String({
          description:
            "Item reference: #id | 1-based index | fuzzy content | <phaseTitle>:<content>. " +
            "Prefix with `phase:` to address a whole phase (done: completes every open item in it).",
        }),
      ),
      status: Type.Optional(
        Type.Union([
          Type.Literal("pending"),
          Type.Literal("in_progress"),
          Type.Literal("completed"),
          Type.Literal("abandoned"),
          Type.Literal("blocked"),
        ]),
      ),
      note: Type.Optional(Type.String({ description: "Blocker note (for block)" })),
      toPhase: Type.Optional(Type.String({ description: "Target phase title (for move)" })),
      after: Type.Optional(Type.String({ description: "Insert after this ref (for add)" })),
      usage_ids: Type.Optional(
        Type.Array(Type.String(), {
          maxItems: 16,
          description: "Exact pi-learning usage receipt IDs for learnings this operation actually uses",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      onUse();
      try {
        const usageIds = Array.isArray((params as Params).usage_ids)
          ? (params as Params).usage_ids.map(String)
          : [];
        usageScope?.begin(usageIds);
        try {
          const r = await dispatch(store, settings, params as Params);
          return textResult(r);
        } finally {
          usageScope?.end();
        }
      } catch (e) {
        return textResult(`✗ todo error: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Params = Record<string, any>;

async function dispatch(store: TodoStore, settings: Required<PiTodoSettings>, p: Params): Promise<string> {
  const op = String(p.op ?? "view").trim();
  const has = (k: string) => p[k] !== undefined && p[k] !== null && String(p[k]).trim() !== "";
  switch (op) {
    case "view": {
      const doc = store.get();
      if (doc.phases.length === 0) return "No todos yet. Use `todo add <phase> <content>`.";
      return viewText(doc.phases);
    }
    case "add": {
      if (!has("phase") || !has("content")) return "✗ `add` requires `phase` and `content`.";
      await store.add(String(p.phase), String(p.content), has("after") ? String(p.after) : undefined);
      return `✓ Added to "${p.phase}". Use \`todo start\` when you begin it.`;
    }
    case "start": {
      if (!has("ref")) return "✗ `start` requires `ref`.";
      const r = await store.start(String(p.ref));
      return r.changed ? "✓ Started (single-active enforced)." : "✗ Could not find that item.";
    }
    case "done": {
      if (!has("ref")) return "✗ `done` requires `ref`.";
      const ref = String(p.ref);
      const r = await store.done(ref);
      if (!r.changed) {
        return parsePhaseRef(ref) !== null
          ? `✗ No phase matched "${ref}".`
          : `✗ No item matched "${ref}". To close a whole phase use ref "phase:<title>".`;
      }
      return `✓ Completed.\n${describeChanges(r)}`;
    }
    case "drop": {
      if (!has("ref")) return "✗ `drop` requires `ref`.";
      const r = await store.drop(String(p.ref));
      return r.changed ? "✓ Abandoned." : "✗ Could not find that item.";
    }
    case "block": {
      if (!has("ref")) return "✗ `block` requires `ref`.";
      const r = await store.block(String(p.ref), has("note") ? String(p.note) : undefined);
      return r.changed ? "✓ Blocked." : "✗ Could not find that item.";
    }
    case "unblock": {
      if (!has("ref")) return "✗ `unblock` requires `ref`.";
      const r = await store.unblock(String(p.ref));
      return r.changed ? "✓ Unblocked → pending." : "✗ Could not find that item.";
    }
    case "rm": {
      if (!has("ref")) return "✗ `rm` requires `ref`.";
      const r = await store.rm(String(p.ref));
      return r.changed ? "✓ Removed." : "✗ Could not find that item.";
    }
    case "move": {
      if (!has("ref") || !has("toPhase")) return "✗ `move` requires `ref` and `toPhase`.";
      const r = await store.move(String(p.ref), String(p.toPhase));
      return r.changed ? `✓ Moved to "${p.toPhase}".` : "✗ Could not find that item.";
    }
    case "edit": {
      if (!has("ref") || !has("content")) return "✗ `edit` requires `ref` and `content`.";
      const r = await store.edit(String(p.ref), String(p.content));
      return r.changed ? "✓ Renamed." : "✗ Could not find that item.";
    }
    case "promote": {
      const r = await store.promote(has("phase") ? String(p.phase) : undefined);
      return r.changed ? "✓ Promoted first pending → in_progress." : "✗ No pending item to promote.";
    }
    case "deps": {
      const { validateDeps } = await import("./model.js");
      const issues = validateDeps(store.get().phases);
      if (!settings.dependencies) return "Dependencies are disabled (set pi-todo.dependencies: true to enable).";
      if (issues.length === 0) return "✓ No dependency issues (cycles, self-deps, dangling refs).";
      return issues
        .map((i) =>
          i.kind === "self"
            ? `⚠ self-dep: ${i.ref} (phase "${i.phase}")`
            : i.kind === "cycle"
              ? `⚠ cycle: ${i.path.join(" → ")}`
              : `⚠ dangling: ${i.ref} references missing ${i.missing} (phase "${i.phase}")`,
        )
        .join("\n");
    }
    default:
      return `✗ Unknown op "${op}". Ops: view|add|start|done|drop|block|unblock|rm|move|edit|promote|deps.`;
  }
}

/**
 * Enumerate exactly what a write changed.
 *
 * `todo done` can complete one item or, for a `phase:` ref, every open item in
 * a phase. Reporting only "✓ Completed" made those indistinguishable, so a
 * mistargeted ref silently closed a whole phase. The caller now sees the list.
 */
function describeChanges(result: ApplyResult): string {
  const key = (phaseTitle: string, index: number) => `${phaseTitle} ${index}`;
  const previous = new Map<string, { content: string; status: ItemStatus }>();
  for (const phase of result.before.phases) {
    itemsOf(phase).forEach((item, i) => {
      previous.set(key(phase.title, i), { content: item.content, status: item.status });
    });
  }

  const lines: string[] = [];
  for (const phase of result.doc.phases) {
    const wasPhase = result.before.phases.find((p) => p.title === phase.title);
    if (wasPhase && wasPhase.status !== phase.status) {
      lines.push(`  phase "${phase.title}": ${wasPhase.status} → ${phase.status}`);
    }
    itemsOf(phase).forEach((item, i) => {
      const was = previous.get(key(phase.title, i));
      if (was && was.status !== item.status) {
        lines.push(`  [${was.status} → ${item.status}] ${item.content}`);
      }
    });
  }
  if (lines.length === 0) return "  (no item status changed)";
  const shown = lines.slice(0, 25);
  if (lines.length > shown.length) shown.push(`  … and ${lines.length - shown.length} more`);
  return shown.join("\n");
}

function viewText(phases: TodoPhase[]): string {
  const lines: string[] = [];
  let n = 0;
  for (const phase of phases) {
    const items = itemsOf(phase);
    const done = items.filter((i) => i.status === "completed").length;
    lines.push(`### ${phase.title} (status: ${phase.status}, ${done}/${items.length} done)`);
    for (const it of items) {
      n++;
      const mark = it.status === "in_progress" ? "/" : it.status === "completed" ? "x" : it.status === "abandoned" ? "-" : it.status === "blocked" ? "!" : " ";
      lines.push(`  ${n}. [${mark}] ${it.content}${it.id ? ` (${it.id})` : ""}${it.blockedBy.length ? ` [blocked by ${it.blockedBy.join(",")}]` : ""}`);
    }
  }
  return lines.join("\n");
}

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: undefined as unknown,
  };
}