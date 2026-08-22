# Context Handoff Contract

A handoff is a compact reconstruction aid, not a transcript or a substitute for repository evidence. Include facts that let a fresh session continue without inheriting unsupported conclusions.

Return:

```json
{
  "schema": "handoff.v1",
  "objective": "string",
  "acceptance_criteria": ["string"],
  "state": "planned|in_progress|reviewing|blocked|complete",
  "revision": {"base": "string|null", "head": "string|null"},
  "completed": [
    {"outcome": "string", "evidence": ["path, command, or artifact"]}
  ],
  "remaining": [
    {"task": "string", "reason": "string", "dependencies": ["string"]}
  ],
  "decisions": [
    {"decision": "string", "reason": "string", "source": "owner|repo|evidence"}
  ],
  "risks": ["string"],
  "required_reviews": ["skill-name"],
  "owner_questions": ["only material unresolved decisions"],
  "next_action": "single concrete next step"
}
```

Do not include secrets, hidden reasoning, obsolete intermediate hypotheses, or claims without evidence. Mark uncertainty explicitly. A receiving session must re-check revision-sensitive facts before acting.
