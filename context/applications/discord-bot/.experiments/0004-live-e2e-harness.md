# Experiment 0004 — Fail-closed live Discord E2E harness

Date: 2026-08-23

## Question

Can a later staging canary prove message-to-thread behavior without granting a
test script broad or ambiguous cleanup authority?

## Oracle

Live mode requires an explicit flag and confirmation, exact guild/channel IDs,
an allowlisted target, resolved guild identity, and a channel-topic sentinel.
Cleanup may delete only the thread correlated to the test source message and
must report cleanup failure as failure. Receipts contain hashes, not tokens,
names, or raw message text.

## Results

- Static/type check: PASS.
- Harness typecheck: PASS.
- Harness tests: PASS, 8/8 across two files.
- Negative control: PASS; absent `--live` exits before token lookup or writes.
- Composed fake transport: PASS for eligible automatic creation, filtered
  zero-mutation, retroactive operator creation, repeated `AlreadySatisfied`,
  Discord **Create Thread**, grounded `/docs`, and ownership-safe cleanup that
  preserves unrelated artifacts.
- Initial filter table, substantive counterexamples, authorization denial, and
  automated-source rejection all passed through the composed use cases.
- Live Discord canary: UNRUN. No isolated LiveStore staging credential and
  staging manifest or `DISCORD_E2E_*` configuration was available, so no secret
  was read and no Discord write was attempted.

## Conclusion

The harness contract is suitable for the future staging gate. Local harness
green is not a live product verdict; production activation remains blocked on
a real staging application, channel, secret projection, correlated outcome,
and cleanup receipt.

Reproduction: from `tmp/discord-bot/e2e-harness`, run `corepack pnpm check` and
`corepack pnpm test`.
