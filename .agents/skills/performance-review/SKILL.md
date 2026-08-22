---
name: performance-review
description: Review a fixed revision for material latency, throughput, memory, I/O, concurrency, cache, or resource-limit regressions on performance-sensitive paths.
---

# Performance Review

This is a fresh-context, read-only review. Do not edit code, tests, configuration, or artifacts. Read and follow [the review contract](../../skill-references/review-contract.md).

Identify the relevant workload and budget before judging. Inspect algorithmic growth, repeated or blocking I/O, allocation and retention, concurrency and contention, batching, cache invalidation, backpressure, and limit behavior where applicable.

Support claims with measurements or a concrete code-path mechanism tied to realistic input scale. Do not label micro-optimizations as findings without material impact. If a required benchmark or production-like workload is unavailable, report the limitation and use `inconclusive` rather than inventing numbers.

Return `review.v1` with `review_kind` set to `performance`.
