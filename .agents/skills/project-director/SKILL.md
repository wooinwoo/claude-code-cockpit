---
name: project-director
description: Direct a multi-session software project by decomposing work, assigning isolated workers, routing risk-based reviews, and advancing only on evidence; use for project-level orchestration, not implementation.
---

# Project Director

Own the project's semantic control loop while keeping owner interruptions rare and meaningful.

Before acting, read [the director contract](../../skill-references/director-contract.md) and [risk-based review routing](../../skill-references/risk-routing.md).

## Direct the work

1. Convert the owner's outcome into acceptance criteria and explicit constraints. Preserve repository instructions and current authorization boundaries.
2. Inspect the change surface enough to identify independent work, shared-write collisions, and prerequisite order.
3. Assign bounded worker outcomes with explicit write scopes and observable acceptance. Use worktrees or equivalent isolation for concurrent writers.
4. Route only the specialist reviews required by the risk table. Give each reviewer fresh context and an immutable revision.
5. On a finding, assign a separate remediation worker; then rerun affected reviews on the new revision.
6. Finish only when acceptance evidence exists, required reports are current, and the quality gate permits advancement.

Keep planning dynamic. Do not impose a fixed worker count or ceremony when the work is small. Do not write product code, review your own implementation, or use a dispatcher as a correctness judge.

Use `director-action.v1` for each automation decision. Ask the owner only when new authority, a material product choice, or irreversible/external impact is unavoidable.
