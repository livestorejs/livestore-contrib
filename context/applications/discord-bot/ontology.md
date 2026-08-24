# Discord Bot — Ontology

Canonical terms for the Discord application. Child ontologies refine these
terms rather than inventing synonyms.

## Actors and boundaries

- **Community member:** A human participating in the configured LiveStore
  Discord guild.
- **Interaction actor:** The Discord user who explicitly invokes an application
  command, message action, component, or modal.
- **Operator:** A maintainer accountable for deployment, credentials, rollout,
  incident response, and disabling behavior.
- **Bot control:** The typed application use-case contract shared by Discord
  adapters, the authenticated administrative RPC, CLI, and tests. It is not a
  generic Discord REST surface.
- **Operator request:** An authenticated request through Bot control carrying a
  use case, environment, and reason; identity comes from transport, not input.
- **Discord application:** The organization-owned Discord identity, commands,
  bot user, intents, and permissions used by one environment.
- **Bot deployment:** One versioned, singleton runtime instance operating one
  Discord application under one configuration and deployment identity.

## Inputs and decisions

- **Bot event:** A decoded Discord Gateway event admitted through the bot-owned
  event boundary.
- **Source message:** A Discord message considered by a feature. It is an
  external object identified by guild, channel, and message IDs; it is not
  durable bot-owned content.
- **Managed channel:** A configured Discord channel in which a named feature is
  allowed to observe or act.
- **Bot action:** A requested Discord side effect such as creating a thread,
  renaming one, or answering an interaction.
- **Processing outcome:** The terminal or retryable result of applying a feature
  policy to one external input.
- **Action receipt:** Durable metadata binding an input and action kind to its
  processing outcome so delivery replay can be reasoned about without retaining
  raw community content.

## Verification

- **E2E channel:** An explicitly designated channel whose identity and sentinel
  permit controlled live canaries.
- **Live canary:** A correlated input and expected Discord outcome used to prove
  the deployed data path, followed by ownership-checked cleanup.
- **Readiness:** Evidence that the deployment can receive an admissible input
  and complete its required action, not merely that its process is running.

## Relationships

```text
Discord application
        |
        v
  Bot deployment ---> Managed channel
        |                  |
        v                  v
     Bot event ------> feature decision
                           |
                           v
                       Bot action
                           |
                           v
                   Processing outcome
                           |
                           v
                      Action receipt
```
