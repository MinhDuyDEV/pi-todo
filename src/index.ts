/**
 * pi-todo — extension entry.
 *
 * Markdown-first structured todo layer for the Pi coding agent. Wires:
 *  - the `todo` op-discriminator tool (canonical store = .pi/artifacts/TODO.md)
 *  - the `/todo` slash command
 *  - the reminder cadence via the `context` hook (transient, never persisted)
 *  - subagent reconciliation + matched-lighting via the @minhduydev/pi-subagents
 *    eventbus (parent owns artifacts; subagents never write TODO.md)
 *  - the optional bounded widget (oh-my-pi walking-viewport + pi-tasks
 *    crash-safe render), opt-in via settings.json `pi-todo.widget`
 *
 * Declared in package.json: `"pi": { "extensions": ["./src/index.ts"] }`.
 */
import { resolve } from "node:path";
import { homedir } from "node:os";
import { readFileSync, existsSync } from "node:fs";
import type { ExtensionAPI, ContextEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { TodoStore } from "./store";
import { Cadence, buildReminder } from "./cadence";
import { resolveSettings, type PiTodoSettings } from "./types";
import { buildTodoTool } from "./tool";
import { registerTodoCommand } from "./command";
import { SubagentTracker, wireSubagents, type Reconciler } from "./subagents";
import { makeWidgetContent } from "./widget";

export default function setup(pi: ExtensionAPI): void {
  let settings = resolveSettings(readSettings());
  if (!settings.enabled) return;

  const storePath = resolve(process.cwd(), settings.todoFile);
  const tracker = new SubagentTracker();
  const cadence = new Cadence();
  const store = new TodoStore(storePath, () => cadence.onStatusChange());

  // Watch the file for external edits (model, bash, `/todo edit`). The watcher
  // lives for the PROCESS lifetime — do not stop it on session_shutdown (which
  // fires on /clear/resume, not just exit); otherwise edits go undetected after
  // the first session switch. startWatch() is idempotent.
  store.startWatch();

  // --- the tool + slash command -------------------------------------------
  pi.registerTool(buildTodoTool(store, settings, () => cadence.onTodoToolCall()));
  registerTodoCommand(pi, store, settings, () => cadence.onTodoToolCall());

  // --- subagent reconciliation + matched lighting -------------------------
  const reconciler: Reconciler = {
    reconcileSubagent: (d, ok, note) => store.reconcileSubagent(d, ok, note),
  };
  // Returns a cleanup that clears in-process tracker state (no pi.on unsub —
  // Pi's `on` returns void; handlers are process-lifetime).
  const cleanupSubagents = wireSubagents(pi, tracker, reconciler, {
    reconcile: settings.reconcileSubagents,
    onActivity: () => requestRender(),
  });

  // --- the optional widget -------------------------------------------------
  let capturedTui: { requestRender?: () => void } | null = null;
  let widgetRegistered = false;
  let spinnerFrame = "◐";
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  const SPINNER = ["◐", "◓", "◑", "◒"];

  function registerWidget(ctx: ExtensionContext): void {
    if (!settings.widget || !ctx.hasUI) return;
    const ui = ctx.ui as {
      setWidget: (key: string, fn: (tui: unknown, theme: unknown) => unknown, opts: { placement: "aboveEditor" | "belowEditor" }) => void;
    };
    ui.setWidget(
      "pi-todos",
      (tui: unknown, _theme: unknown) => {
        capturedTui = (tui as { requestRender?: () => void }) ?? null;
        return makeWidgetContent(
          () => ({ doc: store.get(), activeSubagentDescriptions: tracker.descriptions, spinnerFrame }),
          settings,
        )(tui as never, _theme as never);
      },
      { placement: settings.widgetPlacement },
    );
    widgetRegistered = true;
  }

  function requestRender(): void {
    capturedTui?.requestRender?.();
  }

  // Spinner only while there is an active item or in-flight subagent.
  function maybeStartSpinner(): void {
    if (spinnerTimer || !widgetRegistered) return;
    spinnerTimer = setInterval(() => {
      spinnerFrame = SPINNER[(SPINNER.indexOf(spinnerFrame) + 1) % SPINNER.length]!;
      const doc = store.get();
      const hasActive =
        doc.phases.some((p) => p.body.some((e) => e.type === "item" && e.item.status === "in_progress")) ||
        tracker.descriptions.length > 0;
      if (hasActive) requestRender();
      else if (spinnerTimer) {
        clearInterval(spinnerTimer);
        spinnerTimer = null;
      }
    }, 200);
    // Don't keep the Node event loop alive solely for the spinner.
    spinnerTimer.unref?.();
  }

  // --- the reminder cadence (context hook, transient) ---------------------
  pi.on("turn_start", () => cadence.onTurnStart());
  pi.on("context", (event: ContextEvent) => {
    const reminder = buildReminder(cadence.snapshot(store.get().phases), settings);
    if (!reminder) return event;
    // Append a transient user message; never persisted to the markdown file.
    return {
      messages: [
        ...event.messages,
        { role: "user" as const, content: [{ type: "text" as const, text: reminder }], timestamp: Date.now() },
      ],
    };
  });

  // --- lifecycle -----------------------------------------------------------
  pi.on("session_start", (_e, ctx: ExtensionContext) => {
    // Re-read settings each session (toggles like widget/cadence may change).
    settings = resolveSettings(readSettings());
    store.refresh();
    // Ensure the watcher is running (idempotent) — it may have been stopped.
    store.startWatch();
    registerWidget(ctx);
    maybeStartSpinner();
  });
  pi.on("turn_end", () => {
    if (widgetRegistered) {
      requestRender();
      maybeStartSpinner();
    }
  });

  pi.on("session_shutdown", () => {
    // session_shutdown fires on /clear/resume/fork/reload, not just exit.
    // try/finally so every cleanup runs even if one throws. Do NOT stop the
    // file watcher (it must survive session switches); do NOT call any pi.on
    // unsubscribe (none exists — `pi.on` returns void).
    try {
      cleanupSubagents(); // clears in-process subagent tracker (avoid ghost lighting)
    } finally {
      if (spinnerTimer) {
        clearInterval(spinnerTimer);
        spinnerTimer = null;
      }
    }
  });
}

/* --------------------------- settings reader ----------------------------- */

/** Read the `pi-todo` block from project `.pi/settings.json` (+ global fallback). */
function readSettings(): PiTodoSettings {
  const project = readJson(resolve(process.cwd(), ".pi/settings.json"));
  const global = readJson(resolve(homedir(), ".pi", "agent", "settings.json"));
  const merged = { ...(global?.["pi-todo"] ?? {}), ...(project?.["pi-todo"] ?? {}) };
  return merged as PiTodoSettings;
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}