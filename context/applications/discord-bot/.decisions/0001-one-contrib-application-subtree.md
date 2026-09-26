# 0001 — Keep the Discord application inside the contrib intent layer

Status: accepted

## Context

The Discord bot is an independently deployed application rather than a
published package or a realization of a core plugin dimension. The redesign
needs a comprehensive nested contract, while `livestore-contrib` already has
one intent authority and inherits the core rule that product vision exists only
at the LiveStore root.

## Options

| Option | Consequence |
| --- | --- |
| One `context/applications/discord-bot/` subtree | One authority, namespace, and checker; nested contracts but no independent vision |
| A second VRS beside application code | Independent vision and extraction boundary; duplicated authority and enforcement |

## Decision

Use one composite application subtree inside the existing contrib intent layer,
with nested runtime, threading, docs-assistant, and operations nodes. Purpose is
captured in `intuition.md` and the requirements Role rather than a child
`vision.md`.

Accepted 2026-08-23 in interview Q137.
