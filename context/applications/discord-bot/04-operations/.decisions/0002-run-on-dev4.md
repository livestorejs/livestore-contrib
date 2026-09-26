# 0002 - Run the singleton Gateway service on dev4

Status: superseded by
[decision 0007](./0007-use-cloudflare-canonical-host.md)

## Context

Automatic threading requires a persistent Gateway consumer, single-writer
mutation authority, secret projection, externally observed readiness, and
rebuild-free rollback. The fleet already operates persistent NixOS services on
dev4 through `deploy-rs`; molty2 is a resource-constrained migration-away
substrate and was not reachable during the 2026-08-23 host check.

## Decision

Run each bot environment as a dedicated Nix-managed systemd service and service
user on dev4. Dotfiles owns the host unit, `deploy-rs` activation, secret
projection, supervision, state directory, telemetry forwarding, and rollback;
livestore-contrib owns the immutable application artifact and its decoded
configuration contract.

Enforce Action Authority with a host-local singleton lock plus stop-old,
start-new deployment. A candidate cannot connect to the Gateway until the old
runtime has released authority. State lives under `/var/lib/discord-bot/` in an
environment-specific namespace and is not shared with SCG or Molty services.

Accepted 2026-08-23 after fleet-pattern review and a live reachability/capacity
check. Activation remains blocked until a scoped dev4 preflight proves the new
unit, secret references, health endpoints, state permissions, and rollback; the
host's unrelated aggregate systemd state is not evidence for or against that
scoped result.

## Amendment

Superseded 2026-08-27 after the Cloudflare Worker and singleton Durable Object
realization became the canonical staging and eventual production host. The
proposed dev4 service was never activated and its disabled dotfiles PR was
closed rather than merged. The Node implementation remains source fallback,
not a second deployment target.
