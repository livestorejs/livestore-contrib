# 0010 — Keep generation and promotion in the Scenario layer

Status: accepted; authoring placement, seed derivation, and format versions superseded by decision 0011

## Context

Application definitions should describe the real LiveStore schema, actions,
materializers, and inspectors without also owning Scenario data generation. A
reader should not have to leave a Scenario to understand what activity it will
execute. The committed CLI registry must also distinguish promoted evidence
from focused test fixtures and temporary investigation controls.

## Decision

Keep Application definitions confined to the example Application's actual
LiveStore behavior. Put repetition, target selection, and generated inputs next
to the ordered instruction sequence that owns them through Scenario authoring
functions. Derive random values by stable keys from Scenario, action-sequence,
iteration, and choice identity. Expand authoring immediately into a serializable ordered
action sequence containing every concrete action and stable child ID. The
runner and participant hosts receive only that normalized data; no generator
callback crosses the execution seam.

Keep the registered retained corpus intentionally small: promoted minimized
findings under `retained/findings/` and representative examples under
`retained/examples/`. Keep narrow host-contract Scenarios with their tests but
outside the corpus registry. Create generated investigations and reduction
controls under Git-ignored `local/scenarios/`, run them explicitly by file, and
promote one only by moving its readable source into the retained tree, adding
focused evidence, and registering it. Scenario-source promotion and artifact
retention remain independent decisions.

At the time of this decision, Scenario version 2, trace version 4, and artifact
version 5 were the only supported formats. Decision 0011 replaces their nested
structure and advances all three formats without a compatibility interface.

## Consequences

A Scenario source now explains both its intent and generated activity locally,
while artifacts remain exact and self-contained after expansion. Application
definitions have a smaller interface and stronger locality around real domain
behavior. Keyed randomness is stable when an unrelated choice is inserted.
Sequential action sequences preserve a compact progress, observation, and
viewer boundary without hiding their concrete child actions.

Exploratory files cannot silently become repository contract. Promotion is a
reviewable source change with a stated purpose and regression evidence. A
single current format keeps the Scenario model, runner, projections, and viewer
free of compatibility branches.
