/**
 * pi-todo — the `/todo` slash command + subcommands (mirrors the tool surface).
 *
 * `/todo`                  → show current list (notify)
 * `/todo view [filter]`    → show current list; filter: open|pending|in_progress|completed|abandoned|blocked|archived
 * `/todo open`             → show only non-terminal items (additive filter)
 * `/todo archived`         → show the lossless archive
 * `/todo add <phase> <c>`  → add item
 * `/todo archive [phase:ref]` → move completed/abandoned phases to the archive
 * `/todo migrate`          → upgrade TODO.md to the canonical format
 * `/todo start <ref>` ...  → ops: start|done|drop|block|unblock|rm|move|edit|promote
 * `/todo edit`             → open $EDITOR on TODO.md, then re-read
 * `/todo refresh`          → re-read from disk
 *
 * Slash command handlers return void; output is shown via `ctx.ui.notify`.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";

import type { TodoStore } from "./store.js";
import { itemsOf, filterStatuses, isViewFilter } from "./model.js";

export function registerTodoCommand(
  pi: ExtensionAPI,
  store: TodoStore,
  _settings: unknown,
  onUse: () => void,
): void {
  pi.registerCommand("todo", {
    description: "Manage the markdown todo list (.pi/artifacts/TODO.md).",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const a = args.trim();
      const [op, ...rest] = a.split(/\s+/);
      const argStr = rest.join(" ");
      onUse();
      try {
        if (!op || op === "view" || op === "list") {
          const filter = op === "view" && rest[0] ? rest[0] : undefined;
          ctx.ui.notify(
            filter && isViewFilter(filter)
              ? viewMessage(store, filter)
              : viewMessage(store),
            "info",
          );
          return;
        }
        if (op === "open" || op === "active") {
          ctx.ui.notify(viewMessage(store, "open"), "info");
          return;
        }
        if (op === "archived") {
          ctx.ui.notify(viewMessage(store, "archived"), "info");
          return;
        }
        if (op === "archive") {
          const r = await store.archive(argStr.trim() || undefined);
          ctx.ui.notify(
            r.changed
              ? `✓ Archived ${r.archived.length} phase${r.archived.length === 1 ? "" : "s"}: ${r.archived.map((t) => `"${t}"`).join(", ")}.`
              : r.reason ? `✗ ${r.reason}` : "✗ Nothing to archive.",
            r.changed ? "info" : "error",
          );
          return;
        }
        if (op === "migrate") {
          const r = await store.migrate();
          ctx.ui.notify(r.changed ? "✓ Migrated to canonical form." : "✓ Already canonical — no changes.", "info");
          return;
        }
        if (op === "edit") {
          // Snapshot the version we hand to the editor. If anything writes
          // TODO.md while the editor is open (the model's `todo` tool, a
          // subagent reconcile, another shell), writeRaw refuses instead of
          // overwriting it with stale bytes.
          const version = store.version();
          const md = await ctx.ui.editor("Edit TODO.md", readRaw(store));
          if (md === undefined) {
            ctx.ui.notify("Cancelled.", "info");
            return;
          }
          await store.writeRaw(md, version);
          ctx.ui.notify("✓ TODO.md updated from editor.", "info");
          return;
        }
        if (op === "refresh") {
          store.refresh();
          ctx.ui.notify("✓ Refreshed from disk.", "info");
          return;
        }
        if (op === "add") {
          const m = argStr.match(/^(\S+)\s+(.+)$/);
          if (!m) {
            ctx.ui.notify("✗ Usage: /todo add <phase> <content>", "error");
            return;
          }
          await store.add(m[1]!, m[2]!);
          ctx.ui.notify(`✓ Added to "${m[1]}".`, "info");
          return;
        }
        if (OPS.includes(op as (typeof OPS)[number])) {
          ctx.ui.notify(await runOp(store, op, argStr), "info");
          return;
        }
        ctx.ui.notify(`✗ Unknown op. Ops: ${OPS.join("|")} | edit | refresh | view`, "error");
      } catch (e) {
        ctx.ui.notify(`✗ ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });
}

const OPS = ["start", "done", "drop", "block", "unblock", "rm", "move", "edit", "promote"] as const;

async function runOp(store: TodoStore, op: string, argStr: string): Promise<string> {
  const ref = argStr.trim();
  switch (op) {
    case "start":
      return (await store.start(ref)).changed ? "✓ Started." : "✗ Not found.";
    case "done":
      return (await store.done(ref)).changed ? "✓ Completed." : "✗ Not found.";
    case "drop":
      return (await store.drop(ref)).changed ? "✓ Abandoned." : "✗ Not found.";
    case "block":
      return (await store.block(ref)).changed ? "✓ Blocked." : "✗ Not found.";
    case "unblock":
      return (await store.unblock(ref)).changed ? "✓ Unblocked." : "✗ Not found.";
    case "rm":
      return (await store.rm(ref)).changed ? "✓ Removed." : "✗ Not found.";
    case "move": {
      const m = ref.match(/^(.+?)\s+to\s+(.+)$/i);
      if (!m) return "✗ Usage: /todo move <ref> to <phase>";
      return (await store.move(m[1]!, m[2]!)).changed ? "✓ Moved." : "✗ Not found.";
    }
    case "edit": {
      const m = ref.match(/^(.+?)\s+to\s+(.+)$/i) ?? ref.match(/^(.+?)\s+(.+)$/);
      if (!m) return "✗ Usage: /todo edit <ref> to <content>";
      return (await store.edit(m[1]!, m[2]!)).changed ? "✓ Renamed." : "✗ Not found.";
    }
    case "promote":
      return (await store.promote()).changed ? "✓ Promoted." : "✗ Nothing to promote.";
    default:
      return `✗ Unknown op ${op}.`;
  }
}

function viewMessage(store: TodoStore, filter?: string): string {
  if (filter === "archived") {
    const archive = store.getArchive();
    if (archive.length === 0) return "No archived phases.";
    return viewPhases(archive, undefined);
  }
  const doc = store.get();
  if (doc.phases.length === 0) return "No todos yet. /todo add <phase> <content>";
  return viewPhases(doc.phases, filter);
}

function viewPhases(phases: ReturnType<TodoStore["get"]>["phases"], filter?: string): string {
  const statuses = filter ? filterStatuses(filter) : null;
  const lines: string[] = ["Todos:"];
  let n = 0;
  for (const phase of phases) {
    const all = itemsOf(phase);
    const items = statuses ? all.filter((i) => statuses.includes(i.status)) : all;
    if (statuses && items.length === 0) continue;
    const done = all.filter((i) => i.status === "completed").length;
    lines.push(`  ${phase.title} (${done}/${all.length})`);
    for (const it of items) {
      n++;
      lines.push(`    ${n}. [${it.status}] ${it.content}`);
    }
  }
  return lines.join("\n");
}

function readRaw(store: TodoStore): string {
  try {
    return readFileSync(store.filePath, "utf8");
  } catch {
    return "";
  }
}