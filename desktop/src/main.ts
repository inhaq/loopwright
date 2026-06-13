import "./styles.css";
import {
  apiBase,
  deleteSecret,
  getTrace,
  health,
  isTauri,
  listSecretKeys,
  listSessions,
  openStream,
  restartEngine,
  setSecret,
  startRun,
} from "./api.js";
import type { RunMessage, SessionRecord, TraceResponse } from "./types.js";

const view = document.getElementById("view") as HTMLElement;
const engineStatus = document.getElementById("engine-status") as HTMLElement;

// --- tiny DOM helpers -------------------------------------------------------

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

function badge(state: string): HTMLElement {
  return h("span", { class: `badge state-${state}` }, [state]);
}

/** Valid POSIX-ish environment variable name (used for secret keys). */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// --- navigation -------------------------------------------------------------

type Nav = "start" | "sessions" | "secrets";
let teardown: (() => void) | null = null;

function navigate(nav: Nav, arg?: string): void {
  if (teardown) {
    teardown();
    teardown = null;
  }
  document.querySelectorAll("nav button").forEach((b) => {
    b.classList.toggle("active", (b as HTMLElement).dataset.nav === nav);
  });
  view.innerHTML = "";
  if (nav === "start") renderStart();
  else if (nav === "sessions") renderSessions();
  else if (nav === "secrets") renderSecrets();
  void arg;
}

document.querySelectorAll("nav button").forEach((b) => {
  b.addEventListener("click", () => navigate((b as HTMLElement).dataset.nav as Nav));
});

// --- Start view -------------------------------------------------------------

const SAMPLE_RUNNERS = JSON.stringify(
  [
    {
      id: "primary",
      kind: "http",
      model: "gpt-4o-mini",
      options: { baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" },
    },
  ],
  null,
  2,
);

function renderStart(): void {
  const form = h("form", { class: "card form" });
  form.innerHTML = `
    <h2>Start a run</h2>
    <label>Goal
      <textarea name="goal" rows="3" placeholder="e.g. Add a /healthz endpoint with a test" required></textarea>
    </label>
    <label>Runner profiles (JSON)
      <textarea name="runners" rows="8" spellcheck="false"></textarea>
      <small>Maps to <code>LOOPWRIGHT_RUNNERS</code>. API keys are referenced by env var name (<code>apiKeyEnv</code>) and resolved from secure storage.</small>
    </label>
    <div class="row">
      <label>Actor runner id<input name="actor" value="primary" /></label>
      <label>Critic runner id<input name="critic" value="primary" /></label>
    </div>
    <div class="row">
      <label>Max parallel<input name="maxParallel" type="number" min="1" value="2" /></label>
      <label class="check"><input name="worktrees" type="checkbox" /> Use git worktrees</label>
      <label class="check"><input name="gate" type="checkbox" checked /> Mechanical gate</label>
    </div>
    <div class="actions">
      <button type="submit" class="primary">Start run</button>
      <span class="hint" id="start-hint"></span>
    </div>
  `;
  (form.querySelector("[name=runners]") as HTMLTextAreaElement).value = SAMPLE_RUNNERS;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const hint = form.querySelector("#start-hint") as HTMLElement;
    const data = new FormData(form);
    const goal = String(data.get("goal") ?? "").trim();
    if (!goal) return;

    const env: Record<string, string> = {
      LOOPWRIGHT_RUNNERS: String(data.get("runners") ?? "").trim(),
      LOOPWRIGHT_ACTOR_RUNNER: String(data.get("actor") ?? "").trim(),
      LOOPWRIGHT_CRITIC_RUNNER: String(data.get("critic") ?? "").trim(),
      LOOPWRIGHT_MAX_PARALLEL: String(data.get("maxParallel") ?? "2"),
      LOOPWRIGHT_USE_WORKTREES: data.get("worktrees") ? "true" : "false",
      LOOPWRIGHT_MECHANICAL_GATE: data.get("gate") ? "true" : "false",
    };

    try {
      // Validate JSON early so the user gets a clear message, not a 400.
      if (env.LOOPWRIGHT_RUNNERS) JSON.parse(env.LOOPWRIGHT_RUNNERS);
    } catch (err) {
      hint.textContent = `Runner profiles must be valid JSON: ${(err as Error).message}`;
      hint.classList.add("error");
      return;
    }

    hint.textContent = "Starting…";
    hint.classList.remove("error");
    try {
      const sessionId = await startRun({ goal, env });
      renderMonitor(sessionId, goal);
    } catch (err) {
      hint.textContent = `Failed to start: ${(err as Error).message}`;
      hint.classList.add("error");
    }
  });

  view.append(form);
}

// --- Monitor view -----------------------------------------------------------

function renderMonitor(sessionId: string, goal: string): void {
  document.querySelectorAll("nav button").forEach((b) => b.classList.remove("active"));
  view.innerHTML = "";

  const header = h("div", { class: "card" });
  header.innerHTML = `
    <h2>Live run</h2>
    <div class="goal">${escapeHtml(goal)}</div>
    <div class="session-id">session ${escapeHtml(sessionId)}</div>
    <div id="phase" class="phase running">running…</div>
    <div id="plan" class="plan"></div>
  `;

  const usage = h("div", { class: "card usage" });
  usage.innerHTML = `<h3>Usage</h3><div id="usage-body" class="usage-body">no runner calls yet</div>`;

  const tasksCard = h("div", { class: "card" }, [h("h3", {}, ["Tasks"])]);
  const tasksTable = h("table", { class: "tasks" });
  tasksTable.innerHTML = `<thead><tr><th>Task</th><th>State</th><th>Detail</th></tr></thead><tbody id="task-rows"></tbody>`;
  tasksCard.append(tasksTable);

  const logCard = h("div", { class: "card" }, [h("h3", {}, ["Engine log"])]);
  const log = h("pre", { class: "log", id: "log" });
  logCard.append(log);

  view.append(header, usage, tasksCard, logCard);

  const taskRows = new Map<string, HTMLElement>();
  let actorCalls = 0;
  let criticCalls = 0;
  let totalTokens = 0;

  function taskRow(taskId: string): HTMLElement {
    let row = taskRows.get(taskId);
    if (!row) {
      row = h("tr");
      row.innerHTML = `<td>${escapeHtml(taskId)}</td><td class="st"></td><td class="dt"></td>`;
      (document.getElementById("task-rows") as HTMLElement).append(row);
      taskRows.set(taskId, row);
    }
    return row;
  }

  function appendLog(line: string): void {
    log.textContent += line + "\n";
    log.scrollTop = log.scrollHeight;
  }

  function onMessage(msg: RunMessage): void {
    if (msg.type === "log") {
      appendLog(msg.data.line);
    } else if (msg.type === "transition") {
      const row = taskRow(msg.data.taskId);
      const st = row.querySelector(".st") as HTMLElement;
      st.innerHTML = "";
      st.append(badge(msg.data.to));
      (row.querySelector(".dt") as HTMLElement).textContent = msg.data.reason ?? "";
    } else if (msg.type === "outcome") {
      const row = taskRow(msg.data.taskId);
      const st = row.querySelector(".st") as HTMLElement;
      st.innerHTML = "";
      st.append(badge(msg.data.finalState));
      if (msg.data.degradedReason) {
        (row.querySelector(".dt") as HTMLElement).textContent = msg.data.degradedReason;
      }
    } else if (msg.type === "event") {
      const ev = msg.data;
      if (ev.type === "runner_call") {
        if (ev.data.role === "actor") actorCalls++;
        else if (ev.data.role === "critic") criticCalls++;
        totalTokens += Number(ev.data?.usage?.totalTokens ?? 0);
        (document.getElementById("usage-body") as HTMLElement).textContent =
          `actor ${actorCalls} calls · critic ${criticCalls} calls · ${totalTokens} tokens`;
      } else if (ev.type === "plan_reviewed") {
        (document.getElementById("plan") as HTMLElement).textContent =
          `plan: approved=${ev.data.approved} · revisions=${ev.data.revisions} · open items=${ev.data.openItems}`;
      }
    } else if (msg.type === "status") {
      const phase = document.getElementById("phase") as HTMLElement;
      if (msg.data.phase === "done") {
        phase.className = "phase done";
        phase.textContent = "completed";
        const btn = h("button", { class: "primary" }, ["View results"]);
        btn.addEventListener("click", () => renderResults(sessionId));
        phase.append(" ", btn);
      } else if (msg.data.phase === "error") {
        phase.className = "phase error";
        phase.textContent = `error: ${msg.data.error}`;
      }
    }
  }

  const closePromise = openStream(sessionId, onMessage, () => {
    /* EventSource auto-reconnects with Last-Event-ID; nothing to do here */
  });
  // Register teardown synchronously: if the user navigates away before
  // openStream resolves, this still closes the EventSource once it exists,
  // preventing a leaked connection that dispatches into a stale view.
  teardown = () => {
    void closePromise.then((close) => close());
  };
}

// --- Results view -----------------------------------------------------------

async function renderResults(sessionId: string): Promise<void> {
  document.querySelectorAll("nav button").forEach((b) => b.classList.remove("active"));
  view.innerHTML = "";
  view.append(h("div", { class: "card" }, ["Loading trace…"]));

  let resp: TraceResponse;
  try {
    resp = await getTrace(sessionId);
  } catch (err) {
    view.innerHTML = "";
    view.append(h("div", { class: "card error" }, [`Failed to load trace: ${(err as Error).message}`]));
    return;
  }

  const { trace } = resp;
  view.innerHTML = "";

  const summary = h("div", { class: "card" });
  const s = trace.session;
  const byState = countStates(trace);
  summary.innerHTML = `
    <h2>Results</h2>
    <div class="goal">${escapeHtml(s?.goal ?? "")}</div>
    <div class="session-id">session ${escapeHtml(sessionId)} — ${escapeHtml(s?.status ?? "?")}</div>
    <div class="counts">
      <span class="count green">GREEN ${byState.GREEN}</span>
      <span class="count unverified">UNVERIFIED ${byState.UNVERIFIED_BY_CRITIC}</span>
      <span class="count needs-human">NEEDS_HUMAN ${byState.NEEDS_HUMAN}</span>
    </div>
  `;

  const u = trace.usage;
  const usage = h("div", { class: "card" });
  usage.innerHTML = `
    <h3>Usage</h3>
    <table class="kv">
      <tr><th></th><th>calls</th><th>prompt</th><th>completion</th><th>total</th><th>quota hits</th></tr>
      <tr><td>actor</td><td>${u.perRole.actor.calls}</td><td>${u.perRole.actor.promptTokens}</td><td>${u.perRole.actor.completionTokens}</td><td>${u.perRole.actor.totalTokens}</td><td>${u.perRole.actor.quotaHits}</td></tr>
      <tr><td>critic</td><td>${u.perRole.critic.calls}</td><td>${u.perRole.critic.promptTokens}</td><td>${u.perRole.critic.completionTokens}</td><td>${u.perRole.critic.totalTokens}</td><td>${u.perRole.critic.quotaHits}</td></tr>
      <tr class="total"><td>total</td><td>${u.total.calls}</td><td>${u.total.promptTokens}</td><td>${u.total.completionTokens}</td><td>${u.total.totalTokens}</td><td>${u.total.quotaHits}</td></tr>
    </table>
  `;

  const tasksCard = h("div", { class: "card" }, [h("h3", {}, ["Tasks"])]);
  for (const t of trace.tasks) {
    const block = h("div", { class: "task-block" });
    const head = h("div", { class: "task-head" }, [`${t.taskId} `, badge(t.state)]);
    if (t.degradedReason) head.append(h("span", { class: "degraded" }, [` ${t.degradedReason}`]));
    block.append(head);
    const txs = trace.transitions.filter((x) => x.taskId === t.taskId);
    if (txs.length) {
      const ul = h("ul", { class: "tx" });
      for (const x of txs) ul.append(h("li", {}, [`${x.from} —(${x.event})→ ${x.to}  ${x.reason}`]));
      block.append(ul);
    }
    tasksCard.append(block);
  }

  const raw = h("details", { class: "card" });
  raw.append(h("summary", {}, ["Raw trace (text)"]), h("pre", { class: "log" }, [resp.text]));

  view.append(summary, usage, tasksCard, raw);
}

function countStates(trace: TraceResponse["trace"]): Record<string, number> {
  const counts: Record<string, number> = { GREEN: 0, UNVERIFIED_BY_CRITIC: 0, NEEDS_HUMAN: 0 };
  for (const t of trace.tasks) counts[t.state] = (counts[t.state] ?? 0) + 1;
  return counts;
}

// --- Sessions view ----------------------------------------------------------

async function renderSessions(): Promise<void> {
  view.innerHTML = "";
  const card = h("div", { class: "card" }, [h("h2", {}, ["Sessions"])]);
  view.append(card);
  let sessions: SessionRecord[];
  try {
    sessions = await listSessions();
  } catch (err) {
    card.append(h("div", { class: "error" }, [`Failed to load: ${(err as Error).message}`]));
    return;
  }
  if (!sessions.length) {
    card.append(h("div", { class: "hint" }, ["No runs yet."]));
    return;
  }
  const list = h("ul", { class: "session-list" });
  for (const s of sessions) {
    const li = h("li", {});
    const btn = h("button", { class: "linkish" }, [
      h("span", { class: "s-goal" }, [s.goal]),
      h("span", { class: "s-meta" }, [`${s.status} · ${new Date(s.createdAt).toLocaleString()}`]),
    ]);
    btn.addEventListener("click", () => renderResults(s.id));
    li.append(btn);
    list.append(li);
  }
  card.append(list);
}

// --- Secrets view (Tauri only) ---------------------------------------------

async function renderSecrets(): Promise<void> {
  view.innerHTML = "";
  const card = h("div", { class: "card" }, [h("h2", {}, ["Secrets"])]);
  view.append(card);
  if (!isTauri()) {
    card.append(
      h("div", { class: "hint" }, [
        "Secure secret storage is only available in the desktop app. In a browser, provide API keys via the engine server's environment.",
      ]),
    );
    return;
  }

  card.append(
    h("p", { class: "hint" }, [
      "Stored in the OS keychain and injected into the engine as environment variables. Reference them from runner profiles via apiKeyEnv (e.g. OPENAI_API_KEY).",
    ]),
  );

  const listEl = h("ul", { class: "secret-list" });
  card.append(listEl);

  // Stored secrets are injected into the engine only at (re)start, so changing
  // them requires a restart to take effect. Make that gate explicit rather than
  // silently leaving the running engine on stale values.
  const pending = h("div", { class: "hint pending", hidden: "true" }, [
    "Stored secrets changed — restart the engine to apply.",
  ]);
  const markPending = (): void => {
    pending.hidden = false;
  };

  const formError = h("div", { class: "error", hidden: "true" });

  async function refresh(): Promise<void> {
    listEl.innerHTML = "";
    const keys = await listSecretKeys();
    if (!keys.length) listEl.append(h("li", { class: "hint" }, ["No secrets stored."]));
    for (const k of keys) {
      const del = h("button", { class: "danger small" }, ["Delete"]);
      del.addEventListener("click", async () => {
        await deleteSecret(k);
        await refresh();
        markPending();
      });
      listEl.append(h("li", {}, [h("code", {}, [k]), del]));
    }
  }

  const form = h("form", { class: "row secret-form" });
  form.innerHTML = `
    <label>Key (env var name)<input name="key" placeholder="OPENAI_API_KEY" required /></label>
    <label>Value<input name="value" type="password" required /></label>
    <button type="submit" class="primary">Save</button>
  `;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    formError.hidden = true;
    const data = new FormData(form);
    const key = String(data.get("key") ?? "").trim();
    // The key becomes an env var injected into the engine; reject invalid names
    // (and the reserved LOOPWRIGHT_ prefix) before persisting.
    if (!ENV_KEY_RE.test(key) || key.startsWith("LOOPWRIGHT_")) {
      formError.textContent =
        "Key must be a valid env var name and must not start with LOOPWRIGHT_ (e.g. OPENAI_API_KEY).";
      formError.hidden = false;
      return;
    }
    try {
      await setSecret(key, String(data.get("value") ?? ""));
    } catch (err) {
      formError.textContent = `Failed to save: ${(err as Error).message}`;
      formError.hidden = false;
      return;
    }
    form.reset();
    await refresh();
    markPending();
  });
  card.append(form, formError);

  const restart = h("button", {}, ["Restart engine to apply secret changes"]);
  restart.addEventListener("click", async () => {
    restart.textContent = "Restarting…";
    restart.setAttribute("disabled", "true");
    try {
      await restartEngine();
      pending.hidden = true;
      await checkEngine();
    } catch (err) {
      formError.textContent = `Restart failed: ${(err as Error).message}`;
      formError.hidden = false;
    } finally {
      restart.textContent = "Restart engine to apply secret changes";
      restart.removeAttribute("disabled");
    }
  });
  card.append(h("div", { class: "actions" }, [restart, pending]));

  await refresh();
}

// --- engine status ----------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

async function checkEngine(): Promise<void> {
  const ok = await health();
  engineStatus.textContent = ok ? "engine: connected" : "engine: offline";
  engineStatus.className = `engine-status ${ok ? "ok" : "down"}`;
}

async function boot(): Promise<void> {
  if (isTauri()) (document.getElementById("nav-secrets") as HTMLElement).hidden = false;
  await apiBase();
  await checkEngine();
  setInterval(checkEngine, 10_000);
  navigate("start");
}

void boot();
