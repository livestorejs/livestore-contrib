# Experiment 0008 - Shared grounded docs workflow

Date: 2026-08-23

## Question

Can Discord `/docs` and CLI docs queries share one grounded workflow with the
accepted cache, model, citation, degradation, and privacy contracts?

## Setup and oracle

`tmp/discord-bot/docs-flow` uses thin CLI and fake Discord adapters over one
DocsWorkflow, fake corpus/provider ports, a virtual clock, strict runtime output
decoding, citation membership validation, and a content-free telemetry sink.

## Results

`bun test tmp/discord-bot/docs-flow/src/docs-flow.test.ts` passed 8/8 tests with
29 assertions. Both adapters produced the same grounded answer. The snapshot
cached for 15 minutes and failed closed after expiry/refresh failure. Ambient
Discord content was ignored. Provider configuration was exactly
`gpt-5.6-luna`, medium reasoning, `store:false`, and strict schema. Malformed
outputs, foreign citations, corpus failure, and provider failure were explicit;
telemetry contained no query, excerpt, answer, or URL.

No credential or paid API call was used.

## Conclusion

One reusable docs workflow can serve Discord and CLI without ambient context or
surface-specific grounding logic. A real provider evaluation, reviewed project
controls, and credentialed staging remain separate admission evidence.
