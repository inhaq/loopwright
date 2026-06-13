import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TaskState } from "../domain/stateMachine.js";
import type { TaskOutcome } from "../engine/loop.js";

/**
 * Persistence for a run (Task 16): sessions, tasks, attempts, transitions, and
 * outcomes. The store is the substrate for crash-safe checkpoint/resume
 * (Task 17) and the session trace (Milestone 5).
 *
 * Two implementations share one in-memory model via `BaseStore`:
 *   - MemoryStore   ephemeral (tests, dry runs)
 *   - JsonFileStore durable; rewrites a single JSON file atomically (temp +
 *     rename) after each mutation, serialized so concurrent transitions from
 *     parallel tasks can't interleave a half-written file.
 *
 * Dependency-free on purpose: no native SQLite build step, and the whole run
 * state stays small (a diff + gate output per task, not the repo).
 */

export type SessionStatus = "running" | "completed" | "needs_human" | "failed";

export interface SessionRecord {
  id: string;
  goal: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  /** plan-review outcome summary, filled once planning completes */
  planApproved?: boolean;
  planRevisions?: number;
}

export interface TaskRecord {
  sessionId: string;
  taskId: string;
  state: TaskState;
  /** true ONLY for a verified GREEN (mirrors TaskOutcome.verified) */
  verified: boolean;
  updatedAt: string;
  degradedReason?: string;
}

export interface TransitionRecord {
  seq: number;
  sessionId: string;
  taskId: string;
  from: TaskState;
  event: string;
  to: TaskState;
  reason: string;
  at: string;
}

export interface AttemptRecord {
  seq: number;
  sessionId: string;
  taskId: string;
  /** 1-based build attempt number */
  attempt: number;
  kind: "build";
  summary: string;
  at: string;
}

export interface OutcomeRecord {
  sessionId: string;
  taskId: string;
  finalState: TaskState;
  verified: boolean;
  at: string;
  /** the full outcome, kept for trace + resume */
  outcome: TaskOutcome;
}

export interface Store {
  createSession(rec: SessionRecord): Promise<void>;
  updateSession(id: string, patch: Partial<Omit<SessionRecord, "id">>): Promise<void>;
  getSession(id: string): Promise<SessionRecord | undefined>;
  listSessions(): Promise<SessionRecord[]>;

  /** Records a transition AND upserts the task's current state in one step. */
  recordTransition(rec: Omit<TransitionRecord, "seq">): Promise<void>;
  recordAttempt(rec: Omit<AttemptRecord, "seq">): Promise<void>;
  recordOutcome(rec: OutcomeRecord): Promise<void>;

  getTask(sessionId: string, taskId: string): Promise<TaskRecord | undefined>;
  listTasks(sessionId: string): Promise<TaskRecord[]>;
  getOutcome(sessionId: string, taskId: string): Promise<OutcomeRecord | undefined>;
  listTransitions(sessionId: string): Promise<TransitionRecord[]>;
  listAttempts(sessionId: string): Promise<AttemptRecord[]>;
}

interface Db {
  version: 1;
  seq: number;
  sessions: Record<string, SessionRecord>;
  tasks: Record<string, TaskRecord>; // key: `${sessionId}\u0000${taskId}`
  outcomes: Record<string, OutcomeRecord>; // key: `${sessionId}\u0000${taskId}`
  transitions: TransitionRecord[];
  attempts: AttemptRecord[];
}

function emptyDb(): Db {
  return { version: 1, seq: 0, sessions: {}, tasks: {}, outcomes: {}, transitions: [], attempts: [] };
}

const key = (sessionId: string, taskId: string): string => `${sessionId}\u0000${taskId}`;

/** Shared in-memory operations; subclasses decide whether/how to persist. */
abstract class BaseStore implements Store {
  protected db: Db;

  constructor(db: Db = emptyDb()) {
    this.db = db;
  }

  /** Called after every mutation. No-op in memory; writes to disk in JSON. */
  protected abstract persist(): Promise<void>;

  async createSession(rec: SessionRecord): Promise<void> {
    this.db.sessions[rec.id] = { ...rec };
    await this.persist();
  }

  async updateSession(id: string, patch: Partial<Omit<SessionRecord, "id">>): Promise<void> {
    const existing = this.db.sessions[id];
    if (!existing) return;
    this.db.sessions[id] = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    await this.persist();
  }

  async getSession(id: string): Promise<SessionRecord | undefined> {
    const s = this.db.sessions[id];
    return s ? { ...s } : undefined;
  }

  async listSessions(): Promise<SessionRecord[]> {
    return Object.values(this.db.sessions).map((s) => ({ ...s }));
  }

  async recordTransition(rec: Omit<TransitionRecord, "seq">): Promise<void> {
    const seq = ++this.db.seq;
    this.db.transitions.push({ ...rec, seq });
    // keep the task's current state in lockstep with its latest transition
    this.db.tasks[key(rec.sessionId, rec.taskId)] = {
      sessionId: rec.sessionId,
      taskId: rec.taskId,
      state: rec.to,
      verified: rec.to === "GREEN",
      updatedAt: rec.at,
    };
    await this.persist();
  }

  async recordAttempt(rec: Omit<AttemptRecord, "seq">): Promise<void> {
    const seq = ++this.db.seq;
    this.db.attempts.push({ ...rec, seq });
    await this.persist();
  }

  async recordOutcome(rec: OutcomeRecord): Promise<void> {
    this.db.outcomes[key(rec.sessionId, rec.taskId)] = structuredClone(rec);
    // ensure the task record reflects the terminal state + degraded reason
    this.db.tasks[key(rec.sessionId, rec.taskId)] = {
      sessionId: rec.sessionId,
      taskId: rec.taskId,
      state: rec.finalState,
      verified: rec.verified,
      updatedAt: rec.at,
      ...(rec.outcome.degradedReason ? { degradedReason: rec.outcome.degradedReason } : {}),
    };
    await this.persist();
  }

  async getTask(sessionId: string, taskId: string): Promise<TaskRecord | undefined> {
    const t = this.db.tasks[key(sessionId, taskId)];
    return t ? { ...t } : undefined;
  }

  async listTasks(sessionId: string): Promise<TaskRecord[]> {
    return Object.values(this.db.tasks)
      .filter((t) => t.sessionId === sessionId)
      .map((t) => ({ ...t }));
  }

  async getOutcome(sessionId: string, taskId: string): Promise<OutcomeRecord | undefined> {
    const o = this.db.outcomes[key(sessionId, taskId)];
    return o ? structuredClone(o) : undefined;
  }

  async listTransitions(sessionId: string): Promise<TransitionRecord[]> {
    return this.db.transitions.filter((t) => t.sessionId === sessionId).map((t) => ({ ...t }));
  }

  async listAttempts(sessionId: string): Promise<AttemptRecord[]> {
    return this.db.attempts.filter((a) => a.sessionId === sessionId).map((a) => ({ ...a }));
  }
}

/** Ephemeral store; nothing survives the process. */
export class MemoryStore extends BaseStore {
  protected async persist(): Promise<void> {
    /* nothing to persist */
  }
}

/**
 * Durable JSON-file store. Writes are serialized through a promise chain and
 * land atomically (write temp, then rename) so a crash mid-write can't corrupt
 * the file or leave a parallel run's transition half-applied.
 */
export class JsonFileStore extends BaseStore {
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(
    private readonly filePath: string,
    db: Db,
  ) {
    super(db);
  }

  /** Opens (or initializes) the store at `filePath`, loading any existing data. */
  static async open(filePath: string): Promise<JsonFileStore> {
    let db = emptyDb();
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<Db>;
      db = { ...emptyDb(), ...parsed } as Db;
    } catch {
      // missing or unreadable file -> start fresh (parent dir created on write)
    }
    return new JsonFileStore(filePath, db);
  }

  protected persist(): Promise<void> {
    const snapshot = JSON.stringify(this.db);
    const tmp = `${this.filePath}.tmp`;
    // Chain writes so parallel mutations can't interleave a half-written file.
    // Crucially, recover from a prior failure first: without this, a single
    // failed write (e.g. ENOSPC) would leave writeChain permanently rejected
    // and every later persist() would short-circuit, silently dropping all
    // future checkpoints. We swallow only the *previous* error here; this
    // call's own result is still surfaced to its caller.
    const result = this.writeChain.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(tmp, snapshot, "utf8");
      await rename(tmp, this.filePath);
    });
    this.writeChain = result;
    return result;
  }
}

/**
 * Picks a store from configuration: an in-memory store when `dbPath` is empty
 * or ":memory:", otherwise a JSON-file store at that path.
 */
export async function openStore(dbPath: string): Promise<Store> {
  if (dbPath === "" || dbPath === ":memory:") return new MemoryStore();
  return JsonFileStore.open(dbPath);
}
