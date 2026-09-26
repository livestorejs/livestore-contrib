# 0001 - At most one bot-created thread per source

Status: accepted

## Context

Gateway redelivery, interaction retries, process restarts, and REST timeouts
can make a remote thread mutation ambiguous. Discord is the authority for
whether a thread exists; the bot cannot claim exactly-once remote effects.

## Decision

The invariant is at most one bot-created thread per source message. The bot
uses its local ledger and Discord reconciliation to avoid known duplicates, but
an ambiguous remote result is not reported as exactly-once success.

Accepted 2026-08-23.
