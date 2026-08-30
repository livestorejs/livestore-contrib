# Experiment 0005 - Automatic eligibility oracle

Date: 2026-08-23

## Question

Can “preserve the predecessor filters where they make sense” become a pure,
deterministic policy without retaining the arbitrary length, command-regex, and
emoji-length behavior?

## Setup and oracle

`tmp/discord-bot/eligibility-oracle` models typed channel, message, author,
thread, and content shapes. It returns `Eligible` or one bounded rejection code.
Structural rejection must precede content classification, raw input must not
appear in results, and substantive counterexamples must remain eligible.

## Results

`bun tmp/discord-bot/eligibility-oracle/check.ts` passed 579 assertions:

- 14 direct structural cases;
- 31 direct content/counterexample cases;
- 403 structural-by-content precedence cases;
- 75 normalization cases;
- 32 binary structural combinations; and
- eight determinism/non-disclosure properties.

The predecessor incorrectly rejected six of eight substantive counterexamples.
The oracle admits short text, mixed prose with URL/number/emoji, attachments,
and polls while retaining exact low-information classification.

## Conclusion

Decision 0005 is implementable as a reusable pure policy. The Discord adapter
must still prove correct derivation of channel/message/author kinds. The initial
English greeting vocabulary and mention-only eligibility require measurement,
not unreviewed regex expansion.
