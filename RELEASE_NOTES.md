# @minhduydev/pi-todo v0.6.0

This release makes terminal-task cleanup automatic for trusted projects while preserving the package's lossless archive and strict untrusted-project safety boundary.

## Highlights

- **Trusted auto-archive:** completed and abandoned phases are coalesced into the existing lossless archive path by default with `autoArchive: true`.
- **Exit-safe flushing:** startup, shutdown, command, and tool completion paths flush scheduled archive work so process exit cannot race the write.
- **Untrusted-project safety:** untrusted repositories never receive automatic TODO mutations; manual archive remains explicit.
- **Bounded replay API:** public replay queries now enforce a hard `1..1000` result limit.
- **Current host contract:** Pi `0.84.x` and TypeBox `1.3.7` are covered by the package compatibility suite.

## Compatibility

- Pi `0.84.x`
- Node.js `22.19.0+`
- `autoArchive` can be disabled explicitly for trusted projects that prefer manual retention.

## Verification

- `npm run check`
- 228 tests passed
- TypeScript build and packed-package tests passed
- Published npm payload matches the release source

## Links

- [CHANGELOG](CHANGELOG.md)
- [README](README.md)
