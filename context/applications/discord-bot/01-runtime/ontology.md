# Discord Bot Runtime — Ontology

Terms in this file are normative within the runtime node.

## Concepts

| Term | Meaning | Not this |
| --- | --- | --- |
| **Application runtime** | The supervised process that assembles DFX transports, feature handlers, configuration, and health state. | A LiveStore store runtime or adapter. |
| **Gateway session** | One identified Discord Gateway session, including its session ID, sequence, heartbeat, and resume state. | The application runtime itself; a runtime may replace a failed session. |
| **Dispatch** | A server-originated Discord Gateway event narrowed by its event name, such as `MESSAGE_CREATE`. | A REST response or an application command. |
| **Discord action** | An intentional outbound operation performed through a narrow application port and backed by DFX REST. | An arbitrary REST call embedded in policy code. |
| **Intent** | A Discord Gateway subscription/data-access flag declared during identify. | Product intent or a user command. |
| **Terminal close** | A Gateway close whose protocol meaning cannot be repaired by reconnecting with the same configuration or credentials. | A transient network interruption. |
| **Transient close** | A Gateway interruption for which reconnect or session resume can make progress. | Every non-clean WebSocket close. |
| **Readiness** | The runtime's ability to receive Discord dispatches through an established, identified session. | Merely having a live OS process. |
| **Recording fake** | A test implementation of a Discord action port that records requests without external writes. | A mock of feature policy or a claim of live Discord compatibility. |
| **Singleton** | The initial topology invariant that only one application runtime is active for the bot application. | A guarantee that Discord dispatches are delivered exactly once. |

## Relationships

```text
application runtime
  |
  +-- owns ------> gateway session
  |                  |
  |                  +-- receives --> dispatch
  |
  +-- hosts ------> feature handler
  |                  |
  |                  +-- requests --> Discord action port
  |
  +-- provides ----> DFX Gateway + DFX REST
                         |
                         +-- backs --> Discord action port
```

The application runtime may replace a Gateway session after a transient close.
It must not replace one indefinitely after a terminal close. A recording fake
replaces the DFX REST backing in tests, not the feature handler.
