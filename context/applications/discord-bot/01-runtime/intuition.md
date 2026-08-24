# Discord Bot Runtime — Intuition

_For: contributors implementing or operating the LiveStore Discord bot ·
Assumes: the parent bot's conversation and feature contracts · Covers: the
long-lived Discord connection, not the policies applied to messages_

The bot is a small application, but its connection to Discord is not a small
protocol. Discord's Gateway requires heartbeats, session sequencing, reconnect
and resume behavior, identify limits, intent declarations, and explicit handling
of terminal close codes. Reimplementing those mechanics in application code is
both unnecessary and the main reliability failure mode of the retired bot. The
runtime therefore adopts [DFX](https://github.com/tim-smart/dfx) as its Discord
protocol boundary and keeps LiveStore-specific behavior in handlers above it.

Think of this node as a supervised pipe with two directions. Typed Gateway
dispatches flow inward to feature handlers. Intentional REST commands flow
outward to Discord. DFX owns the protocol mechanics between those ends; the
application owns which dispatches are eligible and which commands are safe.
The seam must remain injectable so a complete handler can be exercised without
a Discord token or an external write.

The initial topology is deliberately one runtime instance and one Gateway
session. That is enough for the LiveStore community's expected load and avoids
inventing distributed coordination before it is needed. "Singleton" is a
deployment invariant, not permission to ignore duplicate dispatches: Discord
can redeliver around reconnects, and feature contracts must still make repeated
observation safe.

Three Gateway intents are load-bearing. `Guilds` supplies guild and interaction
context, `GuildMessages` supplies message creation events, and the privileged
`MessageContent` intent exposes the text from which auto-thread policy and names
are derived. Broad intents such as `GuildMembers` are not a convenience default;
they require a new requirement and review.

DFX is the direction, but not yet a production-ready dependency in this repo.
The current published release requires a newer Effect beta than contrib pins,
and it retries Discord close codes that the protocol defines as terminal. Those
are recorded as evidence and an open delta, rather than hidden behind consumer
workarounds or treated as reasons to rebuild the Gateway stack.
