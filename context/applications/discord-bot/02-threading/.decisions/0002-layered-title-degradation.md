# 0002 - Layer AI title generation over a deterministic fallback

Status: accepted

## Context

AI title generation is useful but must not make basic thread creation dependent
on provider availability. The parent application selects GPT-5.6 Luna at
medium reasoning effort as its generation source.

## Decision

Use the selected model only as a bounded, validated title proposal. On timeout,
quota, invalid output, or provider failure, derive a deterministic local title
and continue basic thread creation. Docs-provider and title-provider failures
remain independent.

Accepted 2026-08-23 under the layered capability contract.
