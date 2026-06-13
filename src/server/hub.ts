import { EventEmitter } from "node:events";
import type { SessionResult } from "../session.js";

/**
 * In-process pub/sub for a single server process (Task 25.1).
 *
 * The engine is headless and emits its progress through `runGoal`'s observer
 * hooks (transitions, attempts, outcomes) and the store's event stream
 * (lifecycle + runner calls). The hub fans those into a per-session channel the
 * SSE endpoint can subscribe to, and keeps an ordered in-memory buffer so a
 * client that connects late — or reconnects with `Last-Event-ID` — still
 * receives every message from the start of the run. No orchestration policy
 * lives here; it is a pure transport adapter over the existing engine events.
 */

/** Discriminator for everything that crosses the wire to a monitoring client. */
export type RunMessageType =
  | "status" // lifecycle: running | done | error (see RunStatusData)
  | "transition" // a task state transition
  | "attempt" // a build attempt completed
  | "outcome" // a task reached a terminal outcome
  | "event" // a store event: plan_reviewed | runner_call | ...
  | "log"; // a human-readable log line from the engine

export interface RunMessage {
  /** 0-based index within the session, used as the SSE event id for resume. */
  id: number;
  type: RunMessageType;
  data: unknown;
}

export type RunPhase = "running" | "done" | "error";

export interface RunStatusData {
  phase: RunPhase;
  /** present when phase === "done" */
  result?: SessionResult;
  /** present when phase === "error" */
  error?: string;
}

type Listener = (msg: RunMessage) => void;

interface Channel {
  buffer: RunMessage[];
  emitter: EventEmitter;
  phase: RunPhase;
}

const MESSAGE_EVENT = "message";

export class RunHub {
  private readonly channels = new Map<string, Channel>();

  private channel(sessionId: string): Channel {
    let ch = this.channels.get(sessionId);
    if (!ch) {
      const emitter = new EventEmitter();
      // Each SSE client adds a listener; a long run with several open monitor
      // tabs would otherwise trip Node's default 10-listener leak warning.
      emitter.setMaxListeners(0);
      ch = { buffer: [], emitter, phase: "running" };
      this.channels.set(sessionId, ch);
    }
    return ch;
  }

  /** True once a run for this session has been registered (started). */
  has(sessionId: string): boolean {
    return this.channels.has(sessionId);
  }

  phase(sessionId: string): RunPhase | undefined {
    return this.channels.get(sessionId)?.phase;
  }

  /** Publishes a message to a session, assigning it the next ordinal id. */
  publish(sessionId: string, type: RunMessageType, data: unknown): RunMessage {
    const ch = this.channel(sessionId);
    const msg: RunMessage = { id: ch.buffer.length, type, data };
    ch.buffer.push(msg);
    if (type === "status") {
      const phase = (data as RunStatusData).phase;
      if (phase) ch.phase = phase;
    }
    ch.emitter.emit(MESSAGE_EVENT, msg);
    return msg;
  }

  /**
   * Subscribes to a session. Every buffered message with id > `afterId` is
   * replayed immediately (in order), then live messages stream until the
   * returned unsubscribe function is called. `afterId` of -1 (the default)
   * replays the whole history, matching a fresh client; a reconnecting client
   * passes its last seen id so it does not re-process what it already has.
   *
   * Subscribing to an unknown session does NOT create a channel — that would
   * let a stray monitor connection reserve a session id and make a later
   * `POST /api/runs` for it spuriously report "already running". Callers should
   * gate on {@link has} first; for safety this returns a no-op unsubscribe.
   */
  subscribe(sessionId: string, listener: Listener, afterId = -1): () => void {
    const ch = this.channels.get(sessionId);
    if (!ch) return () => {};
    for (const msg of ch.buffer) {
      if (msg.id > afterId) listener(msg);
    }
    ch.emitter.on(MESSAGE_EVENT, listener);
    return () => ch.emitter.off(MESSAGE_EVENT, listener);
  }

  /** Drops a finished session's buffer to bound memory (optional cleanup). */
  forget(sessionId: string): void {
    const ch = this.channels.get(sessionId);
    if (ch) ch.emitter.removeAllListeners();
    this.channels.delete(sessionId);
  }
}
