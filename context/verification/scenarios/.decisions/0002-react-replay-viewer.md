# 0002 — Use React as the canonical replay viewer realization

Status: accepted (React parity implementation, tracked screenshots, and
interaction suite in `tests/scenarios`, 2026-07-29)

## Context

The realization needs a truth-preserving contributor workbench over its
authoritative evidence and repeatable visual migration evidence alongside the
runner. Core requires neither visualization nor a particular framework.

## Decision

Keep the React single-page application as the canonical artifact viewer. Keep
durable projection and interaction state in its controller, derive the timeline
scene without the DOM, exercise component/complete states in Storybook, and gate
the result with Playwright interactions plus approved screenshots.

Use sync evidence as the default narrative projection: material captures and
Scenario boundaries receive semantic flow space, and generated action-sequence child
actions collapse into one summarized boundary. Preserve every controller
instruction and acknowledgement in the raw-trace projection and inspector
rather than allowing diagnostic record volume to determine the default
timeline geometry.

The viewer consumes completed artifacts only and never becomes an alternate
execution authority.

## Consequences

React, Storybook, Vite, and Playwright stay private dependencies of the Scenario
workspace. Framework choice is a contrib realization detail, not a core
Scenario contract. Live streaming/control remains an explicit open delta.
