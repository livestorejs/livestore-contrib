# Discord Bot Operations - Ontology

This vocabulary inherits Discord's terms **application**, **bot user**,
**guild**, **channel**, **Gateway session**, and **interaction**. It owns only
the operational terms needed to run the LiveStore bot safely.

## Language

- **Bot Deployment:** One environment's declared application identity,
  configuration, credential projection, immutable release, and runtime
  instance considered as an operable whole. _Avoid_: process, bot (when only
  the running realization is meant).

- **Deployment Identity:** The non-secret Discord application ID and guild ID
  a Bot Deployment is authorized to serve, paired with the declared
  environment. It is verified against Discord after authentication.

- **Credential Projection:** Runtime-only access that resolves a named secret
  reference into a token for a specific Bot Deployment. The projected value is
  not part of deployment configuration or evidence.

- **Action Authority:** Permission for a runtime instance to turn an eligible
  Discord event into a mutation. Only the single active actor for an
  environment holds it.

- **Service Host:** The managed NixOS machine that runs and supervises the Bot
  Deployment. The initial Service Host is dev4.

- **Deployment Controller:** The dotfiles-owned `deploy-rs` and systemd
  boundary that installs an immutable release, transfers Action Authority,
  observes health, and performs rollback on the Service Host.

- **Environment Identity:** One environment's Discord application, bot user,
  and guild boundary. Production and staging have disjoint Environment
  Identities.

- **Trace Pipeline:** The content-free, best-effort path from the runtime
  through the Service Host's OTLP forwarder to central Tempo. It does not imply
  a persistent delivery queue.

- **System Journal:** The Service Host's local systemd record of service
  lifecycle and errors. It follows host policy and is distinct from exported
  traces and durable application receipts.

- **Readiness Snapshot:** The current evidence that a Bot Deployment can serve
  its declared jobs: decoded configuration, verified identity, active Gateway
  session, successful REST probe, and registered handlers.

- **E2E Target:** A Discord guild/channel pair explicitly marked and allowed
  for automatic creation and cleanup of test artifacts.

- **E2E Actor:** A Discord bot identity distinct from the system under test
  that creates a correlated marker event in an E2E Target.

- **Run Correlation:** A run-scoped, non-content identifier that binds a marker
  event, its resulting thread, cleanup, and receipt without publishing raw
  Discord identifiers.

- **Deployment Receipt:** Sanitized, durable evidence that binds an
  environment and immutable release to configuration, validation, health, and
  rollback outcomes.

- **Rollback Target:** The previous immutable release and configuration digest
  recorded before a deployment and available without rebuilding.

## Structure

The leitwort is **Deployment**: identity, receipt, and rollback describe one Bot
Deployment. Readiness and E2E evidence are independent facets of that deployment
rather than alternate lifecycle states.

```text
Deployment Identity ---partOf---> Bot Deployment
Credential Projection -partOf---> Bot Deployment
immutable release -----partOf---> Bot Deployment
runtime instance ------partOf---> Bot Deployment
Environment Identity --partOf---> Bot Deployment
Service Host ----------hosts----> Bot Deployment
Deployment Controller -controls-> Bot Deployment
Trace Pipeline --------observes-> Bot Deployment
System Journal --------records--> Bot Deployment

Bot Deployment --dependsOn--> Action Authority (only while active)
Bot Deployment ----related---> Readiness Snapshot
Bot Deployment ----related---> Deployment Receipt
Bot Deployment ----related---> Rollback Target

E2E Actor ------related-------> E2E Target
E2E Target -----related-------> Run Correlation
Run Correlation -partOf-------> Deployment Receipt
```

## Flagged Ambiguities

- **Identity** alone can mean a Discord application, its bot user, an E2E
  actor, or the deployed release. Use **Deployment Identity**, **E2E Actor**, or
  **release identity** as appropriate.
- **Health** can incorrectly collapse process liveness and service readiness.
  Use **liveness** for process supervision and **Readiness Snapshot** for the
  ability to perform the bot's declared jobs.
