# Discord Bot CLI - Intuition

Discord interactions are useful for community members, but operators and
coding agents also need reproducible ways to inspect and repair the bot. A
retroactive thread should not require crafting a fake Gateway event, manually
calling Discord REST, or editing the SQLite journal.

The CLI is therefore a first-class adapter over the bot's typed use cases. It
can create a thread for an older source message, explain policy, reconcile an
ambiguous action, exercise the docs engine, and inspect service state through
the same authorization, validation, journal, and outcome model as the running
bot.

The command tree teaches the ontology: threads are inspected, created, and
reconciled; policy is explained; runtime state is observed. “Retroactive” is a
time relationship, not a separate kind of thread or a privileged back door.
