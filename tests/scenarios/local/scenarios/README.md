# Local scenarios

Scenario files in this directory are ignored by Git. Run one directly with:

```sh
pnpm scenario:run --scenario-file local/scenarios/my-scenario.scenario.yaml
```

Start from `scenario.template.scenario.yaml`. The filename prefix becomes the Scenario ID.
When one Scenario needs custom TypeScript, add an exact same-name companion:

```text
my-scenario.scenario.yaml
my-scenario.helpers.ts
```

The explicit file loader discovers the companion automatically. It must
default-export `defineScenarioHelpers({...})`; YAML references those helpers by
their registered names. The companion contains the helper's implementation
directly. Do not add one merely to import or re-export a shared helper. Both
files remain ignored until the Scenario is deliberately promoted.

When a scenario has a clear durable purpose,
move it to `src/corpus/scenarios/retained/examples/` or
`src/corpus/scenarios/retained/findings/`, give it a focused test, and register
it in `src/corpus/scenarios/registry.ts`. Promotion is deliberately a reviewed
source change; running a retained scenario still produces an ignored artifact.
