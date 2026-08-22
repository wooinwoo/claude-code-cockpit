---
name: context-handoff
description: Produce a compact, evidence-linked handoff that lets a fresh agent session continue a long-running project without inheriting transcripts or unsupported conclusions.
---

# Context Handoff

Use this when a worker or director session is ending, context is becoming unwieldy, or responsibility is moving to a fresh session.

Read and emit [the handoff contract](../../skill-references/handoff-contract.md).

Reconcile claims against the current repository and durable task state before writing the handoff. Prefer paths, revisions, commands, report IDs, and artifact digests over narrative. Preserve unresolved owner decisions and authorization boundaries. Identify stale reviews and the single next action that restores momentum.

Do not copy chat history, hidden reasoning, secrets, speculative diagnoses, or obsolete plans. Do not claim completion merely because a prior session did. The receiver must be able to distinguish verified state, remaining work, risk, and uncertainty from this artifact alone.
