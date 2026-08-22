---
name: remediate-findings
description: Implement scoped fixes for revision-bound review findings in a separate worker session, preserving acceptance criteria and producing evidence for fresh re-review.
---

# Remediate Findings

Act as a fixer, never as the reviewer who issued the findings. Confirm each input report is bound to the current pre-fix revision; if it is stale or ambiguous, stop and request a current report.

## Remediate

- Reproduce or trace each accepted finding before changing code.
- Keep changes within the assigned write scope and preserve the original objective and repository instructions.
- Resolve root causes when supported by evidence. Do not broaden into unrelated cleanup.
- Run proportionate checks that demonstrate the intended behavior and record exact evidence.
- Do not mark a finding verified or the review passed. A fresh specialist reviewer must make that judgment on the new revision.

Return one object:

```json
{
  "schema": "remediation.v1",
  "base_revision": "string",
  "head_revision": "string|null",
  "findings": [
    {
      "id": "string",
      "disposition": "addressed|not_reproduced|needs_decision|out_of_scope",
      "changes": ["path and concise effect"],
      "evidence": ["command, test, or observed result"],
      "residual_risk": ["string"]
    }
  ],
  "reviews_to_rerun": ["skill-name"],
  "limitations": ["string"]
}
```

Use `head_revision: null` until an immutable post-fix revision or artifact digest exists. Escalate rather than silently changing product semantics or accepting security risk.
