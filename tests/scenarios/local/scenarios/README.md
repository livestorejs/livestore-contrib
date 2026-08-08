# Local scenarios

Scenario files in this directory are ignored by Git. Run one directly with:

```sh
pnpm scenario:run --scenario-file local/scenarios/my-scenario.scenario
```

Start from `scenario.template.scenario`. The filename becomes the Scenario ID.
When a scenario has a clear durable purpose,
move it to `src/corpus/scenarios/retained/examples/` or
`src/corpus/scenarios/retained/findings/`, give it a focused test, and register
it in `src/corpus/scenarios/registry.ts`. Promotion is deliberately a reviewed
source change; running a retained scenario still produces an ignored artifact.
