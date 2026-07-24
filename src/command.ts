/**
 * pi-todo — the `/todo` slash command + subcommands (mirrors the tool surface).
 *
 * `/todo`                  → show current list (notify)
 * `/todo add <phase> <c>`  → add item
 * `/todo start <ref>` ...  → ops: start|done|drop|block|unblock|rm|move|edit|promote
 * `/todo edit`             → open $EDITOR on TODO.md, then re-read
 * `/todo refresh`          → re-read from disk
 *
 * Slash command handlers return void; output is shown via `ctx.ui.notify`.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";

import type { TodoStore } from "./store";
import { itemsOf } from "./model";

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
          ctx.ui.notify(viewMessage(store), "info");
          return;
        }
        if (op === "edit") {
          const md = await ctx.ui.editor("Edit TODO.md", readRaw(store));
          if (md === undefined) {
            ctx.ui.notify("Cancelled.", "info");
            return;
          }
          await store.writeRaw(md);
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

function viewMessage(store: TodoStore): string {
  const doc = store.get();
  if (doc.phases.length === 0) return "No todos yet. /todo add <phase> <content>";
  const lines: string[] = ["Todos:"];
  let n = 0;
  for (const phase of doc.phases) {
    const items = itemsOf(phase);
    const done = items.filter((i) => i.status === "completed").length;
    lines.push(`  ${phase.title} (${done}/${items.length})`);
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