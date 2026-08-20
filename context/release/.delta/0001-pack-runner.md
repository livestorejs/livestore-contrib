# Delta 0001 — The pack job runs on the shared runner

Status: accepted

Core runs the untrusted pack job on a hosted runner. Contrib runs it on the same
shared runner as its other pull-request jobs.

## Why the difference

Contrib composes core from source, so a hosted runner would rebuild the core
package closure from cold on every pull request. Core's own build does not carry
that cost.

## Why it does not weaken the boundary

Contrib's pull-request jobs already run fork-authored code on this runner with
no secrets available, so the pack job introduces no exposure that did not
already exist. The properties the boundary depends on are unchanged: the job
holds no registry credential, its token is read-only, and everything it uploads
is treated as untrusted input by the trusted half.
