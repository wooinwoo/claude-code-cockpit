# Risk-Based Review Routing

Select reviews from the actual change surface. Do not run every specialist by habit.

| Change surface | Required specialist reviews |
| --- | --- |
| Ordinary product or maintenance change | `convention-review`, `adversarial-review`, `test-gap-review` |
| Authentication, authorization, untrusted input, secrets, sensitive data, dependencies, or security configuration | Add `security-review` |
| Cross-module ownership, public API/schema, migrations, shared state, or dependency direction | Add `architecture-review` |
| Latency/throughput-sensitive paths, large data, repeated I/O, concurrency, caching, or resource limits | Add `performance-review` |
| Release candidate | All specialists required by the rows above, then `release-readiness`, then `quality-gate` |

The director may add a specialist when concrete risk warrants it, or mark a listed specialist not applicable with a reason tied to the diff. Unknown material risk is a reason to inspect or return `inconclusive`, not a reason to assume safety.

Run specialists against the same immutable revision whenever their results will feed one gate. If remediation changes relevant files, rerun affected specialists and any downstream release or quality gate.
