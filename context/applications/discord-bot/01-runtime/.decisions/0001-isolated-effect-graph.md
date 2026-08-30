# 0001 - Isolate the bot's Effect dependency graph

Status: accepted

## Context

The DFX compatibility experiment found that the selected DFX release requires
a newer Effect prerelease line than contrib currently pins. A repository-wide
upgrade would expand the application's compatibility work into unrelated
packages.

## Decision

The bot uses an isolated private application dependency graph with exact,
lock-coherent DFX, Effect, platform-node, and related versions. Do not require
a contrib-wide Effect upgrade for bot admission.

Accepted 2026-08-23. The graph remains subject to clean-install, peer,
typecheck, and runtime admission checks in RT-R06.
