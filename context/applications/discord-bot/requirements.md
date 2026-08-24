# Discord Bot — Requirements

Role: owns the contrib-hosted application that automates the LiveStore Discord
community surface. It refines the core community contract without creating a
support commitment or defining LiveStore product behavior.

## Context

The public Discord surface is owned by core
[`05-contributing/02-community/`](https://github.com/livestorejs/livestore/tree/main/context/05-contributing/02-community).
This node owns the application-specific behavior and composes its
[runtime](./01-runtime/requirements.md), [threading](./02-threading/requirements.md),
[docs assistant](./03-docs-assistant/requirements.md), and
[operations](./04-operations/requirements.md) children.

The previous implementation is evidence, not a compatibility contract. Only
behavior merged on its main branch counts as an old supported feature; the open
member-welcome branch remains proposed scope.

## Requirements

- **LSC.APP.DISCORD-R01 Contrib-owned community application:** The bot's source,
  behavioral contract, test evidence, and application delivery contract live in
  `livestore-contrib`. Core retains ownership of the Discord community surface
  and links to this realization. `refines: LS.CONTRIB.COMM-R01`

- **LSC.APP.DISCORD-R02 Initial feature families:** The initial redesign covers
  the three feature families present on the old bot's merged main branch:
  automatic thread creation, the explicit `Create Thread` message action, and
  the explicit `/docs` command. Exact policy and rollout remain owned by the
  child requirements and interview decisions.

- **LSC.APP.DISCORD-R03 DFX protocol foundation:** Discord Gateway, REST, and
  interaction protocol mechanics use `tim-smart/dfx`. Application code keeps
  DFX behind bot-owned event and command boundaries so domain policy is
  independently testable and upstream protocol fixes remain adoptable.

- **LSC.APP.DISCORD-R04 Best-effort assistance:** Bot availability and generated
  assistance do not create a response-time promise, support entitlement, or
  maintainer commitment. Failures are visible to operators and explicit users,
  but community support remains best-effort. `refines: LS.CONTRIB.COMM-R02`

- **LSC.APP.DISCORD-R05 Derived public description:** Any docs or Discord notice
  describing bot capability, availability, data use, or commands derives from
  this subtree and must not claim behavior that is absent or disabled.
  `refines: LS.CONTRIB.COMM-R03`

- **LSC.APP.DISCORD-R06 Layered independent capabilities:** Threading and
  explicit documentation assistance are independently useful capabilities with
  independent failure and readiness signals. When both are available they
  compose into the bot's support-assistant experience. Neither AI title
  generation nor docs-assistant failure may suppress otherwise eligible basic
  thread creation.

- **LSC.APP.DISCORD-R07 OpenAI generation source:** Bot-owned AI generation uses
  the OpenAI Responses API with model `gpt-5.6-luna` and
  `reasoning.effort: "medium"`. Model output is untrusted generated data and
  remains subject to feature-specific schemas, grounding, privacy, timeouts,
  spend controls, and deterministic degradation.

- **LSC.APP.DISCORD-R08 Composable control surface:** Discord Gateway handlers,
  interactions, the operator CLI, tests, and future control surfaces invoke the
  same typed application use cases. The CLI exposes every operational read and
  write needed to inspect, create, and reconcile threads, exercise docs answers,
  inspect runtime state, and run acceptance checks without duplicating policy or
  bypassing authorization, the action journal, or receipts.

## Assumptions

- **LSC.APP.DISCORD-A01 Existing production identity survives:** The existing
  Discord application and guild installation still exist and can be adopted;
  this must be re-verified before production activation.

- **LSC.APP.DISCORD-A02 Gateway transport is necessary:** Automatic processing
  of ambient top-level messages requires a persistent Gateway consumer;
  interaction-only webhooks cannot provide that event stream.

## Tradeoffs

- **LSC.APP.DISCORD-T01 Protocol reuse over a turnkey bot framework:** DFX removes
  handwritten Discord protocol work, but application durability, policy,
  privacy, verification, and operations remain LiveStore responsibilities.

- **LSC.APP.DISCORD-T02 Parity is behavioral, not implementation compatibility:**
  The redesign may deliberately change unsafe or accidental old behavior; it
  does not preserve the old repository structure, bespoke services, hard-coded
  identities, prompts, telemetry payloads, or deployment mechanism.

## Resolved technical decisions

- Welcome automation remains roadmap-only and is not initial feature parity
  ([decision 0004](./.decisions/0004-exclude-welcome-automation.md)).
- The implementation is a private executable workspace application under
  `apps/discord-bot` ([decision 0005](./.decisions/0005-private-executable-packaging.md)).
