# Discord Documentation Assistant — Intuition

_For: LiveStore community and bot maintainers · Assumes: the parent Discord
application's interaction and operations contracts · Covers: answering an
explicit Discord documentation request from the canonical LiveStore corpus_

The documentation assistant is a constrained bridge between a Discord question
and LiveStore's published documentation. It is not a general chat participant
and it is not an authority independent of the docs. Its useful output is a
short, source-backed answer that helps someone continue their work without
leaving the conversation.

```text
explicit /docs request
         |
         v
  audience + context policy
         |
         v
canonical documentation snapshot ---> answer engine
         |                                  |
         +---------- provenance ------------+
                                            |
                                            v
                              grounded Discord response
```

The central boundary is the **Documentation Snapshot**. Every answer is made
against one identifiable retrieval of `https://docs.livestore.dev/llms-full.txt`,
not against a provider's general knowledge or an invisible secondary index.
This makes freshness, source attribution, and failure behavior inspectable even
if the answer engine is probabilistic.

The previous bot established that `/docs` is a useful feature family, but its
policy choices are evidence rather than inherited design. In particular,
hard-coded administrator IDs, silently forwarding nearby conversation, and
instructions to always produce an answer do not become requirements merely
because the predecessor implemented them. The new node names those choices as
open questions and keeps the safe boundaries explicit.

Three invariants shape the assistant:

1. A response cannot claim more authority than the canonical corpus supports.
2. Conversation content crosses the command boundary only under a defined,
   visible context policy.
3. Failure to retrieve or ground an answer is reported honestly instead of
   being disguised as a plausible answer.
