# Design — Loopwright Loop Engine

## Overview

Loopwright is a headless, model-agnostic engine that runs an **actor–critic**
control loop over a goal. The design separates three concerns so each can evolve
independently:

1. **Roles** (`Actor`, `Critic`) — what the loop needs, expressed as behavior.
2. **Runners** (`AgentRunner`) — how a backend executes a prompt; vendor-neutral.
3. **Orchestration** (the loop + state machine) — the policy that ties roles,
   the mechanical gate, retries, and termination together.

The engine has no UI dependency; any front-end (CLI or desktop) is a thin shell
over it.

## Architecture

```
            ┌──────────────────────────────────────────────┐
            │                 Orchestrator                   │
            │  plan-review loop  +  per-task actor-critic    │
            │  loop  +  state machine  +  scheduler          │
            └───┬───────────────┬───────────────┬───────────┘
   decompose /  │      verify   │      review   │   persist / trace
   build / fix  │   (mechanical │   (green-pass │
                │      gate)    │     rubric)   │
        ┌───────▼──────┐  ┌─────▼──────┐  ┌─────▼──────┐  ┌────────────┐
        │   Actor role │  │  Mechanical│  │ Critic role│  │  Store +   │
        │              │  │    gate     │  │            │  │ checkpoints│
        └──────┬───────┘  └────────────┘  └─────┬──────┘  └────────────┘
               │  bound to a runner via config  │
        ┌──────▼─────────────────────────────────▼──────┐
        │                  AgentRunner                    │
        │   CliRunner (subprocess)  │  HttpRunner (API)   │
        └─────────────────────────────────────────────────┘
```

- The orchestrator talks only to **roles**, never to a backend.
- Roles are bound to **runners** by configuration.
- Runners are the only place that touches a provider; they are named by
  mechanism (`CliRunner`, `HttpRunner`), never by product.

## Components

### Domain — task state machine

The lifecycle is a transition table; the machine enforces only legal
transitions, while the loop owns counting and policy.

States:

- `PLANNED` → `BUILDING`
- `BUILDING` → `MECHANICAL_FAILED` | `CRITIC_REVIEWING`
- `MECHANICAL_FAILED` → `BUILDING` (retry) | `NEEDS_HUMAN` (cap)
- `CRITIC_REVIEWING` → `GREEN` | `CHANGES_REQUIRED` | `UNVERIFIED_BY_CRITIC`
  | `NEEDS_HUMAN`
- `CHANGES_REQUIRED` → `BUILDING` (retry) | `NEEDS_HUMAN` (cap)

Terminal states: `GREEN` (verified), `NEEDS_HUMAN`, `UNVERIFIED_BY_CRITIC`
(degraded). `verified` is true **only** for `GREEN`.

### Schemas (validated)

- **Plan / TaskSpec** — goal, tasks; each task has id, title, description,
  acceptance criteria, verification commands, dependencies.
- **Critic review** — verdict + findings; each finding has severity
  (`blocker`/`nit`) and category. Rubric is enforced in code (`normalizeReview`):
  blockers in soft categories are downgraded to nits, and the verdict is derived
  from the findings so it can't contradict them.
- **Task artifact bundle** — the small, redacted package handed to the critic:
  the task spec, the diff, touched files, mechanical-gate output, and the
  verification commands. Deliberately a diff + gate output, not the whole repo.

### Engine utilities

- **Redaction** — ordered rules remove secret-shaped values and strip usernames
  from home paths (POSIX and Windows), plus length-bounded truncation. Applied
  before anything is persisted or sent to the critic.
- **Mechanical gate** — runs verification commands fail-fast via an injectable
  executor; the default executor enforces a hard timeout (SIGKILL) and bounded
  output capture.
- **Critic parser** — extracts JSON from arbitrary model text by scanning all
  balanced objects and preferring the last schema-valid one, so prose or an
  illustrative brace earlier in the output doesn't break parsing.

### Orchestration

- **Per-task loop** — `build → mechanical gate → critic review → (fix?) →
  terminal`, with bounded mechanical-fix attempts and critic-review cycles, and
  failure context fed forward on every retry.
- **Plan-review loop** — `draft → critic review → (revise?) → approved`, bounded
  by a revision cap; proceeds with recorded open items if not approved.
- **Critic acquisition** — handles quota exhaustion (degraded fallback) and the
  retry-once-then-give-up policy for unparseable output, mapping outcomes to:
  green / changes / unavailable / paused / malformed.

### Runners

`AgentRunner` is the single extension point:

```
run(prompt, cwd, system?) -> { text, quotaExhausted?, meta? }
```

- **CliRunner** — drives a headless command-line agent as a subprocess. Profile
  options: command, argv template (`{{prompt}}`/`{{model}}`/`{{system}}`/
  `{{cwd}}` placeholders), prompt-via arg or stdin, env passthrough with
  `${VAR}` expansion, output extraction (whole stdout / last line / JSONL event
  stream / file), quota detection (regex and/or exit codes), timeout, and bounded
  capture. Validated by a strict schema at construction.
- **HttpRunner** (planned) — OpenAI-compatible endpoint via base URL + key +
  model; same interface, so it slots in without engine changes.

A **role-binding layer** (planned) turns a runner plus role prompt templates
into an `Actor`/`Critic`, so a profile + prompts becomes a usable backend.

### Storage and observability (planned)

- A local store persists sessions, tasks, attempts, transitions, and outcomes,
  with a checkpoint on each transition for crash-safe resume.
- A structured event log records every transition and runner call and doubles as
  the usage/cost ledger; a trace view inspects a session end-to-end.

### Parallel execution (planned)

- A scheduler runs dependency-independent tasks concurrently up to a configured
  limit, each in an **isolated workspace** (git worktree) to avoid collisions.
- An integrator merges completed work and runs full verification on the result;
  conflicts are surfaced for resolution.

## Configuration

Validated configuration (env-driven, namespaced) covers: role→runner bindings,
loop caps (plan revisions, review cycles, mechanical-fix attempts), gate toggle,
critic-fallback policy, parallelism, workspace isolation, timeouts, and storage
location. Booleans accept common string spellings; invalid values fail fast.

## Key decisions

- **Verification is part of the loop, grounded in real execution.** The critic
  reasons over actual gate results, never instead of them.
- **The rubric is enforced in code, not just prompts.** This is what guarantees
  convergence and prevents taste-based churn.
- **The scarce reviewer is shielded.** A cheap mechanical pre-gate runs first;
  the critic sees only a small redacted diff; review cycles are capped; quota
  exhaustion degrades visibly instead of crashing.
- **Vendor neutrality is structural.** No product/model name appears in engine
  code; backends are profiles behind one runner interface.
- **The engine is headless.** Front-ends are shells; loop logic lives in one
  place.

## Testing strategy

- Pure units: state machine, rubric normalization, critic parser, redaction.
- Behavioral: full loop scenarios via scriptable mock actor/critic (fix cycles,
  nit-without-loop, cap exhaustion, quota fallback, malformed-twice).
- Real-subprocess: the command-line runner and mechanical-gate executor are
  validated against actual processes (timeout, bounded capture, output modes,
  quota detection).

## Directory structure

```
src/
  domain/      state machine
  schemas/     plan, critic (rubric), artifact bundle
  engine/      redaction, mechanical gate, critic parser, loop
  adapters/    role interfaces + mocks
  runners/     AgentRunner interface, CliRunner (+ HttpRunner planned)
  config.ts    validated configuration
test/          unit, behavioral, and real-subprocess suites
```
