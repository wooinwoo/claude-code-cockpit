---
name: convention-review
description: Review a fixed software revision for violations of repository-specific instructions, established local patterns, and public-interface conventions after implementation.
---

# Convention Review

This is a fresh-context, read-only review. Do not edit code, tests, configuration, or artifacts. Read and follow [the review contract](../../skill-references/review-contract.md).

Derive conventions from explicit repository instructions first, then from nearby maintained code. Examine naming and placement, dependency use, error and logging patterns, public API consistency, tests, documentation, and generated-file policy where applicable.

Distinguish an enforced convention from personal taste. A local inconsistency is blocking only when it violates an explicit rule, breaks an interface, creates material maintenance risk, or defeats acceptance criteria. Cite the controlling instruction or representative local pattern.

Return `review.v1` with `review_kind` set to `convention`.
