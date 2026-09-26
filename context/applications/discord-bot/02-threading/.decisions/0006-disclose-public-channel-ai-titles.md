# 0006 - Allow disclosed AI titles in declared public channels

Status: accepted

## Context

Generated titles improve navigation, but they require transferring community
text to an external processor. The predecessor sent source excerpts without a
durable channel/disclosure boundary and also placed previews in telemetry. The
new system already has deterministic local fallback and content-free telemetry.

## Decision

AI title generation is allowed only for an explicit `aiTitleChannelIds` subset
of declared public managed channels. Private, moderator, staging-fixture, and
undeclared channels categorically use local titles. Before activation, the
public bot/data-use notice names OpenAI, the title-generation purpose, the exact
input boundary, `store:false`, and the local fallback.

The provider receives at most the first 500 Unicode code points of the source
body after normalization and redaction of Discord user/role/channel mentions,
custom-emoji identifiers, and URLs. It receives no username, Discord ID,
timestamp, message history, attachment, embed, poll payload, reaction, reply
context, interaction metadata, or operator reason. An empty redacted excerpt,
provider failure, timeout, quota, or invalid title selects the deterministic
local title.

Neither raw source text, the redacted provider excerpt, provider payload, nor
generated title may appear in telemetry or ordinary receipts. A user-supplied
validated CLI title avoids the provider entirely.

Accepted 2026-08-23 as maintainer choice A. Disabling a channel's transfer is a
configuration change; previously processed requests are not treated as
recallable.
