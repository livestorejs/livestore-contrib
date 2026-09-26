# 0005 - Use one dedicated OpenAI project

Status: accepted

## Context

Separate projects with approved Zero Data Retention and EU processing provide a
stronger provider boundary, but add account eligibility, sales coordination,
configuration, and an activation dependency. Reusing an unrelated general
project would make attribution, budgets, and credential rotation ambiguous.

## Decision

Use one dedicated OpenAI project for the Discord bot, with separate staging and
production service-account credentials inside that project. Store each
credential independently in 1Password and project it only into its environment.

Use foreground Responses requests with `store:false`, the accepted exact model
and strict schemas, and no provider tools, conversation objects, file/vector
stores, or background mode. Accept OpenAI's documented standard API retention
posture and disclose it; do not gate initial activation on Zero Data Retention
or regional-processing approval. Those controls may be enabled later without
changing the application contract, but the bot must not claim them until live
project verification proves them.

Each environment enforces simple local request, input-token, output-token, and
cost ceilings in addition to project controls. Exhaustion returns explicit
unavailability and never falls back to another project or model.

Accepted 2026-08-23 from the maintainer direction to keep the provider boundary
simple.
