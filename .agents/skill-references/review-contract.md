# Review Contract

Use this contract for every specialist review and release-readiness assessment.

## Independence and authority

- Start from fresh context. Accept only the original objective, acceptance criteria, repository instructions, the exact artifact or diff, and evidence needed to inspect it.
- Do not accept implementer reasoning, suspected defects, proposed fixes, or another reviewer's conclusion before forming the initial judgment.
- Operate read-only. Do not edit source, tests, configuration, generated artifacts, or review inputs.
- Bind the report to an immutable source state: `base_revision` plus `head_revision`, or an `artifact_digest` when revisions do not apply.
- Treat the report as stale after any relevant source change. A remediation requires a new independent review of the new revision.
- Do not infer correctness from reviewer count, votes, confidence scores, or the implementer's assertions.
- If required evidence is absent or inaccessible, return `inconclusive`; never convert missing evidence into `pass`.

## Verdict rules

- `pass`: no blocking issue was found in the examined scope and required evidence was available.
- `warn`: only non-blocking, actionable risk remains.
- `fail`: at least one blocking finding exists or a non-negotiable acceptance criterion is violated.
- `inconclusive`: the review cannot support a verdict because required scope or evidence is missing.

Severity expresses impact; confidence expresses evidentiary strength. Keep them separate. A finding is blocking only when its risk or acceptance impact justifies stopping the workflow.

## Required output

Return one JSON object and no alternate verdict outside it:

```json
{
  "schema": "review.v1",
  "review_kind": "security|convention|adversarial|test-gap|architecture|performance|release-readiness",
  "scope": {
    "project": "string",
    "objective": "string",
    "base_revision": "string|null",
    "head_revision": "string|null",
    "artifact_digest": "string|null",
    "paths": ["string"]
  },
  "verdict": "pass|warn|fail|inconclusive",
  "summary": "string",
  "checks": [
    {
      "id": "string",
      "status": "pass|fail|not_applicable|not_verified",
      "evidence": ["string"]
    }
  ],
  "findings": [
    {
      "id": "stable-string",
      "severity": "critical|high|medium|low",
      "confidence": "high|medium|low",
      "category": "string",
      "title": "string",
      "claim": "falsifiable statement",
      "evidence": [
        {"path": "string", "line": 0, "detail": "string"}
      ],
      "impact": "string",
      "required_action": "outcome, not implementation prescription",
      "verification": "how a fresh reviewer can verify remediation",
      "blocking": true
    }
  ],
  "coverage": {
    "examined": ["string"],
    "omitted": ["string"],
    "limitations": ["string"],
    "assumptions": ["string"]
  }
}
```

Use an empty `findings` array for a supported pass. Cite file and line evidence where possible; otherwise name the command, test result, artifact, or observed behavior. Do not prescribe a patch unless the required outcome cannot be expressed clearly without one.
