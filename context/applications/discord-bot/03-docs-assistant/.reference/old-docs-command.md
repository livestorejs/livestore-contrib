# Predecessor `/docs` Command — Evidence

Evidence captured from `livestorejs/discord-bot` at merged `main` commit
`861ece21` on 2026-08-23. This file records precedent; it is not a normative
contract and does not establish that the predecessor is currently deployed.

## Observed Behavior

| Concern | Merged predecessor behavior | Status in this node |
| --- | --- | --- |
| Entry point | Optional-query `/docs` application command | Feature family retained; input policy remains DQ2 |
| Corpus | Fetch `https://docs.livestore.dev/llms-full.txt`, cache in process indefinitely | Canonical input retained; freshness remains DQ5 |
| Audience | One administrator ID hard-coded in configuration source | Not inherited; audience remains DQ1 and must be policy-driven |
| Context | Fetch starter plus up to 15 recent messages, sort, then send the last 10 with usernames, bot/user labels, and localized timestamps | Not inherited; context and retention remain DQ2/DQ6 |
| Provider | OpenAI credential and generated structured response | Not inherited; provider remains DQ3 |
| Grounding | Entire aggregate corpus interpolated into a prompt | Corpus boundary retained; this alone does not prove grounding |
| Answer policy | Prompt says to always provide valuable information and never report that there is no question | Rejected; honest uncertainty is required |
| Citations | No structured Source Reference contract or membership validation | Not inherited; citation shape remains DQ4 |
| Output | One to three messages, each schema-bounded to 1,900 characters; bare URLs wrapped to suppress embeds | Useful rendering precedent, not fixed limits |
| Interaction | Slash command is deferred before lookup | Retained as deadline behavior |
| Telemetry | Query/context lengths and previews attached to spans | Raw previews rejected by default under R09 |

## Source Locations

- [`src/commands/DocsCommand.ts`](https://github.com/livestorejs/discord-bot/blob/861ece21/src/commands/DocsCommand.ts)
  defines authorization, ambient context collection, request modes, deferred
  response editing, follow-ups, and URL rendering.
- [`src/services/DocsDownloadService.ts`](https://github.com/livestorejs/discord-bot/blob/861ece21/src/services/DocsDownloadService.ts)
  defines the canonical URL and process-lifetime cache.
- [`src/services/DocsLookupService.ts`](https://github.com/livestorejs/discord-bot/blob/861ece21/src/services/DocsLookupService.ts)
  defines request modes, prompt construction, provider invocation, output
  schema, and content-bearing telemetry.
- [`src/services/ConfigService.ts`](https://github.com/livestorejs/discord-bot/blob/861ece21/src/services/ConfigService.ts)
  defines the hard-coded audience and provider credential requirements.
- [`src/commands/__tests__/DocsCommand.test.ts`](https://github.com/livestorejs/discord-bot/blob/861ece21/src/commands/__tests__/DocsCommand.test.ts)
  tests URL rendering only; it does not establish authorization, context
  privacy, grounding, corpus failure, or interaction behavior.
