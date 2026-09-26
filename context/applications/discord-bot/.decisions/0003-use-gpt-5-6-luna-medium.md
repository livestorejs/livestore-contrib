# 0003 — Use GPT-5.6 Luna at medium reasoning effort

Status: accepted

## Context

Automatic thread naming and explicit documentation assistance need a shared AI
generation source with an intentional quality, latency, and cost posture. The
model does not own eligibility, authorization, canonical documentation truth,
or the decision to create a basic thread.

## Decision

Use the OpenAI Responses API with model ID `gpt-5.6-luna` and
`reasoning.effort: "medium"` for bot-owned AI generation. Each feature keeps a
strict output boundary: a title is a validated proposal, and a docs answer must
be grounded in the selected documentation snapshot. Timeouts, quotas, or model
failure degrade independently and never suppress otherwise eligible basic
thread creation.

Accepted 2026-08-23 by explicit maintainer direction. The official OpenAI model
catalog lists `gpt-5.6-luna`, Responses API support, and `medium` reasoning
effort.
