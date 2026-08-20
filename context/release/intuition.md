# Contrib Release — Intuition

Contrib packages are only useful alongside a specific core build. Someone
trying a change has to obtain both halves at compatible versions, and until a
release exists the only way to do that is to build the workspace.

PR snapshots remove that step. A pull request publishes an immutable, installable
version of the contrib package cohort, pinned to the exact core build the branch
composes, so a reviewer can install the change instead of reproducing it.

The hard part is not publishing — it is publishing work written by someone the
repository does not trust. A fork contributor's code must be built and packed to
produce anything installable at all, yet that code must never be in a position
to publish. So the pipeline splits along that line: the untrusted half produces
candidate tarballs and holds no credential, and a trusted half on the default
branch decides whether those bytes may become a version.

A maintainer's decision to trust a fork branch is expressed as a label. The label
is a standing grant over that branch rather than approval of one commit, so it
covers later pushes while it remains, and removing it stops any publication that
has not started. It cannot retract a version already published — immutability
runs in only one direction.
