# Discord Bot — Intuition

_For: LiveStore maintainers and community operators · Assumes: the core
community contract · Covers: why this application exists and how to reason
about its boundaries_

Discord is a live conversation surface, but useful technical discussions are
easy to lose when top-level messages accumulate in a channel. The bot exists to
turn eligible conversation starters into durable discussion threads and to
offer explicit, documentation-grounded assistance without pretending to be a
maintainer or a support SLA.

The old bot demonstrated useful behavior, but not a durable ownership model. It
combined a handwritten Gateway, policy, AI calls, and process lifecycle in a
separate repository; the service disappeared with its host and no declared
deployment could recreate it. This node makes the application, its behavior,
and its operational owner one reviewable system inside `livestore-contrib`.

The application uses DFX for Discord protocol mechanics. LiveStore owns the
policy around which messages are processed, what actions are permitted, what
data crosses an AI boundary, how repeated events become one Discord action, and
how operators know the bot is actually working.

This is an application subtree inside contrib's existing intent layer. It is
not a second product vision, a LiveStore runtime plugin, or a general-purpose
Discord framework.
