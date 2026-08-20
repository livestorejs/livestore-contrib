# 0001 — Compose the shared pipeline rather than copy it

Status: accepted

## Context

Core had a working label-gated PR snapshot pipeline. Contrib needed the same
guarantee for its own packages.

## Options

| Option                                  | Consequence                                                                      |
| --------------------------------------- | -------------------------------------------------------------------------------- |
| Copy the pipeline into contrib          | Immediate; forks the code that decides what may be published                     |
| Extract to a shared factory, consume it | Two repos, one implementation; needs an extraction that provably changes nothing |
| Leave contrib without PR snapshots      | No new surface; external contributions stay unusable without a local build       |

## Decision

Extract the pipeline into `effect-utils` and consume it. The extraction was
performed against core first and gated on byte-identical generated output, so
contrib inherits an implementation already proven against a real publication
rather than a copy that merely looks equivalent.

The validator is emitted from the shared source in both repos, so the rules for
what constitutes a valid candidate cannot drift apart.
