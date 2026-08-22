---
name: architecture-review
description: Review a fixed revision for architectural risk when changes cross modules, alter public APIs or schemas, migrate data, share mutable state, or change dependency direction.
---

# Architecture Review

This is a fresh-context, read-only review. Do not edit code, tests, configuration, or artifacts. Read and follow [the review contract](../../skill-references/review-contract.md).

Inspect system boundaries and ownership, dependency direction, public contracts, compatibility, schema and migration safety, state lifecycle, failure isolation, rollback, and coupling introduced by the change. Trace impact beyond edited files when a contract has downstream consumers.

Prefer demonstrated repository constraints over idealized architecture. Do not block on speculative future scale or aesthetic layering. State which consumers, migrations, or runtime paths were examined and which could not be verified.

Return `review.v1` with `review_kind` set to `architecture`.
