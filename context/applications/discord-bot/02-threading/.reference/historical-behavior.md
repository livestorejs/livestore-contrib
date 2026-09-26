# Historical Threading Behavior

Status: reference evidence, not an accepted contract.

The merged `livestorejs/discord-bot` main branch at commit `861ece21` supplied
two threading features. The parent application owns the complete
[capability audit](../../.reference/old-bot-capability-audit.md); this reference
extracts only the threading evidence.

| Surface | Observed behavior |
| --- | --- |
| Automatic | Consumed `MESSAGE_CREATE`, ignored bot-authored messages, admitted a hard-coded channel allowlist (including referenced allowed channels), optionally filtered short/simple messages, generated an AI title, and created a public thread from the source message. |
| **Create Thread** | Registered an administrator-only message context action, required an allowed channel and a non-bot source without a reported existing thread, generated an AI title with `Discussion` fallback, created the public thread, and deleted the deferred success response. |

The automatic filter defaulted to a minimum trimmed length of 10 and skipped
several exact greeting/acknowledgement forms, slash/bang commands, URL-only,
number-only, and short emoji-bearing messages. The title generator sent up to
500 characters of message content to an external model and requested at most
six words. Eligibility evidence was adjudicated by
[decision 0005](../.decisions/0005-preserve-defensible-automatic-filters.md);
external content disclosure remains DQ4. Neither is a literal compatibility
requirement.

The source also retried network work and caught individual processing failures,
but held no durable creation ledger. Its handwritten Gateway did not provide a
sound basis for replay/recovery semantics. The old repository had no accepted
declarative production owner or current E2E receipt, and its committed tests
were not green during the 2026-08-23 investigation.

Member welcome behavior appeared only in an unmerged change and is neither a
threading feature nor evidence of merged product scope.
