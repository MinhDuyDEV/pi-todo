# Changelog

All notable changes to `@minhduydev/pi-todo` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.5.0] - 2026-07-29

### Added
- **Lossless archive**: `/todo archive [phase:ref]` and the `todo` tool `archive` op move completed/abandoned (terminal) phases out of `TODO.md` into a sibling `TODO.archive.md`. Phases move verbatim — nothing is dropped or duplicated — and the operation is idempotent. An active phase is refused so in-progress work is never silently archived. `store.getArchive()` / `store.archivePath` expose the archive.
- **Additive view filters**: `/todo open`, `/todo archived`, and `/todo view <open|pending|in_progress|completed|abandoned|blocked|archived>` (and the `todo` tool `view` op `filter` param) narrow the rendered list without mutating the file. The default unfiltered view is byte-identical to prior behavior.
- **Format migration**: `/todo migrate` and the `todo` tool `migrate` op upgrade a legacy/current `TODO.md` to the canonical form — adds the `<!-- pi-todo-format: 1 -->` preamble marker and rebuilds oh-my-pi `>`/`~` aliases to canonical `[/]`/`[-]`. Idempotent, status-preserving, and count/identity-preserving; non-migrated files keep round-tripping untouched. `formatVersionOf(md)` reads the declared version.
- New exports: `migrateDoc`, `VIEW_FILTERS`/`ViewFilter`/`isViewFilter`/`filterStatuses`/`filterPhases` (model), `FORMAT_VERSION`/`FORMAT_MARKER`/`formatVersionOf` (markdown), `viewText` (tool), `archivePath`/`getArchive`/`archive`/`migrate`/`ArchiveResult` (store).

## [0.4.2] - 2026-07-29

### Fixed
- Align the README install example with the manifest's supported pi-core range so the package release gate can validate and publish the compatibility release.

## [0.4.1] - 2026-07-29

### Changed
- Widen the `@minhduydev/pi-core` peer range to `>=0.2.0 <0.4.0` so the unchanged task-lifecycle contract remains compatible with the additive core 0.3 release.

## [0.4.0] - 2026-07-27

Subagent reconciliation is now driven by the typed
`pi-subagents:task-started` / `task-settled` lifecycle as the authoritative
path, tracked durably by task ID. The contract change consumes the new
`@minhduydev/pi-core` 0.2.0 task-lifecycle module, so the peer range moves
to `^0.2.0`.

### Added
- **Durable subagent task tracker** at `.pi/artifacts/todo/subagent-tasks.json`: atomic fsynced writes, a small inter-process lock, and idempotent replay across restart, duplicate delivery, and out-of-order delivery.
- A TODO completes only when **both** the terminal and child-reported outcomes explicitly say `success`; blocked, partial, failed, reframed, or awaiting-decision work cannot complete it. An unmatched description stays retryable instead of being silently acknowledged.

### Changed
- Native `tool_execution_start` / `tool_execution_end` is now a best-effort **compatibility fallback** for older task runtimes; only the explicit terminal `done` phase is success.
- Peer dependency `@minhduydev/pi-core` moved from `^0.1.0` to `^0.2.0`.