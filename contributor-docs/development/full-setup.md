# Full Setup (Nix + devenv)

Full Setup is the hermetic path for generated sources, browsers, native
platforms, releases, infrastructure, and repository-wide parity. The shared
boundary is defined by the core [developer-environment spec](https://github.com/livestorejs/livestore/blob/main/context/03-delivery/01-composition/01-developer-environment/spec.md)
and [requirements R02-R06](https://github.com/livestorejs/livestore/blob/main/context/03-delivery/01-composition/01-developer-environment/requirements.md#requirements).

## Prerequisites

| Tool | Requirement | Official installation | Verify |
| --- | --- | --- | --- |
| Nix | Supported installation | [Nix download](https://nixos.org/download/) | `nix --version` |
| devenv | Available on `PATH` | [devenv installation](https://devenv.sh/getting-started/) | `devenv version` |

## Enter the environment

```bash
devenv shell
```

Shell entry prepares the locked composed workspace, dependencies, and generated
sources. TypeScript and repository validation remain explicit. For reproducible
preparation without entering an interactive shell, run:

```bash
devenv tasks run setup:strict --mode before
```

## Common tasks

| Task | Command |
| --- | --- |
| Run the full repository check | `devenv tasks run check:all --mode before` |
| Check generated projections | `devenv tasks run genie:check --mode before` |
| Check composed source state | `devenv tasks run mr:check --mode before` |

Example manifests are standalone, manually maintained files and are intentionally
excluded from `genie:run` and `genie:check`. When updating core's Effect cohort,
align each example's `pnpm.overrides` with `repos/livestore/genie/external.ts`
(currently Effect 4.0.3), preserving the example's other dependency pins and
metadata. There is no example-manifest regeneration command.

Only refresh remote refs and rewrite `megarepo.lock` when intentionally moving
the composed dependency graph:

```bash
mr fetch --apply
```

For ordinary TypeScript work that does not require these capabilities, prefer
[Minimal Setup](./minimal-setup.md).
