# Discord Bot CLI - Ontology

## Terms

| Term | Meaning | Avoid |
| --- | --- | --- |
| **Bot control** | The typed application contract shared by Discord adapters, the administrative RPC server, CLI, and tests. | CLI API, because the contract is not owned by the CLI. |
| **Operator command** | One CLI invocation authenticated as an operational actor. | Admin bypass; it never bypasses application policy. |
| **Message reference** | A canonical Discord message URL or exact guild/channel/message identity decoded into snowflakes. | Message ID when the channel identity is absent. |
| **Thread plan** | A read-only explanation of validation, authorization, policy, existing state, and the action that would be requested. | Dry-run success; it proves no mutation. |
| **Operator reason** | Human-supplied non-content rationale attached to a write receipt. | Comment or prompt. |
| **Control receipt** | Structured evidence binding operator, reason, environment, use case, correlation, and outcome. | Log line. |

## Relationships

```text
Discord handler ----+
CLI -> admin RPC ----+--> Bot control --> feature use case --> action journal
test adapter --------+                         |
                                               +--> Discord action port
```

The leitwort is **control**: the shared contract controls application use cases;
commands and receipts are facets of that contract. The public binary is
`livestore-discord`; its thread action reads naturally as “livestore-discord
thread create this message.”
