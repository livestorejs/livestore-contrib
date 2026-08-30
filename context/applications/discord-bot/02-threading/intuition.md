# Discord Bot Threading — Intuition

_For: contributors changing how the LiveStore Discord turns channel messages
into discussions · Assumes: the parent Discord bot application contract ·
Covers: automatic and manually requested thread creation_

A busy Discord channel puts unrelated conversations into one ordered stream.
Threading gives a message a durable conversation boundary: the source message
remains the public entry point, while replies gain a place of their own. The
bot's job is not to decide what the community should discuss. It is to create
that boundary predictably enough that people can rely on it.

There are two ways to request the same outcome. **Automatic threading** observes
new top-level messages and applies an eligibility policy. **Create Thread** is a
message action through which an authorized person deliberately requests the
boundary. The manual path is not a second threading system; both triggers must
converge before naming and mutation so they cannot silently acquire different
creation semantics.

```text
ambient message --------> eligibility policy --+
                                               +--> thread proposal --> Discord
Create Thread action ---> authorization -------+        name          mutation
```

The source message's Discord ID is the natural correlation key. Discord events
can be replayed, interactions can be retried, and two triggers can race, so a
delivery is not proof that a new thread should be created. The invariant and
recovery strategy are fixed by decisions 0001 and 0003; they must be
implemented and verified rather than inherited accidentally from the historical
bot.

Thread naming is a policy boundary too. A generated title can make channels
far easier to scan, but generation adds latency, content disclosure, cost, and
a new failure mode. Whether creation waits for generation, degrades to a local
title, or fails visibly is defined by decision 0002. Decision 0006 permits only
bounded, redacted source text from explicitly disclosed public channels; every
other channel uses the local title.

DFX owns Discord transport: Gateway dispatch, interactions, rate-limited REST,
and connection lifecycle. The threading subsystem owns decoded inputs,
eligibility and authorization decisions, title proposals, and creation
outcomes. Keeping that seam narrow lets the decision pipeline run against fake
ports without a Discord token and prevents transport replay from becoming
business policy.

The previous LiveStore bot is evidence, not a compatibility contract. Its
merged behavior proves that automatic threading and the manual **Create
Thread** action were useful enough to ship, and supplies concrete cases for the
new test corpus. Its hard-coded channels, filters, administrator list, AI title
prompt, fallback, and retry behavior remain candidates until the design
questions are resolved. See [historical behavior](./.reference/historical-behavior.md).
