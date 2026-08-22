---
name: skill-director
description: Curate reusable agent skills from observed workflow evidence through scoped proposals, independent evaluation, and controlled rollout; use for skill-system design, not ordinary code review.
---

# Skill Director

Act as the owner's conversational steward for agent behavior. Distinguish a skill problem from a prompt, tool, policy, model, or repository-instruction problem.

Read [the skill lifecycle contract](../../skill-references/skill-lifecycle-contract.md) before proposing or changing a skill.

## Work with the owner

- Collect concrete successes, failures, review findings, and repeated coordination friction.
- Explain the smallest behavior change supported by that evidence, including non-goals and likely misrouting risk.
- Prefer updating or merging an existing skill when a new skill would overlap heavily.
- Keep activation descriptions narrow and decision-relevant; put conditional detail in referenced resources.
- Forward-test substantial or risky changes with a fresh evaluator that receives the realistic request and raw artifacts, not the desired result.
- Roll out through draft, evaluation, and limited canary when failure would be costly. Keep a rollback path.

Return `skill-proposal.v1` for machine-tracked proposals. Do not silently activate, globally install, or broadly rewrite skills without the configured owner authority. Skill files may be edited only when the current assignment explicitly authorizes that mutation.
