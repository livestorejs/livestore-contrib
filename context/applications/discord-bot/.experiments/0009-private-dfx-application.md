# Experiment 0009 - Private DFX application assembly

Date: 2026-08-23

## Question

Can the private contrib application assemble the selected DFX runtime, typed
Gateway/interaction routes, and reusable domain ports on the target toolchain;
and can application code repair DFX's fatal-close retry behavior?

## Setup and oracle

`tmp/discord-bot/private-app-prototype` pins DFX 1.0.15, Effect beta.105,
`@effect/platform-node` beta.105, `@effect/platform-node-shared` beta.105, and
`discord-api-types` 0.38.40. It uses Bun 1.3.13 and Node 24.18.1. Tests assemble
real `DiscordLive` Node layers, fake typed Gateway dispatch, automatic/message
interaction/docs routes, shared action ports, a terminal-close classifier, and
the published DFX reconnect counterexample.

## Results

- `bun install --frozen-lockfile`: PASS with no lock changes.
- strict TypeScript check: PASS.
- Bun Vitest: PASS, 22/22.
- Node Vitest: PASS, 22/22.
- Real DFX layer assembly: PASS without credentials.
- Fatal closes `4004`, `4010`, `4011`, `4012`, `4013`, and `4014`: FAIL the
  production oracle; published DFX reconnects three times within two virtual
  seconds for each code.

The pure classifier is correct but cannot be injected through DFX 1.0.15's
public API because reconnect/repeat occurs inside its socket layer.

## Conclusion

The exact private-app graph and reusable route/action-port architecture are
admitted as an implementation baseline. Production remains blocked on an
upstream DFX release or exact tested source patch; an application wrapper is
not a valid repair. Real authentication, READY/RESUME, permissions, command
sync, and REST mutation remain part of the live staging gate.
