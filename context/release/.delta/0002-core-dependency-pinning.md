# Delta 0002 — Core dependency specs are not yet validator-pinned

Status: open

The shared validator enforces exact versions only for packages listed in the
topology. Contrib's topology is its own packages, so the core dependencies a
published contrib package carries are chosen by the pack job — which runs
fork-authored code.

## Scope

This is not a regression against core, where every workspace dependency is in
the topology and therefore pinned. It is a difference that follows from contrib
depending on packages it does not publish.

Fork code authors the tarball contents regardless, so this does not grant a
capability that did not exist. What it means is that contrib's trusted
validation is weaker than core's, and the guarantee stated in LSC.REL-R3 is
currently carried by the pack task rather than enforced by the validator.

## Intended resolution

Require every core dependency spec to be identical across the cohort and exact,
and have the trusted job derive the expected version independently: read the
lockfile at the pull request head through the base repository's API — a trusted
channel — and resolve it. The untrusted artifact must never be the source of the
expected value.
