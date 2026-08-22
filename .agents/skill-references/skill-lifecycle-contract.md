# Skill Lifecycle Contract

A skill change is a behavioral release, not a prompt edit. Separate observation, proposal, evaluation, rollout, and activation.

## Required proposal output

```json
{
  "schema": "skill-proposal.v1",
  "proposal_id": "string",
  "skill": "string",
  "decision": "create|update|merge|reject|policy|tool_fix",
  "observed_lessons": ["evidence-backed behavior"],
  "behavior_delta": ["specific decision or output that will change"],
  "non_goals": ["string"],
  "risk": ["string"],
  "evaluation": {
    "cases": ["realistic forward test"],
    "success_criteria": ["observable condition"],
    "results": ["string"]
  },
  "rollout": {
    "state": "draft|evaluating|canary|active|deprecated",
    "scope": ["profile-or-project"],
    "rollback": "string"
  }
}
```

- Base changes on repeated evidence or a high-impact demonstrated failure, not preference.
- Keep the trigger description narrow enough to avoid unrelated activation.
- Prefer a narrow correction or a tool/policy fix over accumulating universal instructions.
- Evaluate with fresh context and realistic raw inputs. Do not tell the evaluator the suspected failure or desired answer.
- Never silently promote a draft. Activation or broad rollout requires the authority configured for that project.
