# pi-todo

A **markdown-first** structured todo layer for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).

`pi-todo` keeps `.pi/artifacts/TODO.md` as the **canonical, human-readable, git-diffable** store and adds a structured phased model with **markdown round-trip**, a reminder cadence, optional dependencies (DAG), subagent reconciliation, and a bounded widget.

> Distilled from three sources, taking the best of each:
> - **pi-harness** — durable markdown artifact + skill-driven lifecycle as the source of truth.
> - **oh-my-pi** — phased `TodoItem` model + `phasesToMarkdown`/`markdownToPhases` round-trip + single-op tool + single-active-task invariant + subagent reconciliation.
> - **pi-tasks** — pure, unit-testable reminder **cadence** via the `context` hook (transient, never persisted) + optional DAG + crash-safe widget render.

## What's new in 0.4.0

- The typed `pi-subagents:task-started` / `task-settled` lifecycle is now the **authoritative** reconciliation path, tracked durably by task ID in `.pi/artifacts/todo/subagent-tasks.json` (atomic fsynced writes, inter-process lock, idempotent replay across restart, duplicate, and out-of-order delivery).
- A TODO completes only when **both** the terminal and child-reported outcomes say `success`; blocked, partial, failed, reframed, or awaiting-decision work cannot complete it.
- Native `tool_execution_start` / `tool_execution_end` is now a best-effort **compatibility fallback** (only the explicit terminal `done` phase is success).
- Peer `@minhduydev/pi-core` moved to `^0.2.0`. See `CHANGELOG.md`.

## Why markdown-first?

The file is always the truth a human can read, `grep`, `git diff`, and that survives context compaction. The structured model is a *projection*: tools parse the file → mutate the model → enforce invariants → atomically write back. You can hand-edit the file (or use `bash`, `/todo edit`) and `pi-todo` live-refreshes via `fs.watch`.

## Features

- **`todo` LLM tool** — one strict op-discriminator tool: `view | add | start | done | drop | block | unblock | rm | move | edit | promote | deps`. Atomic writes (temp + rename) so a crash never leaves a half-edited file.
- **`/todo` slash command** — same ops + `/todo edit` (opens `$EDITOR`) and `/todo refresh`.
- **Reminder cadence** — a transient nudge via the `context` hook every N turns (shorter while an item is `in_progress`), suggesting the next step. Never persisted.
- **Single-active-task invariant** — only one `in_progress` per phase; `done` auto-promotes the next pending.
- **Subagent reconciliation** — the typed `pi-subagents:task-started`/`task-settled` event pair is authoritative and tracked durably by task ID in `.pi/artifacts/todo/subagent-tasks.json` across restart, duplicate delivery, and out-of-order delivery. The tracker uses atomic, fsynced writes and a small inter-process lock; a terminal event stays pending until the parent TODO mutation is acknowledged. A TODO completes only when both terminal and child-reported outcomes explicitly say `success`; blocked, partial, failed, reframed, or awaiting-decision work cannot complete it. A replay after a crash is recognized as already applied, while an unmatched description remains retryable instead of being silently acknowledged. Pi's native `tool_execution_start`/`tool_execution_end` remains a best-effort compatibility fallback for older task runtimes and only treats the explicit terminal `done` phase as success. Subagents never write `TODO.md` directly — the parent's `TodoStore` does, in the host process.
- **Optional widget** — a bounded below-editor widget: root header (`Todos · 2/8`), one **focused** phase expanded (with matched lighting — a pending item glows when a live subagent works on it), the rest collapsed to one-line summaries, hard-capped by `widgetMaxLines` so it can never crush the editor; fully-done phases are hidden. Density modes: `compact` (one line), `focused` (default), `detailed`. On by default; disable via `pi-todo.widget: false`.
- **Optional dependencies** — `blocks`/`blockedBy` annotations + `/todo deps` cycle/dangling validation. Opt-in via `pi-todo.dependencies: true`.

## Format (backwards-compatible)

```
### 2026-07-24 - Refactor auth
status: active | updated: 2026-07-25

- [ ] pending item
- [/] in_progress item
- [x] completed item
- [-] abandoned item
- [!] blocked item [blocked by #2]
- [/] (#3) wire up token refresh [blocks #5]
```

The `status: X | updated: Y` combined line (with `|` separator) is the canonical pi-harness `artifact-format` form and round-trips byte-for-byte. Accepts the pi-harness markers (`[ ]`, `[x]`) and the oh-my-pi markers (`[/]`, `[-]`, `>` in_progress, `~` abandoned, `[!]` blocked). Free-form prose and blank lines between items are preserved losslessly (idempotent round-trip). A trailing `#id` (`(#3)`) gives a stable reference for dependencies when content is long or duplicated.

Integrations that only need to read the canonical file should use the public
parser instead of reimplementing Markdown recognition:

```ts
import { parseMarkdown } from "@minhduydev/pi-todo/markdown";
```

## Settings (`pi-todo` block in `.pi/settings.json`)

| key | default | description |
|---|---|---|
| `enabled` | `true` | Master switch |
| `todoFile` | `.pi/artifacts/TODO.md` | Canonical file; a non-empty relative path contained within the project (absolute and escaping paths are refused) |
| `reminderTurns` | `6` | Idle reminder cadence (turns) |
| `reminderTurnsActive` | `3` | Active (in_progress) reminder cadence |
| `widget` | `true` | Enable the below-editor widget |
| `widgetPlacement` | `"belowEditor"` | `"aboveEditor"` or `"belowEditor"` |
| `widgetItemsPerPhase` | `5` | Max items shown under the **focused** phase |
| `widgetDensity` | `"focused"` | `"compact"` (one line) \u00b7 `"focused"` (one phase expanded, rest collapsed) \u00b7 `"detailed"` (focused with higher caps) |
| `widgetMaxLines` | `10` | Hard cap on total widget lines — a data-independent safety net so the widget can never crush the editor |
| `widgetCollapsedPhases` | `3` | Max non-focus phases shown as one-line collapsed summaries |
| `reconcileSubagents` | `true` | Auto-reconcile on subagent settle |
| `dependencies` | `false` | Enable opt-in `blocks`/`blockedBy` DAG |

## Install (pin into a Pi project)

`pi-todo` ships compiled ESM and declarations under `dist`; the Pi extension entry is `./dist/index.js`. Pin it in the project's `.pi/settings.json` `packages` array by an exact registry version **only after that version is published**, a git URL+sha, or a local path:

```jsonc
{
  "packages": [
    // "npm:@minhduydev/pi-todo@0.4.0",                      // only when this exact release exists in your registry
    "git+https://github.com/minhduydev/pi-todo.git#<sha>",  // immutable source ref
    // "../pi-todo"                                          // local development path
  ],
  "pi-todo": { "enabled": true, "widget": true }
}
```

> The npm package name is `@minhduydev/pi-todo`; the settings block stays `pi-todo` (the extension reads that key directly).

Peer deps (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`, `@minhduydev/pi-core`) are provided by the host Pi at runtime. The manifest declares `"pi": { "extensions": ["./dist/index.js"] }`.

## Coexistence with the pi-harness TUI todo surface

The pi-harness TUI extension can render an `amp-todos` widget and inject an active-TODO reminder from the same `.pi/artifacts/TODO.md`. Both are controlled together by `piTui.todosWidget`; the canonical harness settings set it to `false` when `pi-todo` owns this surface.

- **Widget**: `pi-todo`'s widget is **bounded** — one focused phase expanded, the rest collapsed to a line each, hard-capped by `widgetMaxLines`; fully-done phases are hidden so finished work never wastes a line. To make it the sole below-editor todo widget, disable the built-in `amp-todos` via `piTui.todosWidget: false` in `.pi/settings.json` (pi-harness). Alternatively set `pi-todo.widget: false` and keep `amp-todos`.
- **Cadence**: setting `piTui.todosWidget: false` also disables the TUI's active-TODO prompt injection, leaving `pi-todo.reminderTurns` as the sole reminder cadence.

## Ops vs the `artifact-format` append-only rule

The `artifact-format` skill's manual rule is "append a new `###` block + edit the `status:` line in place; don't move/hide/redact blocks." `pi-todo`'s structured ops intentionally go further — `rm`/`move`/`edit`/`block`/`unblock` mutate items within and across blocks to keep the list coherent (single-active invariant, reconciliation). **Loading `pi-todo` supersedes the manual append-only rule for `TODO.md`**: the tool enforces the invariants the manual rule was a proxy for, while the file stays human-readable and git-diffable. The block format itself is unchanged (the combined `status: X | updated: Y` line round-trips byte-for-byte).

## Development

```sh
npm run typecheck   # tsc --noEmit
npm test            # node:test + tsx
```

Pure modules (`markdown`, `model`, `cadence`, `widget` render) have **zero** Pi coupling → fully unit-testable. Only `index.ts`, `tool.ts`, `command.ts`, and `subagents.ts` touch the Pi ExtensionAPI.

## What we deliberately reject

- **Opaque JSON as TODO master store** — breaks human-readable, git-diffable, survives-compaction. The auxiliary lifecycle tracker is JSON, but TODO.md remains the only task-content source of truth.
- **Subagents writing artifacts** — the parent owns artifacts; `pi-todo` only *reflects* delegation and reconciles on events.
- **A new file format** — extends the existing `### block + status:` format; never replaces it.
- **Mandatory or unbounded widget/extra UI** — the bounded widget can always be disabled with `pi-todo.widget: false`.

## License

MIT
