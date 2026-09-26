# Old Discord bot capability audit

Snapshot date: 2026-08-23. Merged baseline:
`livestorejs/discord-bot@861ece21f60e2dd82418c730a5cccef29b7ac051`.

## Proven feature families

| Capability | Merged behavior |
| --- | --- |
| Automatic threading | Six hard-coded channels; exclude bots and deterministic low-value inputs; external-AI title with `Discussion` fallback; create a public thread from the source message |
| Manual threading | Admin-only `Create Thread` message context action |
| Docs assistant | Admin-only `/docs [query]`; canonical `llms-full.txt`; optionally up to ten recent messages plus starter context; up to three response messages |

The label “summary bot” in the final merged change refers to AI thread-title
summarization; it was not a conversation-summary feature.

## Not merged parity

Open PR #5 added batched member welcomes and SQLite state on a divergent branch.
It was never merged and dropped later merged command behavior, so its deployment
claim is historical evidence only. A GitHub-issue command appeared only as a
roadmap idea.

## Unsafe behavior not inherited silently

- handwritten Gateway without RESUME and with fatal-close retry loops;
- global serial event processing and a sliding queue that could discard work;
- no durable action ledger or crash-safe deduplication;
- ambient message and username content copied to model prompts and telemetry;
- `/docs` reading recent messages outside threads;
- hard-coded admin and channel IDs;
- no declared production service or reconstructable deployment.

Behavioral parity means reconsidering the three merged feature families, not
preserving these mechanisms or policies.
