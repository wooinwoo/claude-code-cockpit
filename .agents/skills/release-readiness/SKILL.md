---
name: release-readiness
description: Assess whether a fixed release candidate has current build, test, review, migration, rollback, configuration, compatibility, and observability evidence needed to ship.
---

# Release Readiness

This is a fresh-context, read-only assessment. Do not edit code, tests, configuration, or artifacts. Read [the review contract](../../skill-references/review-contract.md) and [risk-based review routing](../../skill-references/risk-routing.md).

Verify that all evidence refers to the same candidate revision. Check applicable build and test results, required specialist reports, artifact provenance, configuration and secret requirements, dependency and license changes, migrations and rollback, compatibility, deployment sequencing, monitoring, and post-release recovery.

Do not waive a missing required report or failed check. Mark stale evidence as missing. Operational items may be `not_applicable` only with a reason tied to the actual release surface.

Return `review.v1` with `review_kind` set to `release-readiness`. This assessment supplies evidence to `quality-gate`; it does not authorize deployment.
