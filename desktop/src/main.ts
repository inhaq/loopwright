import "./styles.css";
import {
  apiBase,
  activeRunCount,
  cancelRun,
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
import {
  MODEL_CATALOG,
  buildRunEnv,
  findModel,
  loadSettings,
  modelLabel,
  saveSettings,
  type ModelChoice,
} from "./settings.js";
import type { RunMessage, SessionRecord, TraceResponse } from "./types.js";

const view = document.getElementById("view") as HTMLElement;
const engineStatus = document.getElementById("engine-status") as HTMLElement;
const engineLabel = engineStatus.querySelector(".engine-label") as HTMLElement;

// --- tiny DOM helpers -------------------------------------------------------

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

function badge(state: string): HTMLElement {
  return h("span", { class: `badge state-${state}` }, [state]);
}

/** Inline SVG icon as an element (24x24 viewBox, stroke-based). */
function icon(path: string, cls = ""): HTMLElement {
  const span = h("span", cls ? { class: cls } : {});
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  return span;
}

const ICONS = {
  plan: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  loop: '<path d="M17 2.1a9 9 0 1 0 4.9 9.4"/><path d="M21 3v5h-5"/>',
  verify: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4 12 14.01l-3-3"/>',
  rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  key: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  arrow: '<path d="M9 18l6-6-6-6"/>',
  caret: '<path d="M9 18l6-6-6-6"/>',
  repo: '<path d="M3 3h12a2 2 0 0 1 2 2v16l-8-4-8 4V5a2 2 0 0 1 2-2z" transform="translate(2 0)"/>',
  write: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  review: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
};

/** Valid POSIX-ish environment variable name (used for secret keys). */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// --- navigation -------------------------------------------------------------

type Nav = "start" | "sessions" | "models" | "secrets";
let teardown: (() => void) | null = null;

function navigate(nav: Nav, arg?: string): void {
  if (teardown) {
    teardown();
    teardown = null;
  }
  document.querySelectorAll(".nav-item").forEach((b) => {
    b.classList.toggle("active", (b as HTMLElement).dataset.nav === nav);
  });
  view.innerHTML = "";
  view.scrollTop = 0;
  if (nav === "start") renderStart();
  else if (nav === "sessions") renderSessions();
  else if (nav === "models") renderModels();
  else if (nav === "secrets") renderSecrets();
  void arg;
}

document.querySelectorAll(".nav-item").forEach((b) => {
  b.addEventListener("click", () => navigate((b as HTMLElement).dataset.nav as Nav));
});

function clearNavActive(): void {
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
}

// --- Start view -------------------------------------------------------------

const EXAMPLE_GOALS = [
  "Add a /healthz endpoint with a test",
  "Fix the failing auth middleware tests",
  "Add input validation to the signup form",
  "Refactor the config loader to use zod",
];

function renderStart(): void {
  const settings = loadSettings();
  const page = h("section", { class: "page page-run" });

  page.append(
    h("div", { class: "page-head" }, [
      h("div", { class: "eyebrow" }, ["Actor – Critic loop"]),
      h("h1", {}, ["Start a new run"]),
    ]),
  );

  const form = h("form", { class: "card run-box" });

  // -- Top row: "Goal" label on the left, selected repo on the right.
  const repoPill = h("button", { type: "button", class: "repo-pill", title: "Change in Model settings" }, [
    icon(ICONS.repo),
    h("span", {}, [settings.repo.trim() || "No repository selected"]),
  ]);
  repoPill.classList.toggle("unset", !settings.repo.trim());
  repoPill.addEventListener("click", () => navigate("models"));

  const topRow = h("div", { class: "run-box-top" }, [
    h("label", { class: "label", for: "start-goal" }, ["Goal"]),
    repoPill,
  ]);

  // -- Goal input + example chips
  const goalArea = h("textarea", {
    id: "start-goal",
    name: "goal",
    rows: "4",
    placeholder: "e.g. Add a /healthz endpoint that returns 200 and write a test for it",
    required: "true",
  }) as HTMLTextAreaElement;

  const chips = h("div", { class: "chips" });
  for (const ex of EXAMPLE_GOALS) {
    const chip = h("button", { type: "button", class: "chip" }, [ex]);
    chip.addEventListener("click", () => {
      goalArea.value = ex;
      goalArea.focus();
    });
    chips.append(chip);
  }

  // -- Bottom row: run button on the left, the two models in use on the right.
  const submit = h("button", { type: "submit", class: "primary" }, [icon(ICONS.rocket), "Start run"]);

  const models = h("button", { type: "button", class: "run-models", title: "Change in Model settings" }, [
    h("span", { class: "run-model" }, [icon(ICONS.write, "rm-ico"), h("span", { class: "rm-role" }, ["Writes"]), h("span", { class: "rm-name" }, [modelLabel(settings.writer)])]),
    h("span", { class: "run-model" }, [icon(ICONS.review, "rm-ico"), h("span", { class: "rm-role" }, ["Reviews"]), h("span", { class: "rm-name" }, [modelLabel(settings.reviewer)])]),
  ]);
  models.addEventListener("click", () => navigate("models"));

  const bottomRow = h("div", { class: "run-box-bottom" }, [submit, models]);

  const hint = h("span", { class: "hint", id: "start-hint" });

  form.append(topRow, goalArea, chips, bottomRow, hint);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const goal = goalArea.value.trim();
    if (!goal) {
      goalArea.focus();
      return;
    }

    hint.textContent = "Starting…";
    hint.className = "hint";
    submit.setAttribute("disabled", "true");
    try {
      const sessionId = await startRun({ goal, env: buildRunEnv(settings) });
      renderMonitor(sessionId, goal);
    } catch (err) {
      submit.removeAttribute("disabled");
      hint.textContent = `Failed to start: ${(err as Error).message}`;
      hint.className = "hint error";
    }
  });

  page.append(form);
  view.append(page);
}

// --- Model settings view ----------------------------------------------------

async function renderModels(): Promise<void> {
  const settings = loadSettings();
  const page = h("section", { class: "page" });
  page.append(
    h("div", { class: "page-head" }, [
      h("h1", {}, ["Model settings"]),
      h("p", { class: "page-sub" }, [
        "Choose which model writes the code and which reviews it, pick the repository to work in, and tune how runs execute. These apply to every new run.",
      ]),
    ]),
  );
  view.append(page);

  // Which provider keys are stored locally (Tauri keychain). In the browser we
  // can't see them — keys live in the engine's environment — so we don't gate.
  let storedKeys = new Set<string>();
  let knowKeys = false;
  if (isTauri()) {
    try {
      storedKeys = new Set(await listSecretKeys());
      knowKeys = true;
    } catch {
      /* fall back to "unknown" — show everything as selectable */
    }
  }

  const persist = (): void => saveSettings(settings);

  /**
   * Builds a grouped <select> of every catalog model. Models whose API key
   * isn't stored are still listed but flagged, so the choice is informed.
   */
  function modelSelect(role: "writer" | "reviewer", onChange: () => void): HTMLSelectElement {
    const current = settings[role];
    const select = h("select", { "aria-label": `${role} model` }) as HTMLSelectElement;
    for (const provider of MODEL_CATALOG) {
      const missing = knowKeys && !storedKeys.has(provider.apiKeyEnv);
      const group = h("optgroup", { label: missing ? `${provider.label} (add ${provider.apiKeyEnv})` : provider.label }) as HTMLOptGroupElement;
      for (const m of provider.models) {
        const value = `${provider.id}::${m.id}`;
        const opt = h("option", { value }, [m.label]) as HTMLOptionElement;
        if (current.provider === provider.id && current.model === m.id) opt.selected = true;
        group.append(opt);
      }
      select.append(group);
    }
    select.addEventListener("change", () => {
      const [provider, model] = select.value.split("::");
      settings[role] = { provider: provider!, model: model! } as ModelChoice;
      persist();
      onChange();
    });
    return select;
  }

  // -- Repository
  const repoInput = h("input", {
    type: "text",
    value: settings.repo,
    placeholder: "e.g. acme/web-app",
    "aria-label": "Repository",
  }) as HTMLInputElement;
  repoInput.addEventListener("input", () => {
    settings.repo = repoInput.value;
    persist();
  });
  const repoCard = h("div", { class: "card" }, [
    h("h3", {}, ["Repository"]),
    h("div", { class: "field" }, [
      h("div", { class: "desc" }, ["The repository this run works in. Shown on the New run box so you always know where the agents are operating."]),
      repoInput,
    ]),
  ]);

  // -- Models (writer + reviewer)
  const writerNote = h("div", { class: "model-note" });
  const reviewerNote = h("div", { class: "model-note" });

  function keyHint(choice: ModelChoice): HTMLElement {
    const found = findModel(choice);
    const note = h("div", { class: "model-note" });
    if (!found) return note;
    if (knowKeys && !storedKeys.has(found.provider.apiKeyEnv)) {
      note.classList.add("warn");
      const link = h("button", { type: "button", class: "linklike" }, [`Add ${found.provider.apiKeyEnv}`]);
      link.addEventListener("click", () => navigate("secrets"));
      note.append(h("span", {}, [`No key stored for ${found.provider.label}. `]), link);
    } else {
      note.append(h("span", {}, [`Uses ${found.provider.apiKeyEnv} · ${found.model.id}`]));
    }
    return note;
  }

  const writerSelect = modelSelect("writer", () => {
    refreshNote(writerNote, settings.writer);
  });
  const reviewerSelect = modelSelect("reviewer", () => {
    refreshNote(reviewerNote, settings.reviewer);
  });

  function refreshNote(target: HTMLElement, choice: ModelChoice): void {
    const fresh = keyHint(choice);
    target.className = fresh.className;
    target.innerHTML = fresh.innerHTML;
    // Re-bind the "Add key" button if present (innerHTML drops listeners).
    const btn = target.querySelector("button.linklike");
    if (btn) btn.addEventListener("click", () => navigate("secrets"));
  }
  refreshNote(writerNote, settings.writer);
  refreshNote(reviewerNote, settings.reviewer);

  const modelsCard = h("div", { class: "card" }, [
    h("h3", {}, ["Models"]),
    h("div", { class: "model-grid" }, [
      h("div", { class: "model-pick" }, [
        h("label", { class: "model-pick-head" }, [icon(ICONS.write, "mp-ico"), "Writer", h("span", { class: "desc" }, ["Writes the code"])]),
        writerSelect,
        writerNote,
      ]),
      h("div", { class: "model-pick" }, [
        h("label", { class: "model-pick-head" }, [icon(ICONS.review, "mp-ico"), "Reviewer", h("span", { class: "desc" }, ["Reviews the code"])]),
        reviewerSelect,
        reviewerNote,
      ]),
    ]),
    h("div", { class: "desc keys-hint" }, [
      isTauri()
        ? "Models are unlocked by the API keys you store under Secrets."
        : "Models are unlocked by the API keys provided in the engine's environment.",
    ]),
  ]);

  // -- Run options
  const optionsCard = h("div", { class: "card" }, [h("h3", {}, ["Run options"])]);
  const options = h("div", { class: "options" });

  const parallelInput = h("input", { type: "number", min: "1", value: String(settings.maxParallel), "aria-label": "Max parallel tasks" }) as HTMLInputElement;
  const dec = h("button", { type: "button", "aria-label": "decrease" }, [icon("<path d='M5 12h14'/>")]);
  const inc = h("button", { type: "button", "aria-label": "increase" }, [icon("<path d='M12 5v14'/><path d='M5 12h14'/>")]);
  const commitParallel = (): void => {
    settings.maxParallel = Math.max(1, Number(parallelInput.value || "1"));
    parallelInput.value = String(settings.maxParallel);
    persist();
  };
  dec.addEventListener("click", () => { parallelInput.value = String(Math.max(1, Number(parallelInput.value || "1") - 1)); commitParallel(); });
  inc.addEventListener("click", () => { parallelInput.value = String(Number(parallelInput.value || "1") + 1); commitParallel(); });
  parallelInput.addEventListener("change", commitParallel);
  const stepper = h("div", { class: "stepper" }, [parallelInput, h("div", { class: "steps-btns" }, [inc, dec])]);

  function optionRow(title: string, desc: string, key: "worktrees" | "mechanicalGate"): HTMLElement {
    const input = h("input", { type: "checkbox", "aria-label": title }) as HTMLInputElement;
    if (settings[key]) input.checked = true;
    input.addEventListener("change", () => {
      settings[key] = input.checked;
      persist();
    });
    return h("div", { class: "option" }, [
      h("div", { class: "option-text" }, [h("strong", {}, [title]), h("span", {}, [desc])]),
      h("label", { class: "switch" }, [input, h("span", { class: "track" })]),
    ]);
  }

  options.append(
    h("div", { class: "option" }, [
      h("div", { class: "option-text" }, [h("strong", {}, ["Max parallel tasks"]), h("span", {}, ["How many tasks run at the same time."])]),
      stepper,
    ]),
    optionRow("Use git worktrees", "Isolate each task in its own worktree so parallel work never collides.", "worktrees"),
    optionRow("Mechanical gate", "Run build / test / lint checks before the critic reviews each change.", "mechanicalGate"),
  );
  optionsCard.append(options);

  page.append(repoCard, modelsCard, optionsCard);
}

// --- Monitor view -----------------------------------------------------------

function renderMonitor(sessionId: string, goal: string): void {
  clearNavActive();
  view.innerHTML = "";
  view.scrollTop = 0;
  const page = h("section", { class: "page" });

  // Run header
  const phase = h("div", { class: "phase running", id: "phase" }, ["running…"]);
  const plan = h("div", { class: "plan", id: "plan" });
  const stopBtn = h("button", { class: "danger small" }, ["Stop run"]);

  const header = h("div", { class: "card run-head" }, [
    h("div", { class: "goal" }, [goal]),
    h("div", { class: "meta-row" }, [phase, stopBtn, h("span", { class: "session-id" }, [`session ${sessionId}`])]),
    plan,
  ]);

  // Stop control: requests cooperative cancellation of the in-flight run.
  stopBtn.addEventListener("click", async () => {
    stopBtn.setAttribute("disabled", "true");
    stopBtn.textContent = "Stopping…";
    try {
      await cancelRun(sessionId);
    } catch (err) {
      stopBtn.removeAttribute("disabled");
      stopBtn.textContent = "Stop run";
      plan.textContent = `Cancel failed: ${(err as Error).message}`;
    }
  });

  const usage = h("div", { class: "card" }, [
    h("h3", {}, ["Usage"]),
    h("div", { class: "usage-body", id: "usage-body" }, ["No runner calls yet."]),
  ]);

  const tasksCard = h("div", { class: "card" }, [h("h3", {}, ["Tasks"])]);
  const tasksTable = h("table", { class: "tasks" });
  tasksTable.innerHTML = `<thead><tr><th>Task</th><th>State</th><th>Detail</th></tr></thead><tbody id="task-rows"></tbody>`;
  tasksCard.append(tasksTable);

  const logCard = h("div", { class: "card" }, [h("h3", {}, ["Engine log"])]);
  const log = h("pre", { class: "log", id: "log" });
  logCard.append(log);

  page.append(header, usage, tasksCard, logCard);
  view.append(page);

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
          `actor ${actorCalls} calls · critic ${criticCalls} calls · ${totalTokens.toLocaleString()} tokens`;
      } else if (ev.type === "plan_reviewed") {
        (document.getElementById("plan") as HTMLElement).textContent =
          `Plan: approved=${ev.data.approved} · revisions=${ev.data.revisions} · open items=${ev.data.openItems}`;
      }
    } else if (msg.type === "status") {
      const phaseEl = document.getElementById("phase") as HTMLElement;
      if (msg.data.phase === "done" || msg.data.phase === "error") {
        stopBtn.remove(); // run is over; no longer cancellable
      }
      if (msg.data.phase === "done") {
        // "done" is not necessarily success: a clean per-task run can still
        // fail to integrate (merge conflicts / failed verification), and some
        // tasks may need a human. Reflect that instead of a blanket "completed".
        const r = msg.data.result ?? {};
        const integrationFailed = r.integration && r.integration.ok === false;
        const needsHuman = Array.isArray(r.needsHuman) && r.needsHuman.length > 0;
        if (integrationFailed) {
          phaseEl.className = "phase error";
          phaseEl.textContent = "Integration failed — needs attention";
        } else if (needsHuman) {
          phaseEl.className = "phase error";
          phaseEl.textContent = "Completed — some tasks need a human";
        } else {
          phaseEl.className = "phase done";
          phaseEl.textContent = "Completed";
        }
        const btn = h("button", { class: "primary small" }, ["View results"]);
        btn.addEventListener("click", () => renderResults(sessionId));
        phaseEl.after(btn);
      } else if (msg.data.phase === "error") {
        phaseEl.className = "phase error";
        phaseEl.textContent = `Error: ${msg.data.error}`;
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
  clearNavActive();
  view.innerHTML = "";
  view.scrollTop = 0;
  const loadingPage = h("section", { class: "page" }, [
    h("div", { class: "card" }, [h("div", { class: "loading" }, [h("span", { class: "spinner" }), "Loading trace…"])]),
  ]);
  view.append(loadingPage);

  let resp: TraceResponse;
  try {
    resp = await getTrace(sessionId);
  } catch (err) {
    view.innerHTML = "";
    view.append(
      h("section", { class: "page" }, [
        h("div", { class: "card error" }, [`Failed to load trace: ${(err as Error).message}`]),
      ]),
    );
    return;
  }

  const { trace } = resp;
  view.innerHTML = "";
  const page = h("section", { class: "page" });

  const s = trace.session;
  const byState = countStates(trace);

  // Header
  const backBtn = h("button", { class: "ghost small" }, [icon("<path d='M19 12H5'/><path d='M12 19l-7-7 7-7'/>"), "All sessions"]);
  backBtn.addEventListener("click", () => navigate("sessions"));

  const counts = h("div", { class: "counts" }, [
    h("span", { class: "count green" }, [h("span", { class: "n" }, [String(byState.GREEN)]), "Green"]),
    h("span", { class: "count unverified" }, [h("span", { class: "n" }, [String(byState.UNVERIFIED_BY_CRITIC)]), "Unverified"]),
    h("span", { class: "count needs-human" }, [h("span", { class: "n" }, [String(byState.NEEDS_HUMAN)]), "Needs human"]),
  ]);

  page.append(
    h("div", { class: "page-head" }, [
      h("div", { class: "head-row" }, [
        h("div", { class: "eyebrow" }, ["Run results"]),
        backBtn,
      ]),
      h("h1", {}, [s?.goal ?? "Results"]),
      h("div", { class: "meta-row" }, [
        h("span", { class: `phase ${statusPhase(s?.status)}` }, [s?.status ?? "?"]),
        h("span", { class: "session-id" }, [`session ${sessionId}`]),
      ]),
    ]),
    counts,
  );

  // Blocking summary cards (shown high up so a merge/verify failure can't be
  // missed behind all-green task counts). Sourced from the durable event log.
  const failedEvent = trace.events.find((e) => e.type === "session_failed");
  if (failedEvent) {
    page.append(
      h("div", { class: "card error" }, [
        h("h3", {}, ["Run failed"]),
        h("div", {}, [String((failedEvent.data as Record<string, unknown>).error ?? "unknown error")]),
      ]),
    );
  }

  const integrationEvent = trace.events.find((e) => e.type === "integration");
  if (integrationEvent) {
    const d = integrationEvent.data as {
      ok?: boolean;
      merged?: unknown[];
      conflicts?: unknown[];
      integrationBranch?: string;
      verification?: { passed?: boolean } | null;
    };
    const ok = d.ok === true;
    const conflicts = Array.isArray(d.conflicts) ? d.conflicts : [];
    const merged = Array.isArray(d.merged) ? d.merged.length : 0;
    const card = h("div", { class: `card${ok ? "" : " integration-bad"}` });
    card.append(h("h3", {}, ["Integration & verification"]));
    card.append(
      h("div", { class: `phase ${ok ? "done" : "error"}` }, [
        ok ? "Branches merged and full verification passed" : "Failed — merge conflicts or verification did not pass",
      ]),
    );
    card.append(
      h("div", { class: "hint" }, [
        `branch ${String(d.integrationBranch ?? "?")} · merged ${merged} · conflicts ${conflicts.length}`,
      ]),
    );
    if (conflicts.length) {
      const ul = h("ul", { class: "tx" });
      for (const c of conflicts) ul.append(h("li", {}, [typeof c === "string" ? c : JSON.stringify(c)]));
      card.append(h("div", { class: "hint" }, ["Conflicting branches:"]), ul);
    }
    if (d.verification && d.verification.passed === false) {
      card.append(h("div", { class: "error" }, ["Full-tree verification failed after merge."]));
    }
    page.append(card);
  }

  // Usage
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
  page.append(usage);

  // Tasks
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
  page.append(tasksCard);

  // Raw trace
  const raw = h("details", { class: "card" });
  raw.append(h("summary", {}, ["Raw trace (text)"]), h("pre", { class: "log" }, [resp.text]));
  page.append(raw);

  view.append(page);
}

function statusPhase(status?: string): string {
  if (status === "completed") return "done";
  if (status === "failed" || status === "needs_human") return "error";
  return "running";
}

function countStates(trace: TraceResponse["trace"]): Record<string, number> {
  const counts: Record<string, number> = { GREEN: 0, UNVERIFIED_BY_CRITIC: 0, NEEDS_HUMAN: 0 };
  for (const t of trace.tasks) counts[t.state] = (counts[t.state] ?? 0) + 1;
  return counts;
}

// --- Sessions view ----------------------------------------------------------

async function renderSessions(): Promise<void> {
  view.innerHTML = "";
  const page = h("section", { class: "page" });
  page.append(
    h("div", { class: "page-head" }, [
      h("h1", {}, ["Sessions"]),
      h("p", { class: "page-sub" }, ["Every run you've started. Select one to view its trace, usage, and task outcomes."]),
    ]),
  );
  const card = h("div", { class: "card" });
  page.append(card);
  view.append(page);

  card.append(h("div", { class: "loading" }, [h("span", { class: "spinner" }), "Loading sessions…"]));

  let sessions: SessionRecord[];
  try {
    sessions = await listSessions();
  } catch (err) {
    card.innerHTML = "";
    card.append(h("div", { class: "error" }, [`Failed to load: ${(err as Error).message}`]));
    return;
  }

  card.innerHTML = "";
  if (!sessions.length) {
    card.append(
      h("div", { class: "empty" }, [
        icon(ICONS.inbox, "empty-ico"),
        h("h3", {}, ["No runs yet"]),
        h("p", {}, ["Start your first run and it will show up here with its full trace."]),
        (() => {
          const b = h("button", { class: "primary small" }, [icon(ICONS.rocket), "New run"]);
          b.addEventListener("click", () => navigate("start"));
          return b;
        })(),
      ]),
    );
    return;
  }

  const list = h("ul", { class: "session-list" });
  for (const s of sessions) {
    const li = h("li", {});
    const btn = h("button", { class: "linkish" }, [
      h("div", { class: "s-main" }, [
        h("span", { class: "s-goal" }, [s.goal]),
        h("span", { class: "s-meta" }, [`${s.status} · ${new Date(s.createdAt).toLocaleString()}`]),
      ]),
      h("span", { class: `badge state-${stateForStatus(s.status)}` }, [s.status]),
      icon(ICONS.arrow, "s-arrow"),
    ]);
    btn.addEventListener("click", () => renderResults(s.id));
    li.append(btn);
    list.append(li);
  }
  card.append(list);
}

function stateForStatus(status: string): string {
  if (status === "completed") return "GREEN";
  if (status === "failed" || status === "needs_human") return "NEEDS_HUMAN";
  return "PLANNED";
}

// --- Secrets view (Tauri only) ---------------------------------------------

async function renderSecrets(): Promise<void> {
  view.innerHTML = "";
  const page = h("section", { class: "page" });
  page.append(
    h("div", { class: "page-head" }, [
      h("h1", {}, ["Secrets"]),
      h("p", { class: "page-sub" }, [
        "API keys stored in your OS keychain and injected into the engine as environment variables. Reference them from runner profiles via apiKeyEnv (e.g. OPENAI_API_KEY).",
      ]),
    ]),
  );
  view.append(page);

  if (!isTauri()) {
    page.append(
      h("div", { class: "card" }, [
        h("div", { class: "empty" }, [
          icon(ICONS.key, "empty-ico"),
          h("h3", {}, ["Desktop only"]),
          h("p", {}, ["Secure secret storage is only available in the desktop app. In a browser, provide API keys via the engine server's environment."]),
        ]),
      ]),
    );
    return;
  }

  const card = h("div", { class: "card" });
  page.append(card);

  const listEl = h("ul", { class: "secret-list" });
  card.append(h("h3", {}, ["Stored keys"]), listEl);

  // Models-by-key: makes it explicit which models each environment key unlocks,
  // so the user can see exactly what a key buys them before (or after) adding it.
  const catalogCard = h("div", { class: "card" }, [h("h3", {}, ["Models by environment key"])]);
  const catalogList = h("div", { class: "key-catalog" });
  catalogCard.append(catalogList);

  function renderCatalog(stored: Set<string>): void {
    catalogList.innerHTML = "";
    for (const provider of MODEL_CATALOG) {
      const has = stored.has(provider.apiKeyEnv);
      const head = h("div", { class: "key-cat-head" }, [
        icon(ICONS.key, "key-cat-ico"),
        h("code", {}, [provider.apiKeyEnv]),
        h("span", { class: "key-cat-prov" }, [provider.label]),
        h("span", { class: `key-cat-status ${has ? "on" : "off"}` }, [has ? "stored" : "not stored"]),
      ]);
      const models = h("div", { class: "key-cat-models" });
      for (const m of provider.models) {
        models.append(h("span", { class: "model-tag" }, [m.label]));
      }
      catalogList.append(h("div", { class: `key-cat${has ? " on" : ""}` }, [head, models]));
    }
  }
  page.append(catalogCard);

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
    let keys: string[];
    try {
      keys = await listSecretKeys();
    } catch (err) {
      formError.textContent = `Failed to load secrets: ${(err as Error).message}`;
      formError.hidden = false;
      return;
    }
    formError.hidden = true;
    renderCatalog(new Set(keys));
    if (!keys.length) listEl.append(h("li", { class: "hint" }, ["No secrets stored yet."]));
    for (const k of keys) {
      const del = h("button", { class: "danger small" }, ["Delete"]);
      del.addEventListener("click", async () => {
        try {
          await deleteSecret(k);
          await refresh();
          markPending();
        } catch (err) {
          formError.textContent = `Failed to delete ${k}: ${(err as Error).message}`;
          formError.hidden = false;
        }
      });
      listEl.append(h("li", {}, [icon(ICONS.key), h("code", {}, [k]), del]));
    }
  }

  const addCard = h("div", { class: "card" }, [h("h3", {}, ["Add a key"])]);
  const form = h("form", { class: "secret-form" });
  form.innerHTML = `
    <label class="inline-label">Key (env var name)<input name="key" placeholder="OPENAI_API_KEY" required /></label>
    <label class="inline-label">Value<input name="value" type="password" placeholder="sk-…" required /></label>
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
  addCard.append(form, formError);

  const restart = h("button", { class: "ghost" }, ["Restart engine to apply secret changes"]);
  // A restart re-spawns the sidecar (backend restart = shutdown + start), which
  // ABORTS any in-flight runs. Guard it: if runs are active, require an explicit
  // confirmation naming how many will be cancelled rather than silently killing
  // them. The confirm prompt lives inline (Tauri intercepts window.confirm).
  const confirmPanel = h("div", { class: "confirm-restart", hidden: "true" });

  async function performRestart(): Promise<void> {
    confirmPanel.hidden = true;
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
  }

  function askRestartConfirm(active: number): void {
    confirmPanel.innerHTML = "";
    const runWord = active === 1 ? "run is" : "runs are";
    const itWord = active === 1 ? "it" : "them";
    const proceed = h("button", { class: "danger" }, [
      `Cancel ${active} run${active === 1 ? "" : "s"} & restart`,
    ]);
    proceed.addEventListener("click", () => void performRestart());
    const keep = h("button", { class: "ghost" }, ["Keep runs going"]);
    keep.addEventListener("click", () => {
      confirmPanel.hidden = true;
    });
    confirmPanel.append(
      h("div", { class: "warn" }, [
        `${active} ${runWord} still active. Restarting will abort ${itWord}.`,
      ]),
      h("div", { class: "actions" }, [proceed, keep]),
    );
    confirmPanel.hidden = false;
  }

  restart.addEventListener("click", async () => {
    formError.hidden = true;
    confirmPanel.hidden = true;
    restart.setAttribute("disabled", "true");
    let active = 0;
    try {
      active = await activeRunCount();
    } catch {
      /* unknown — fall through and restart (treat as nothing to lose) */
    }
    restart.removeAttribute("disabled");
    if (active > 0) {
      askRestartConfirm(active);
      return;
    }
    await performRestart();
  });
  addCard.append(h("div", { class: "actions" }, [restart, pending]), confirmPanel);

  page.append(addCard);

  await refresh();
}

// --- engine status ----------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

async function checkEngine(): Promise<void> {
  const ok = await health();
  engineLabel.textContent = ok ? "engine connected" : "engine offline";
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
