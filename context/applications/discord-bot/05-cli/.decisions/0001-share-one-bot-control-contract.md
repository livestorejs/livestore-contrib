# 0001 - Share one Bot control contract across surfaces

Status: accepted

## Context

Discord handlers, operators, tests, and future surfaces need overlapping bot
capabilities. A CLI that directly calls Discord or edits the action journal
would duplicate policy and become an unreviewed authority path.

## Decision

Define one schema-first Bot control contract over application use cases. Discord
handlers, the administrative RPC server, CLI, and tests are thin adapters. Every
administrative RPC method is reachable from `livestore-discord`; no CLI command
may bypass authorization, feature policy, the journal, or receipts.

Accepted 2026-08-23 from explicit maintainer direction to make the system
composable and reusable.
