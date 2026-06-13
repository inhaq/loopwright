# Requirements — Loopwright Loop Engine

## Introduction

Loopwright is a model-agnostic **loop-engineering** system. A user states a goal;
the system decomposes it into a verified plan, executes the tasks, checks the
results against real verification, fixes what fails, and returns finished work.

The product is built around an **actor–critic** control loop:

- **Actor** — the high-volume worker role: drafts the plan, builds each task,
  and fixes issues.
- **Critic** — the scarce, gating reviewer role: reviews the plan and every
  task result, and holds the "green pass" gate.

Both roles are vendor-neutral. They are backed by pluggable **runners**
(command-line or HTTP) selected purely by configuration, so the engine never
depends on a specific provider or model.

This document is the source of truth for what the system must do. Terms:

- **DoD** — definition of done: the machine-checkable verification for a task.
- **Mechanical gate** — running a task's build/test/lint commands.
- **Blocker / Nit** — critic finding severities (see Requirement 4).

---

## Requirements

### Requirement 1 — Goal decomposition with plan review

**User Story:** As a user, I want my goal broken into a reviewed plan of
dependent tasks, so that work is well-scoped and verifiable before any building
starts.

#### Acceptance Criteria

1. WHEN a goal is submitted THEN the system SHALL produce a plan of tasks, each
   with a title, description, acceptance criteria, verification commands, and
   declared dependencies.
2. WHEN a plan is produced THEN the critic SHALL review it before any task is
   built.
3. IF the critic returns blocking findings on the plan THEN the actor SHALL
   revise the plan and it SHALL be re-reviewed.
4. WHEN the plan-revision limit is reached without approval THEN the system
   SHALL proceed while recording the unresolved items as open.
5. IF the critic is unavailable during plan review THEN the system SHALL proceed
   with the plan explicitly marked unverified.

### Requirement 2 — Per-task actor–critic execution loop

**User Story:** As a user, I want each task built, verified, and corrected
automatically, so that I receive working results without manual iteration.

#### Acceptance Criteria

1. WHEN a task is ready (its dependencies are satisfied) THEN the actor SHALL
   build it.
2. WHEN a build attempt completes THEN the system SHALL run the mechanical gate
   before involving the critic.
3. IF the mechanical gate passes THEN the critic SHALL review the task result.
4. IF the critic returns a green pass THEN the task SHALL be marked complete.
5. IF the critic returns blocking findings THEN the actor SHALL fix the task and
   the loop SHALL repeat.
6. WHEN any cycle cap is reached without a green pass THEN the task SHALL be
   marked as needing human attention.

### Requirement 3 — Mechanical verification gate

**User Story:** As a user, I want results checked by real build/test/lint runs,
so that "done" reflects executable verification, not just an opinion.

#### Acceptance Criteria

1. WHEN a task declares verification commands THEN the gate SHALL execute them in
   order and stop at the first failure.
2. WHEN a verification command fails THEN the failure output SHALL be fed back to
   the actor for the next fix attempt.
3. WHEN the gate runs THEN each command SHALL be subject to a hard timeout and
   bounded output capture.
4. WHEN command output is captured THEN it SHALL be redacted before being stored
   or sent to the critic (see Requirement 7).
5. The mechanical gate SHALL be enable/disable-able by configuration.

### Requirement 4 — Critic review contract and rubric

**User Story:** As a maintainer, I want the critic's authority limited to
substantive issues, so that the loop converges instead of churning on taste.

#### Acceptance Criteria

1. WHEN the critic reviews THEN it SHALL return a structured result containing a
   verdict and a list of findings, each with a severity and a category.
2. A finding SHALL be classifiable as `blocker` only when its category is one of:
   correctness, requirements, test integrity, regression/breakage, or security.
3. WHEN a finding's category is outside that set THEN it SHALL be treated as a
   non-blocking `nit`.
4. WHEN any blocker is present THEN the verdict SHALL be "changes required";
   otherwise it SHALL be "green".
5. WHEN the critic's raw output cannot be parsed THEN the system SHALL retry once
   with a corrective hint, and THEN mark the task as needing human attention if
   it still cannot be parsed.
6. A `nit` SHALL never trigger another fix cycle.

### Requirement 5 — Bounded retries and terminal outcomes

**User Story:** As a user, I want the loop to always terminate with a clear
outcome, so that it never spins indefinitely or hides failures.

#### Acceptance Criteria

1. The number of mechanical-fix attempts and critic-review cycles per task SHALL
   each be bounded by configuration.
2. WHEN a fix is retried THEN the prior failure context SHALL be provided to the
   actor so the next attempt differs.
3. The task lifecycle SHALL resolve into exactly one terminal outcome: completed,
   needs-human, or unverified.
4. WHEN a task ends in needs-human THEN the unresolved blocking findings SHALL be
   reported.

### Requirement 6 — Degraded operation when the critic is unavailable

**User Story:** As a user, I want the run to survive an exhausted reviewer quota,
so that a usage limit doesn't crash the pipeline or silently fake approval.

#### Acceptance Criteria

1. WHEN a runner signals an exhausted usage/rate window THEN the system SHALL
   treat the critic as unavailable rather than failing.
2. WHEN the critic is unavailable AND fallback is enabled THEN the actor MAY
   self-review, and the result SHALL be recorded as unverified.
3. An unverified result SHALL be distinguishable from a real green pass in all
   data, logs, and UI.
4. WHEN the critic is unavailable AND fallback is disabled THEN the task SHALL be
   paused for human attention.
5. A self-review SHALL NOT surface blocker-severity findings as nits.

### Requirement 7 — Secret and PII redaction

**User Story:** As a security-conscious user, I want secrets removed before any
content leaves the engine, so that reviewing a result can't leak credentials.

#### Acceptance Criteria

1. WHEN a diff or command output is prepared for review or persistence THEN
   secret-shaped values (API keys, tokens, bearer headers, cloud keys) and
   absolute home paths SHALL be redacted.
2. Redaction SHALL be conservative: over-redaction is acceptable; leaking a real
   secret is not.
3. WHEN captured output exceeds a size limit THEN it SHALL be truncated while
   preserving the most relevant head and tail.

### Requirement 8 — Pluggable, model-agnostic runners

**User Story:** As an operator, I want to plug in any agent backend via
configuration, so that the system is never locked to one provider or model.

#### Acceptance Criteria

1. The engine SHALL interact with backends only through a single runner
   interface (execute a prompt in a workspace, return raw text plus metadata).
2. A runner SHALL be configured entirely by a profile (mechanism, model
   identifier, and mechanism-specific options); adding a provider SHALL be a new
   profile, not engine changes.
3. The system SHALL provide a command-line runner (subprocess) and SHALL allow an
   HTTP runner for OpenAI-compatible endpoints.
4. A runner SHALL support passing through environment secrets by reference
   without hard-coding them in the engine.
5. A runner SHALL report an exhausted usage/rate window to the engine.
6. No provider, product, or model name SHALL appear in engine code; runners are
   named by mechanism.

### Requirement 9 — Parallel execution with isolation

**User Story:** As a user, I want independent tasks to run concurrently without
corrupting each other, so that large goals finish faster and cleanly.

#### Acceptance Criteria

1. WHEN tasks have no dependency relationship THEN they MAY run concurrently up
   to a configured parallelism limit.
2. WHEN tasks run concurrently THEN each SHALL operate in an isolated workspace
   so their changes do not collide.
3. WHEN parallel tasks complete THEN their changes SHALL be integrated and the
   full verification SHALL be run on the integrated result.
4. WHEN integration conflicts occur THEN they SHALL be surfaced and resolvable
   rather than silently merged.

### Requirement 10 — Persistence, checkpointing, and resume

**User Story:** As a user, I want a run to survive interruption, so that a crash
or restart doesn't lose progress.

#### Acceptance Criteria

1. The system SHALL persist sessions, tasks, attempts, transitions, and outcomes.
2. WHEN a state transition occurs THEN it SHALL be checkpointed.
3. WHEN a run is restarted after interruption THEN it SHALL resume from the last
   checkpoint without repeating completed tasks.

### Requirement 11 — Observability and usage tracking

**User Story:** As an operator, I want to trace every decision and track usage,
so that I can debug runs and manage cost.

#### Acceptance Criteria

1. The system SHALL record a structured event for every state transition and
   runner invocation.
2. The system SHALL track usage/cost signals per role and per run.
3. The system SHALL expose a way to inspect the full trace of a session.

### Requirement 12 — Configuration

**User Story:** As an operator, I want behavior controlled by validated
configuration, so that misconfiguration fails fast and clearly.

#### Acceptance Criteria

1. Configuration SHALL cover role→runner bindings, loop caps, gate toggle,
   fallback policy, parallelism, isolation, timeouts, and storage location.
2. WHEN configuration is loaded THEN it SHALL be validated and SHALL reject
   invalid values with a clear message.
3. Boolean settings SHALL interpret common string spellings correctly (e.g.
   "false"/"0" are false).

### Requirement 13 — Desktop delivery (later milestone)

**User Story:** As a user, I want to launch and monitor runs from a desktop app,
so that long, asynchronous runs are easy to start and observe.

#### Acceptance Criteria

1. The system SHALL be usable headlessly (the engine has no UI dependency).
2. A desktop application SHALL allow starting a run, monitoring live progress,
   and reviewing results.
3. The desktop application SHALL reuse the headless engine without
   reimplementing loop logic.
