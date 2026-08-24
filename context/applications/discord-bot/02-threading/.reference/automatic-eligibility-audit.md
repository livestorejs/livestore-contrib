# Automatic Eligibility Audit

Captured: 2026-08-23. This is evidence for
[decision 0005](../.decisions/0005-preserve-defensible-automatic-filters.md),
not an independent policy source.

The merged predecessor's `MessageHandlerService.ts` at commit `861ece21`
implemented the historical filters. The final merged suite exercised only a
small subset; the earlier commit `fea55264` contained the broader filter table.
Discord's official message and channel contracts supply the structural message
types, `HAS_THREAD` flag, and source-thread identity semantics used by the
revised policy.

| Historical behavior | Adopted treatment | Reason |
| --- | --- | --- |
| Hard-coded channel IDs | Declarative environment allowlist plus resolved channel kind | Identity is configuration; kind prevents thread/DM admission |
| Bot authors | Strengthen to bot, webhook, and application authors | Prevent feedback loops and automated chatter |
| Reply admitted through referenced channel | Drop; reject replies automatically | A reference must not smuggle a message across channel policy |
| Messages inside threads | Explicit structural rejection | Prevent nested/invalid mutation attempts |
| Minimum length 10 | Drop | Rejects short substantive questions without measuring value |
| Exact greetings and reactions | Retain with bounded normalization | Deterministic low-information shapes |
| Every `/word` or `!word` | Restrict to Discord command types and configured legacy commands | Avoid rejecting prose such as `!important regression` |
| URL-only | Retain when no prose, attachment, or poll exists | Manual creation remains an escape hatch |
| Numeric-only | Retain for whole numeric/version shapes | Manual creation remains an escape hatch |
| Any emoji in short content | Replace with emoji/sticker/punctuation-only | Mixed substantive prose stays eligible |
| Existing thread | `AlreadySatisfied` through metadata/journal/Discord lookup | One source has at most one thread |

Required counterexamples include `Why CRDT?`, `Sync bug?`, `Need help 🚨`,
`hello, sync is broken`, `Context: https://example.test`, and
`!important regression`; each is eligible absent another structural rejection.

Sources:

- [Discord Message resource](https://docs.discord.com/developers/resources/message)
- [Discord Start Thread from Message](https://docs.discord.com/developers/resources/channel#start-thread-from-message)
- predecessor `src/services/MessageHandlerService.ts` at `861ece21`
- predecessor `src/__tests__/message-handler.test.ts` at `fea55264`
