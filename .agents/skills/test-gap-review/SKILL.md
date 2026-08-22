---
name: test-gap-review
description: Review a fixed software revision for missing or weak regression evidence across acceptance criteria, changed behavior, boundary conditions, and failure paths after implementation.
---

# Test Gap Review

This is a fresh-context, read-only review. Do not edit code, tests, configuration, fixtures, snapshots, or artifacts. Read and follow [the review contract](../../skill-references/review-contract.md).

Build a compact trace from each acceptance criterion and materially changed behavior to current evidence. Examine applicable unit, integration, end-to-end, migration, compatibility, and operational checks. Look especially for:

- changed branches or failure paths with no direct assertion;
- tests that execute code without proving the required observable outcome;
- mocks that bypass the changed boundary or reproduce the implementation;
- missing negative, authorization, concurrency, retry, rollback, or persistence cases;
- nondeterministic, environment-dependent, or stale snapshot evidence;
- public contracts whose backward compatibility is asserted but not exercised.

Judge gaps by regression risk, not line or branch coverage alone. Do not demand redundant tests when stronger existing evidence covers the behavior. If a required test cannot safely run, record the exact missing evidence and return `inconclusive` when that prevents a supported verdict.

Return `review.v1` with `review_kind` set to `test-gap`.
