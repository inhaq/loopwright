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

## Milestone 2 — Runners (done)

- [x] 12. Generic `CliRunner`: profile-driven subprocess backend (argv
  templating, stdin/arg prompt, env passthrough, output modes, quota detection,
  timeout, bounded capture, strict option validation) _(Req 8)_
- [x] 13. Role-binding layer: turn a runner + role prompt templates into a
  working `Actor` and `Critic` _(Req 8)_
  - [x] 13.1 Actor prompts: draft plan, build task, fix from feedback
  - [x] 13.2 Critic prompts: plan review and task review producing rubric JSON
  - [x] 13.3 Wire role bindings through configuration
- [x] 14. `HttpRunner` for OpenAI-compatible endpoints (base URL + key + model)
  behind the same interface _(Req 8)_
- [x] 15. End-to-end run against real runners on a sample goal _(Req 1, 2)_

## Milestone 3 — Persistence and resilience (done)

- [x] 16. Local store for sessions, tasks, attempts, transitions, outcomes
  _(Req 10, 11)_
- [x] 17. Checkpoint on each transition; resume a run after interruption
  _(Req 10)_
- [x] 18. Stuck-detection watchdog (no-progress threshold) feeding the loop
  _(Req 2, 5)_

## Milestone 4 — Parallel execution (done)

- [x] 19. Dependency-graph scheduler honoring the parallelism limit _(Req 9)_
- [x] 20. Isolated workspaces (git worktrees) per concurrent task _(Req 9)_
- [x] 21. Integrator: merge completed work, run full verification, surface
  conflicts _(Req 9)_

## Milestone 5 — Observability (done)

- [x] 22. Structured event log for transitions and runner calls _(Req 11)_
- [x] 23. Usage/cost ledger per role and per run _(Req 11)_
- [x] 24. Session trace inspection _(Req 11)_

## Milestone 6 — Desktop delivery (in progress)

- [~] 25. Desktop shell over the headless engine: start a run, monitor live
  progress, review results _(Req 13)_
  - [~] 25.1 Engine HTTP/SSE server (`src/server/`) wrapping `runGoal` +
    `buildTrace`; streams live transitions, attempts, outcomes, and runner
    calls over SSE without adding orchestration policy
  - [~] 25.2 Tauri shell that runs the engine as a bundled sidecar process and
    loads the web frontend (Start / Monitor / Results views)
- [~] 26. Packaging and secure secret storage _(Req 13)_
  - [~] 26.1 OS-keychain secret storage (Tauri commands backed by `keyring`)
  - [~] 26.2 Inject stored API keys into the sidecar env so runner `apiKeyEnv`
    bindings resolve without plaintext on disk

---

### Current position

Milestones 1–5 are complete and merged on `main` (engine core, runners +
role bindings, persistence/resume, the parallel scheduler with git-worktree
isolation and the integrator, and the observability/usage/trace layer); the
suite is green (132 tests, `tsc --noEmit` clean).

Active work is **Milestone 6 — Desktop delivery**. Rather than reimplement loop
logic (forbidden by Req 13), the desktop app reuses the headless engine through
a thin Node **HTTP/SSE server** (`src/server/`) that wraps `runGoal` and
`buildTrace`. That server is compiled to a single binary and shipped as a
**Tauri sidecar**; the Tauri shell hosts the web frontend (start a run, monitor
live progress over SSE, review the final trace) and stores runner API keys in
the OS keychain, injecting them into the sidecar's environment so no secret is
written to disk in plaintext.
