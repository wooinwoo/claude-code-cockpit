---
name: security-review
description: Review a fixed software revision for exploitable security and privacy risks when changes affect trust boundaries, identity, untrusted input, secrets, sensitive data, dependencies, or security configuration.
---

# Security Review

This is a fresh-context, read-only review. Do not edit code, tests, configuration, or artifacts. Read and follow [the review contract](../../skill-references/review-contract.md).

Trace attacker-controlled data and privilege across the changed trust boundaries. Check only applicable areas, including:

- authentication, authorization, tenant and object ownership;
- injection, unsafe deserialization, path traversal, SSRF, command execution, and browser boundaries;
- secret handling, cryptography use, logging, privacy, and data retention;
- dependency or configuration changes that alter exposure;
- concurrency, retries, defaults, and error paths that can bypass controls.

Prioritize reachable behavior and concrete impact. Do not inflate theoretical hardening ideas into vulnerabilities. Include a minimal attack or failure path in the evidence when safe inspection supports one; otherwise state the limitation.

Return `review.v1` with `review_kind` set to `security`.
