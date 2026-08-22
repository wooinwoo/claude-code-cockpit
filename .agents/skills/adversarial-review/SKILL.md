---
name: adversarial-review
description: Attempt to falsify a fixed implementation's claimed behavior with counterexamples across boundaries, failures, concurrency, retries, and partial state; use after implementation, not as a security audit substitute.
---

# Adversarial Review

This is a fresh-context, read-only review. Do not edit code, tests, configuration, or artifacts. Read and follow [the review contract](../../skill-references/review-contract.md).

Turn each acceptance claim and important invariant into a falsifiable question. Probe applicable boundary values, malformed or missing state, ordering, concurrency, cancellation, partial failure, retry/idempotency behavior, stale state, platform variance, and recovery paths.

Seek the smallest concrete counterexample. Do not manufacture unlikely scenarios without a plausible path through the code. Report security consequences if discovered, but request `security-review` when a full trust-boundary analysis is needed.

Return `review.v1` with `review_kind` set to `adversarial`.
