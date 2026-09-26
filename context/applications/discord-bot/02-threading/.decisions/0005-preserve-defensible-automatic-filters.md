# 0005 - Preserve defensible predecessor filters

Status: accepted

## Context

The predecessor avoided threads for greetings, reactions, commands, URL-only,
numeric-only, short emoji-heavy, bot-authored, and short messages. Its literal
implementation also admitted replies through referenced channel IDs, rejected
all content below a character threshold, treated every prefixed word as a
command, and used UTF-16 length plus any emoji as a proxy for low value.

## Decision

Preserve the predecessor's conservative filtering intent where it has a clear,
deterministic rationale; do not preserve its regex and length accidents.
Automatic creation initially requires:

1. a configured parent channel whose resolved Discord kind is admitted;
2. an ordinary top-level human-authored message, not a bot, webhook,
   application, system event, reply, or message already inside a thread;
3. no existing source thread; and
4. content that is not empty of text, attachments, and polls; nor an exact
   normalized greeting/reaction, a recognized command invocation, URL-only,
   numeric/version-only, or emoji/sticker/punctuation-only.

There is no universal minimum length: short substantive text remains eligible.
Mixed prose plus a URL, number, or emoji remains eligible. Classification is a
pure, versioned, reason-coded policy shared by the Gateway adapter, CLI
explanation command, and tests. Raw content never appears in policy outcomes or
telemetry.

Attachment-only and poll-only messages are substantive and remain eligible.
Mention-only messages also remain eligible initially; bounded reason counts and
review may justify a later finite rule without changing the policy shape.

Explicit Discord and operator CLI requests bypass automatic low-information and
reply exclusions, because their actor intentionally requests a thread. They do
not bypass source/channel validity, bot/system/inside-thread rejection,
authorization, existing-thread reconciliation, naming, or the action journal.

Accepted 2026-08-23 as maintainer choice B, qualified as “where it makes sense.”
