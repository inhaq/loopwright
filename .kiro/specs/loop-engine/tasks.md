# Tasks — Loopwright Loop Engine

Status legend: `[x]` done · `[~]` in review · `[ ]` not started.
Each task references the requirement(s) it satisfies.

## Milestone 1 — Headless engine core (done)

- [x] 1. Task state machine with legal-transition table and terminal helpers
  _(Req 2, 5)_
- [x] 2. Schemas: plan/task spec, critic review with in-code rubric
  enforcement, task artifact bundle _(Req 1, 4)_
- [x] 3. Redaction utility (secret/PII rules + bounded truncation) _(Req 7)_
- [x] 4. Mechanical gate with injectable executor; default executor enforces
  hard timeout + bounded output capture _(Req 3)_
- [x] 5. Critic parser: robust JSON extraction (last schema-valid object) with
  retry-once policy hook _(Req 4)_
- [x] 6. Per-task actor–critic loop: build → gate → review → fix, with bounded
  mechanical-fix and review cycles and failure context fed forward _(Req 2, 5)_
- [x] 7. Plan-review loop with revision cap and open-items handling _(Req 1)_
- [x] 8. Degraded path: quota-exhaustion fallback to unverified, visible and
  never mislabeling blockers as nits _(Req 6)_
- [x] 9. Validated configuration (role bindings, caps, gate toggle, fallback,
  parallelism, timeouts, storage) with correct boolean parsing _(Req 12)_
- [x] 10. Role interfaces (`Actor`/`Critic`) + scriptable mocks + runnable demo
  _(Req 8)_
- [x] 11. Test suites: units, behavioral loop scenarios, real-subprocess gate

## Milestone 2 — Runners (in progress)

- [~] 12. Generic `CliRunner`: profile-driven subprocess backend (argv
  templating, stdin/arg prompt, env passthrough, output modes, quota detection,
  timeout, bounded capture, strict option validation) _(Req 8)_
- [ ] 13. Role-binding layer: turn a runner + role prompt templates into a
  working `Actor` and `Critic` _(Req 8)_
  - [ ] 13.1 Actor prompts: draft plan, build task, fix from feedback
  - [ ] 13.2 Critic prompts: plan review and task review producing rubric JSON
  - [ ] 13.3 Wire role bindings through configuration
- [ ] 14. `HttpRunner` for OpenAI-compatible endpoints (base URL + key + model)
  behind the same interface _(Req 8)_
- [ ] 15. End-to-end run against real runners on a sample goal _(Req 1, 2)_

## Milestone 3 — Persistence and resilience

- [ ] 16. Local store for sessions, tasks, attempts, transitions, outcomes
  _(Req 10, 11)_
- [ ] 17. Checkpoint on each transition; resume a run after interruption
  _(Req 10)_
- [ ] 18. Stuck-detection watchdog (no-progress threshold) feeding the loop
  _(Req 2, 5)_

## Milestone 4 — Parallel execution

- [ ] 19. Dependency-graph scheduler honoring the parallelism limit _(Req 9)_
- [ ] 20. Isolated workspaces (git worktrees) per concurrent task _(Req 9)_
- [ ] 21. Integrator: merge completed work, run full verification, surface
  conflicts _(Req 9)_

## Milestone 5 — Observability

- [ ] 22. Structured event log for transitions and runner calls _(Req 11)_
- [ ] 23. Usage/cost ledger per role and per run _(Req 11)_
- [ ] 24. Session trace inspection _(Req 11)_

## Milestone 6 — Desktop delivery

- [ ] 25. Desktop shell over the headless engine: start a run, monitor live
  progress, review results _(Req 13)_
- [ ] 26. Packaging and secure secret storage _(Req 13)_

---

### Current position

Milestone 1 is complete and merged. Milestone 2 is underway: the generic
command-line runner is implemented and in review; the next active task is the
**role-binding layer (13)** that connects runners to the actor/critic roles so
real backends drive the loop built in Milestone 1.
