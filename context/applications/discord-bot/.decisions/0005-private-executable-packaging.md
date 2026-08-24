# 0005 - Package the bot as a private executable

Status: accepted

## Context

The Discord bot is an independently deployed application, not a published
library or a core plugin realization. Its workspace boundary must allow a
private runtime dependency graph and an executable delivery artifact.

## Decision

Place the implementation under `apps/discord-bot` as a private workspace
application. It is excluded from published package contracts; its VRS remains
owned by `context/applications/discord-bot/`.

Accepted 2026-08-23 as a packaging default.
