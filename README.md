# pi-todo

A **markdown-first** structured todo layer for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).

`pi-todo` keeps `.pi/artifacts/TODO.md` as the **canonical, human-readable, git-diffable** store and adds a structured phased model with **markdown round-trip**, a reminder cadence, optional dependencies (DAG), subagent reconciliation, and a bounded widget.

> Distilled from three sources, taking the best of each:
> - **pi-harness** — durable markdown artifact + skill-driven lifecycle as the source of truth.
> - **oh-my-pi** — phased `TodoItem` model + `phasesToMarkdown`/`markdownToPhases` round-trip + single-op tool + single-active-task invariant + subagent reconciliation.
> - **pi-tasks** — pure, unit-testable reminder **cadence** via the `context` hook (transient, never persisted) + optional DAG + crash-safe widget render.

## Why markdown-first?

The file is always the truth a human can read, `grep`, `git diff`, and that survives context compaction. The structured model is a *projection*: tools parse the file → mutate the model → enforce invariants → atomically write back. You can hand-edit the file (or use `bash`, `/todo edit`) and `pi-todo` live-refreshes via `fs.watch`.

## Features

- **`todo` LLM tool** — one strict op-discriminator tool: `view | add | start | done | drop | block | unblock | rm | move | edit | promote | deps`. Atomic writes (temp + rename) so a crash never leaves a half-edited file.
- **`/todo` slash command** — same ops + `/todo edit` (opens `$EDITOR`) and `/todo refresh`.
- **Reminder cadence** — a transient nudge via the `context` hook every N turns (shorter while an item is `in_progress`), suggesting the next step. Never persisted.
- **Single-active-task invariant** — only one `in_progress` per phase; `done` auto-promotes the next pending.
- **Subagent reconciliation** — when a delegated subagent (via the native `task` tool) finishes, matching open items are marked completed (success) or reverted to pending + blocker note (failure). Hooks Pi's standard `tool_execution_start`/`tool_execution_end` events for the `task` tool (correlated by `toolCallId`). `@minhduydev/pi-subagents` also emits `pi-subagents:task-started`/`task-settled` on the eventbus — an earlier version of this README wrongly said it did not, which is why matching is currently done by fuzzy `description` string rather than by `taskId`; moving to the typed events is planned. Subagents never write `TODO.md` directly — the parent's `TodoStore` does, in the host process.
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

## Settings (`pi-todo` block in `.pi/settings.json`)

| key | default | description |
|---|---|---|
| `enabled` | `true` | Master switch |
| `todoFile` | `.pi/artifacts/TODO.md` | Canonical file (relative to cwd or absolute) |
| `reminderTurns` | `6` | Idle reminder cadence (turns) |
| `reminderTurnsActive` | `3` | Active (in_progress) reminder cadence |
| `widget` | `false` | Enable the below-editor widget |
| `widgetPlacement` | `"belowEditor"` | `"aboveEditor"` or `"belowEditor"` |
| `widgetItemsPerPhase` | `5` | Max items shown under the **focused** phase |
| `widgetDensity` | `"focused"` | `"compact"` (one line) \u00b7 `"focused"` (one phase expanded, rest collapsed) \u00b7 `"detailed"` (focused with higher caps) |
| `widgetMaxLines` | `10` | Hard cap on total widget lines — a data-independent safety net so the widget can never crush the editor |
| `widgetCollapsedPhases` | `3` | Max non-focus phases shown as one-line collapsed summaries |
| `reconcileSubagents` | `true` | Auto-reconcile on subagent settle |
| `dependencies` | `false` | Enable opt-in `blocks`/`blockedBy` DAG |

## Install (pin into a Pi project)

`pi-todo` ships TypeScript source (entry `./src/index.ts`), loaded by Pi via `tsx`/`jiti` — no build step. Pin it in the project's `.pi/settings.json` `packages` array, by npm package, git URL+sha, or local path:

```jsonc
{
  "packages": [
    "@minhduydev/pi-todo",                                   // npm (recommended)
    // "git+https://github.com/minhduydev/pi-todo.git#<sha>" // or a published git ref
    // "../pi-todo"                                          // or a local path (dev)
  ],
  "pi-todo": { "enabled": true, "widget": true }
}
```

> The npm package name is `@minhduydev/pi-todo`; the settings block stays `pi-todo` (the extension reads that key directly).

Peer deps (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`) are provided by the host Pi at runtime. The manifest declares `"pi": { "extensions": ["./src/index.ts"] }`.

## Coexistence with the built-in todo widget/nudge

The pi-harness ships a built-in `amp-todos` widget (`.pi/extensions/tui/`) and a `todo.ts` nudge that both watch `.pi/artifacts/TODO.md`. To avoid a double widget / double nudge when adopting `pi-todo`:

- **Widget**: `pi-todo`'s widget is **bounded** — one focused phase expanded, the rest collapsed to a line each, hard-capped by `widgetMaxLines`; fully-done phases are hidden so finished work never wastes a line. To make it the sole below-editor todo widget, disable the built-in `amp-todos` via `piTui.todosWidget: false` in `.pi/settings.json` (pi-harness). Alternatively set `pi-todo.widget: false` and keep `amp-todos`.
- **Cadence**: `pi-todo`'s `context`-hook reminder overlaps the built-in `todo.ts` nudge. Set `pi-todo.reminderTurns` high (or extend `enabled: false` for the cadence) if you keep `todo.ts`, or remove `todo.ts` when adopting `pi-todo`.

## Ops vs the `artifact-format` append-only rule

The `artifact-format` skill's manual rule is "append a new `###` block + edit the `status:` line in place; don't move/hide/redact blocks." `pi-todo`'s structured ops intentionally go further — `rm`/`move`/`edit`/`block`/`unblock` mutate items within and across blocks to keep the list coherent (single-active invariant, reconciliation). **Loading `pi-todo` supersedes the manual append-only rule for `TODO.md`**: the tool enforces the invariants the manual rule was a proxy for, while the file stays human-readable and git-diffable. The block format itself is unchanged (the combined `status: X | updated: Y` line round-trips byte-for-byte).

## Development

```sh
npm run typecheck   # tsc --noEmit
npm test            # node:test + tsx
```

Pure modules (`markdown`, `model`, `cadence`, `widget` render) have **zero** Pi coupling → fully unit-testable. Only `index.ts`, `tool.ts`, `command.ts`, and `subagents.ts` touch the Pi ExtensionAPI.

## What we deliberately reject

- **Opaque JSON as master store** — breaks human-readable, git-diffable, survives-compaction. JSON is never the truth.
- **Subagents writing artifacts** — the parent owns artifacts; `pi-todo` only *reflects* delegation and reconciles on events.
- **A new file format** — extends the existing `### block + status:` format; never replaces it.
- **Always-on widget/extra UI** — opt-in only.

## License

MIT