# React scenario viewer parity checklist

This checklist is the durable issue record for the completed scenario-viewer parity migration. After manual acceptance, React became the canonical viewer and the imperative implementation was removed.

## Reference artifacts and states

- [x] Catalog or fixture coverage for `browser-multi-session-recovery` (normal, moderately complex).
- [x] Catalog or fixture coverage for the `offline-writer-recovery` reference failure.
- [x] Catalog or fixture coverage for `shared-todo-workday` (dense trace).
- [x] Baselines cover unloaded, loaded, mid-cursor, final success, and failed-run states.
- [x] Baselines cover selected event, multi-record moment, expanded metadata, and expanded JSON.
- [x] Baselines cover flow, fitted time, and raw time.
- [x] Baselines cover system/all visibility and moments/records playback.
- [x] Baselines cover full, narrowed, and panned ranges.
- [x] Baselines cover light/dark and desktop/narrow viewports.

## Behavior contracts

- [x] Artifact file selection, saved-run loading, and load errors.
- [x] Play, pause, restart, and playback-end behavior.
- [x] Projection, time-scale, visibility, and playback switches.
- [x] Event selection from topology and timeline.
- [x] Cursor pointer scrubbing and keyboard navigation.
- [x] Range handles, panning, track centering, Escape reset, and keyboard controls.
- [x] Moment-member record selection without moving the replay cursor.
- [x] Inspector disclosure and per-record JSON expansion persistence.
- [x] Event-log scroll restoration and follow-tail behavior.
- [x] Terminal and participant-runtime failure presentation.

## Implementation

- [x] React/Vite entry was independently validated against the legacy entry before cutover.
- [x] Storybook is local to `tests/scenarios/` and builds successfully.
- [x] Reusable primitives, topology, controls, inspector, and full-app stories exist.
- [x] Timeline geometry is derived by a pure DOM-free scene function.
- [x] Legacy and React SVG renderers consume the same timeline scene.
- [x] Scene invariants and semantic thresholds have focused Vitest coverage.
- [x] React keeps separate main-timeline and range-navigator SVGs.
- [x] Dense traces retain bounded local aggregation and acceptable interaction performance.

## Completion evidence

- [x] React application interaction tests pass.
- [x] Legacy-vs-React screenshot and behavioral comparison passes for representative states.
- [x] Viewer builds, Storybook build, targeted Vitest, TypeScript, and lint pass.
- [x] Broader prescribed checks are run in proportion to this local change.
- [x] `README.md` documents exact commands and URLs for both viewers and parity tests.
- [x] Known differences are recorded and explained; baseline updates are reviewed rather than automatic.

No material visual or behavioral differences are known. The migration suite permitted at most a 0.1% pixel mismatch to accommodate browser rasterization, and all reviewed comparisons were below that threshold. The approved legacy screenshots remain as regression baselines; no legacy runtime implementation remains.
