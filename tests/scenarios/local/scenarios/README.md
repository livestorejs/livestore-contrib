# Local scenarios

Scenario files in this directory are ignored by Git. Run one directly with:

```sh
pnpm scenario:run --scenario-file local/scenarios/my-scenario.scenario.ts
```

Start from `scenario-template.scenario.ts`. The filename prefix becomes the Scenario ID.
The file is trusted TypeScript and must default-export `Scenario.start(...)` or
`Scenario.parameterized(...)`. Use ordinary functions for reusable generation
or composition. Keep a one-off helper in the Scenario file; move genuinely
shared helpers into a normal TypeScript module and import them directly.

When a scenario has a clear durable purpose,
move it to `src/corpus/scenarios/retained/examples/` or
`src/corpus/scenarios/retained/findings/`, give it a focused test, and register
it in `src/corpus/scenarios/registry.ts`. Promotion is deliberately a reviewed
source change; running a retained scenario still produces an ignored artifact.
