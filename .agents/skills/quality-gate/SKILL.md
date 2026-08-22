---
name: quality-gate
description: Make a deterministic advance-or-stop decision from current revision-bound acceptance evidence and required specialist reports; use after reviews, not to perform or override them.
---

# Quality Gate

Operate read-only. Do not edit artifacts, perform remediation, reinterpret absent evidence as success, or decide by reviewer majority.

Read [the review contract](../../skill-references/review-contract.md) to validate input reports and [risk-based review routing](../../skill-references/risk-routing.md) to determine required reviews.

## Gate rules

- Confirm all inputs refer to the exact candidate revision or artifact digest.
- Stop for any required missing, stale, `fail`, or `inconclusive` report.
- Stop for any unresolved blocking finding, failed acceptance criterion, or required check without evidence.
- A `warn` permits advancement only when every finding is non-blocking and residual risk is explicitly recorded.
- Do not average severity, confidence, or votes. One supported blocker is sufficient to stop.

Return one object:

```json
{
  "schema": "quality-gate.v1",
  "candidate": {"revision": "string|null", "artifact_digest": "string|null"},
  "decision": "advance|stop|inconclusive",
  "acceptance": [
    {"criterion": "string", "status": "met|unmet|not_verified", "evidence": ["string"]}
  ],
  "reports": [
    {"review_kind": "string", "status": "current|missing|stale", "verdict": "string|null"}
  ],
  "blockers": ["finding id or missing evidence"],
  "residual_risk": ["non-blocking accepted risk"],
  "next_action": "string"
}
```

This gate authorizes workflow advancement only. Deployment or other external mutation still requires its own configured authority.
