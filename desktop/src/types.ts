// Shapes mirrored from the engine server (src/server) and observability layer.
// Kept intentionally loose where the engine payloads are rich; the UI only
// reads the fields it renders.

export type RunPhase = "running" | "done" | "error";

export interface SessionRecord {
  id: string;
  goal: string;
  createdAt: string;
  updatedAt: string;
  status: "running" | "completed" | "needs_human" | "failed";
  planApproved?: boolean;
  planRevisions?: number;
}

export interface TaskRecord {
  taskId: string;
  state: string;
  verified: boolean;
  updatedAt: string;
  degradedReason?: string;
}

export interface TransitionRecord {
  taskId: string;
  from: string;
  event: string;
  to: string;
  reason: string;
  at: string;
}

export interface RoleUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
  quotaHits: number;
  costUsd?: number;
}

export interface UsageLedger {
  perRole: { actor: RoleUsage; critic: RoleUsage };
  total: RoleUsage;
}

export interface SessionTrace {
  session?: SessionRecord;
  tasks: TaskRecord[];
  transitions: TransitionRecord[];
  attempts: unknown[];
  outcomes: unknown[];
  events: Array<{ type: string; at: string; data: Record<string, unknown> }>;
  usage: UsageLedger;
}

export interface TraceResponse {
  trace: SessionTrace;
  text: string;
  phase: RunPhase | null;
}

/** One SSE message as emitted by the server hub. */
export interface RunMessage {
  id: number;
  type: "status" | "transition" | "attempt" | "outcome" | "event" | "log";
  data: any;
}
