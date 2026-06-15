import "./styles.css";
import {
  apiBase,
  activeRunCount,
  cancelRun,
  checkGitRepo,
  deleteSecret,
  detectCommands,
  getTrace,
  health,
  isTauri,
  listSecretKeys,
  listSessions,
  nudgeRun,
  openStream,
  pickDirectory,
  restartEngine,
  setSecret,
  startRun,
} from "./api.js";
import {
  MODEL_CATALOG,
  buildRunEnv,
  editsFiles,
  findModel,
  loadSettings,
  modelLabel,
  saveSettings,
  usesAdvancedRunners,
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
  folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2z"/>',
  github: '<path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>',
  write: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  review: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
};

// --- recent repos (persisted locally) --------------------------------------

const RECENT_REPOS_KEY = "loopwright.recentRepos";
const MAX_RECENT_REPOS = 8;

/** Returns the recently used repo folders, most-recent first. */
function recentRepos(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_REPOS_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Records `dir` as the most-recently used repo folder (de-duplicated). */
function rememberRepo(dir: string): void {
  if (!dir) return;
  try {
    const next = [dir, ...recentRepos().filter((d) => d !== dir)].slice(0, MAX_RECENT_REPOS);
    localStorage.setItem(RECENT_REPOS_KEY, JSON.stringify(next));
  } catch {
    /* localStorage unavailable — recents are best-effort */
  }
}

// --- saved run configs (for "resume in same repo") -------------------------

const RUN_CONFIGS_KEY = "loopwright.runConfigs";

interface SavedRun {
  goal: string;
  repoDir?: string;
  env: Record<string, string>;
}

/** Persists the start payload for a session so it can be resumed in the same repo. */
function saveRunConfig(sessionId: string, cfg: SavedRun): void {
  try {
    const raw = localStorage.getItem(RUN_CONFIGS_KEY);
    const all = (raw ? JSON.parse(raw) : {}) as Record<string, SavedRun>;
    all[sessionId] = cfg;
    localStorage.setItem(RUN_CONFIGS_KEY, JSON.stringify(all));
  } catch {
    /* best-effort */
  }
}

/** Loads a previously saved start payload for a session, if any. */
function loadRunConfig(sessionId: string): SavedRun | undefined {
  try {
    const raw = localStorage.getItem(RUN_CONFIGS_KEY);
    const all = (raw ? JSON.parse(raw) : {}) as Record<string, SavedRun>;
    return all[sessionId];
  } catch {
    return undefined;
  }
}

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

/** Last path segment of a repo dir, for compact display in the run box. */
function repoName(p: string): string {
  const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

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

  // -- Top row: "Goal" label (left) + the selected repository (top-right).
  const repoText = h("span", {});
  const repoPill = h("button", { type: "button", class: "repo-pill" }, [icon(ICONS.folder), repoText]);
  const repoStatus = h("span", { class: "hint", id: "repo-status" });
  function paintRepo(): void {
    const r = settings.repo.trim();
    repoText.textContent = r ? repoName(r) : "No repository selected";
    repoPill.title = r || "Choose a repository";
    repoPill.classList.toggle("unset", !r);
  }
  paintRepo();
  repoPill.addEventListener("click", async () => {
    // Desktop: pick + validate a folder right here. Browser: send the user to
    // Model settings, where a path can be typed (no native picker in a browser).
    if (!isTauri()) {
      navigate("models");
      return;
    }
    const dir = await pickDirectory();
    if (!dir) return;
    const ok = await checkGitRepo(dir);
    if (ok === false) {
      repoStatus.textContent = "Not a git repository — pick a folder containing a .git directory.";
      repoStatus.className = "hint error";
      return;
    }
    settings.repo = dir;
    saveSettings(settings);
    rememberRepo(dir);
    repoStatus.textContent = "";
    repoStatus.className = "hint";
    paintRepo();
  });

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

  // -- Bottom row: Start button (left) + the two models in use (bottom-right).
  const submit = h("button", { type: "submit", class: "primary" }, [icon(ICONS.rocket), "Start run"]);
  const modelsBtn = h("button", { type: "button", class: "run-models", title: "Change in Model settings" });
  if (usesAdvancedRunners(settings)) {
    modelsBtn.append(h("span", { class: "run-model" }, [icon(ICONS.sliders, "rm-ico"), h("span", { class: "rm-name" }, ["Custom runners"])]));
  } else {
    modelsBtn.append(
      h("span", { class: "run-model" }, [icon(ICONS.write, "rm-ico"), h("span", { class: "rm-role" }, ["Writes"]), h("span", { class: "rm-name" }, [modelLabel(settings.writer)])]),
      h("span", { class: "run-model" }, [icon(ICONS.review, "rm-ico"), h("span", { class: "rm-role" }, ["Reviews"]), h("span", { class: "rm-name" }, [modelLabel(settings.reviewer)])]),
    );
  }
  modelsBtn.addEventListener("click", () => navigate("models"));
  const bottomRow = h("div", { class: "run-box-bottom" }, [submit, modelsBtn]);

  const hint = h("span", { class: "hint", id: "start-hint" });

  form.append(topRow, goalArea, chips, repoStatus, bottomRow, hint);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const goal = goalArea.value.trim();
    if (!goal) {
      goalArea.focus();
      return;
    }

    const repoDir = settings.repo.trim();

    // Guard: pushing requires a repo. Fail early with a clear, inline message.
    if (settings.pushToRemote && !repoDir) {
      hint.textContent = "Select a repository before enabling “Push to GitHub” (Model settings).";
      hint.className = "hint error";
      return;
    }
    // Desktop: re-verify the path is a git tree before hitting the engine.
    if (repoDir && isTauri()) {
      const ok = await checkGitRepo(repoDir);
      if (ok === false) {
        hint.textContent = "The selected repository is not a git repository (Model settings).";
        hint.className = "hint error";
        return;
      }
    }

    const env = buildRunEnv(settings);
    try {
      // Validate JSON early so the user gets a clear message, not a 400.
      if (env.LOOPWRIGHT_RUNNERS) JSON.parse(env.LOOPWRIGHT_RUNNERS);
    } catch (err) {
      hint.textContent = `Runner profiles must be valid JSON (Model settings → Advanced): ${(err as Error).message}`;
      hint.className = "hint error";
      return;
    }

    hint.textContent = "Starting…";
    hint.className = "hint";
    submit.setAttribute("disabled", "true");
    try {
      const sessionId = await startRun({ goal, env, ...(repoDir ? { repoDir } : {}) });
      if (repoDir) rememberRepo(repoDir);
      saveRunConfig(sessionId, { goal, env, ...(repoDir ? { repoDir } : {}) });
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
  const persist = (): void => saveSettings(settings);

  const page = h("section", { class: "page" });
  page.append(
    h("div", { class: "page-head" }, [
      h("h1", {}, ["Model settings"]),
      h("p", { class: "page-sub" }, [
        "Choose which model writes the code and which reviews it, pick the repository to work in, and control run + publishing options. These apply to every new run.",
      ]),
    ]),
  );
  view.append(page);

  // Availability: HTTP providers are unlocked by a stored API key (Tauri
  // keychain); CLI agents by an installed command. In a browser we can't see
  // either, so nothing is gated there.
  let storedKeys = new Set<string>();
  let knowKeys = false;
  let installed: Record<string, boolean> = {};
  if (isTauri()) {
    try {
      storedKeys = new Set(await listSecretKeys());
      knowKeys = true;
    } catch {
      /* unknown — show everything as selectable */
    }
    try {
      installed = await detectCommands(["codex", "kiro", "gh"]);
    } catch {
      /* unknown — don't flag CLI agents as missing */
    }
  }

  function providerMissing(p: (typeof MODEL_CATALOG)[number]): boolean {
    if (p.kind === "cli") return isTauri() && installed[p.command ?? ""] !== true;
    return knowKeys && !storedKeys.has(p.apiKeyEnv ?? "");
  }
  function providerMissingLabel(p: (typeof MODEL_CATALOG)[number]): string {
    return p.kind === "cli" ? `install ${p.command}` : `add ${p.apiKeyEnv}`;
  }

  function modelSelect(role: "writer" | "reviewer", onChange: () => void): HTMLSelectElement {
    const current = settings[role];
    const select = h("select", { "aria-label": `${role} model` }) as HTMLSelectElement;
    for (const provider of MODEL_CATALOG) {
      const missing = providerMissing(provider);
      const group = h("optgroup", { label: missing ? `${provider.label} (${providerMissingLabel(provider)})` : provider.label }) as HTMLOptGroupElement;
      for (const m of provider.models) {
        const opt = h("option", { value: `${provider.id}::${m.id}` }, [m.label]) as HTMLOptionElement;
        if (current.provider === provider.id && current.model === m.id) opt.selected = true;
        group.append(opt);
      }
      select.append(group);
    }
    select.addEventListener("change", () => {
      const [p, m] = select.value.split("::");
      settings[role] = { provider: p!, model: m! } as ModelChoice;
      persist();
      onChange();
    });
    return select;
  }

  function noteFor(role: "writer" | "reviewer", choice: ModelChoice): HTMLElement {
    const note = h("div", { class: "model-note" });
    const found = findModel(choice);
    if (!found) return note;
    const { provider } = found;
    if (provider.kind !== "cli" && knowKeys && !storedKeys.has(provider.apiKeyEnv ?? "")) {
      note.className = "model-note warn";
      const link = h("button", { type: "button", class: "linklike" }, [`Add ${provider.apiKeyEnv}`]);
      link.addEventListener("click", () => navigate("secrets"));
      note.append(h("span", {}, [`No key stored for ${provider.label}. `]), link);
      return note;
    }
    if (provider.kind === "cli" && isTauri() && installed[provider.command ?? ""] !== true) {
      note.className = "model-note warn";
      note.append(h("span", {}, [`${provider.command} is not installed — install it to use ${provider.label}.`]));
      return note;
    }
    if (role === "writer") {
      if (editsFiles(choice)) {
        note.className = "model-note ok";
        note.append(h("span", {}, ["Edits files directly — runs can produce real, committable changes."]));
      } else {
        note.className = "model-note warn";
        note.append(h("span", {}, ["HTTP models return a diff but don't edit files. Pick a CLI or agent writer to change a repo."]));
      }
      return note;
    }
    note.append(h("span", {}, [provider.kind === "cli" ? `Local command: ${provider.command}` : `Uses ${provider.apiKeyEnv}`]));
    return note;
  }

  const writerNote = h("div", { class: "model-note" });
  const reviewerNote = h("div", { class: "model-note" });
  function setNote(target: HTMLElement, role: "writer" | "reviewer"): void {
    const fresh = noteFor(role, settings[role]);
    target.className = fresh.className;
    target.replaceChildren(...Array.from(fresh.childNodes));
  }
  const writerSelect = modelSelect("writer", () => setNote(writerNote, "writer"));
  const reviewerSelect = modelSelect("reviewer", () => setNote(reviewerNote, "reviewer"));
  setNote(writerNote, "writer");
  setNote(reviewerNote, "reviewer");

  // -- Advanced: raw runner-profile override (escape hatch for power users)
  const advRunners = h("textarea", { rows: "8", spellcheck: "false", class: "mono", "aria-label": "Runner profiles (JSON)" }) as HTMLTextAreaElement;
  advRunners.value = settings.advancedRunners;
  const advActor = h("input", { type: "text", placeholder: "actor runner id" }) as HTMLInputElement;
  advActor.value = settings.advancedActor;
  const advCritic = h("input", { type: "text", placeholder: "critic runner id" }) as HTMLInputElement;
  advCritic.value = settings.advancedCritic;
  const advHint = h("div", { class: "hint" });
  function commitAdvanced(): void {
    settings.advancedRunners = advRunners.value;
    settings.advancedActor = advActor.value.trim();
    settings.advancedCritic = advCritic.value.trim();
    persist();
    if (settings.advancedRunners.trim()) {
      try {
        JSON.parse(settings.advancedRunners);
        advHint.textContent = "Active — overrides the Writer / Reviewer pickers above.";
        advHint.className = "hint ok";
      } catch (err) {
        advHint.textContent = `Invalid JSON: ${(err as Error).message}`;
        advHint.className = "hint error";
      }
    } else {
      advHint.textContent = "Leave empty to use the model pickers above.";
      advHint.className = "hint";
    }
  }
  advRunners.addEventListener("input", commitAdvanced);
  advActor.addEventListener("input", commitAdvanced);
  advCritic.addEventListener("input", commitAdvanced);
  commitAdvanced();
  const advancedDetails = h("details", { class: "advanced" });
  if (usesAdvancedRunners(settings)) advancedDetails.setAttribute("open", "true");
  advancedDetails.append(
    h("summary", {}, [icon(ICONS.caret, "caret"), "Advanced — custom runner profiles (JSON)"]),
    h("div", { class: "advanced-body" }, [
      advRunners,
      h("div", { class: "field-grid" }, [
        h("label", { class: "inline-label" }, ["Actor runner id", advActor]),
        h("label", { class: "inline-label" }, ["Critic runner id", advCritic]),
      ]),
      h("small", { class: "desc" }, ["Maps to LOOPWRIGHT_RUNNERS. When set, this overrides the pickers. API keys are referenced by env var name (apiKeyEnv) and resolved from secure storage — never pasted here."]),
      advHint,
    ]),
  );

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
        ? "HTTP models are unlocked by the API keys you store under Secrets; CLI agents must be installed locally."
        : "HTTP models are unlocked by the API keys provided in the engine's environment.",
    ]),
    advancedDetails,
  ]);

  // -- Repository
  const repoInput = h("input", {
    type: "text",
    value: settings.repo,
    placeholder: isTauri() ? "Select a local git repository…" : "/absolute/path/to/your/repo",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  const browseBtn = h("button", { type: "button", class: "ghost" }, [icon(ICONS.folder), "Browse…"]);
  if (!isTauri()) browseBtn.setAttribute("disabled", "true");
  const repoStatus = h("span", { class: "hint" });
  async function validateRepo(): Promise<void> {
    const dir = repoInput.value.trim();
    settings.repo = dir;
    persist();
    if (!dir) {
      repoStatus.textContent = "Optional — leave empty to build in the engine's working directory (no worktrees).";
      repoStatus.className = "hint";
      return;
    }
    const ok = await checkGitRepo(dir);
    if (ok === null) {
      repoStatus.textContent = "Will be validated as a git repository when the run starts.";
      repoStatus.className = "hint";
      return;
    }
    repoStatus.textContent = ok ? "✓ Git repository detected." : "Not a git repository — pick a folder that contains a .git directory.";
    repoStatus.className = ok ? "hint ok" : "hint error";
  }
  repoInput.addEventListener("change", () => void validateRepo());
  repoInput.addEventListener("blur", () => void validateRepo());
  browseBtn.addEventListener("click", async () => {
    const dir = await pickDirectory();
    if (dir) {
      repoInput.value = dir;
      rememberRepo(dir);
      await validateRepo();
    }
  });

  const recents = recentRepos();
  const recentChips = h("div", { class: "chips" });
  if (recents.length) {
    recentChips.append(h("span", { class: "desc" }, ["Recent:"]));
    for (const dir of recents) {
      const chip = h("button", { type: "button", class: "chip", title: dir }, [repoName(dir)]);
      chip.addEventListener("click", () => {
        repoInput.value = dir;
        void validateRepo();
      });
      recentChips.append(chip);
    }
  }

  const repoCard = h("div", { class: "card" }, [
    h("h3", {}, ["Repository"]),
    h("div", { class: "field" }, [
      h("div", { class: "desc" }, ["The local git repo the agents edit. Each task builds in an isolated worktree off this repo. Shown on the New run box."]),
      h("div", { class: "repo-row" }, [repoInput, browseBtn]),
      repoStatus,
      recentChips,
    ]),
  ]);
  void validateRepo();

  // -- Run options
  function switchRow(title: string, desc: string, key: "worktrees" | "mechanicalGate" | "dryRun"): HTMLElement {
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

  const parallelInput = h("input", { type: "number", min: "1", value: String(settings.maxParallel), "aria-label": "Max parallel tasks" }) as HTMLInputElement;
  const dec = h("button", { type: "button", "aria-label": "decrease" }, [icon("<path d='M5 12h14'/>")]);
  const inc = h("button", { type: "button", "aria-label": "increase" }, [icon("<path d='M12 5v14'/><path d='M5 12h14'/>")]);
  const commitParallel = (): void => {
    const parsed = Number(parallelInput.value);
    settings.maxParallel = Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : 1;
    parallelInput.value = String(settings.maxParallel);
    persist();
  };
  dec.addEventListener("click", () => { parallelInput.value = String(Math.max(1, Number(parallelInput.value || "1") - 1)); commitParallel(); });
  inc.addEventListener("click", () => { parallelInput.value = String(Number(parallelInput.value || "1") + 1); commitParallel(); });
  parallelInput.addEventListener("change", commitParallel);
  const stepper = h("div", { class: "stepper" }, [parallelInput, h("div", { class: "steps-btns" }, [inc, dec])]);

  const optionsCard = h("div", { class: "card" }, [
    h("h3", {}, ["Run options"]),
    h("div", { class: "options" }, [
      h("div", { class: "option" }, [
        h("div", { class: "option-text" }, [h("strong", {}, ["Max parallel tasks"]), h("span", {}, ["How many tasks run at the same time."])]),
        stepper,
      ]),
      switchRow("Use git worktrees", "Isolate each task in its own worktree so parallel work never collides.", "worktrees"),
      switchRow("Mechanical gate", "Run build / test / lint checks before the critic reviews each change.", "mechanicalGate"),
    ]),
  ]);

  // -- Branch & publishing
  function textField(label: string, value: string, placeholder: string, on: (v: string) => void): HTMLElement {
    const input = h("input", { type: "text", value, placeholder, autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
    input.addEventListener("input", () => on(input.value));
    return h("label", { class: "inline-label" }, [label, input]);
  }
  function switchWith(input: HTMLInputElement, title: string, desc: string): HTMLElement {
    return h("div", { class: "option" }, [
      h("div", { class: "option-text" }, [h("strong", {}, [title]), h("span", {}, [desc])]),
      h("label", { class: "switch" }, [input, h("span", { class: "track" })]),
    ]);
  }

  const branchPrefixField = textField("Branch prefix", settings.branchPrefix, "loopwright", (v) => { settings.branchPrefix = v; persist(); });
  const dryRunRow = switchRow("Dry run", "Build a local integration branch but never push, even if pushing is enabled.", "dryRun");

  const pushInput = h("input", { type: "checkbox", "aria-label": "Push to GitHub" }) as HTMLInputElement;
  if (settings.pushToRemote) pushInput.checked = true;
  const pushRow = switchWith(pushInput, "Push to GitHub", "After a clean, verified integration, push the integration branch to a remote.");

  const pushPanel = h("div", { class: "subpanel", hidden: "true" });
  const openPrInput = h("input", { type: "checkbox", "aria-label": "Open a pull request" }) as HTMLInputElement;
  if (settings.openPr) openPrInput.checked = true;
  const openPrRow = switchWith(openPrInput, "Open a pull request", "After pushing, open a PR with the GitHub CLI (gh).");
  const prPanel = h("div", { class: "subpanel", hidden: "true" });
  const prDraftInput = h("input", { type: "checkbox", "aria-label": "Open as draft" }) as HTMLInputElement;
  if (settings.prDraft) prDraftInput.checked = true;
  prDraftInput.addEventListener("change", () => { settings.prDraft = prDraftInput.checked; persist(); });
  prPanel.append(
    h("div", { class: "field-grid" }, [
      textField("PR base branch", settings.prBase, "(repo default branch)", (v) => { settings.prBase = v; persist(); }),
      textField("PR title", settings.prTitle, "(generated from the goal)", (v) => { settings.prTitle = v; persist(); }),
    ]),
    switchWith(prDraftInput, "Open as draft", "Recommended — open the PR as a draft for review."),
  );
  prPanel.hidden = !settings.openPr;
  openPrInput.addEventListener("change", () => { settings.openPr = openPrInput.checked; persist(); prPanel.hidden = !openPrInput.checked; });

  const overrideInput = h("input", { type: "checkbox", "aria-label": "Override safety checks" }) as HTMLInputElement;
  if (settings.pushOverride) overrideInput.checked = true;
  overrideInput.addEventListener("change", () => { settings.pushOverride = overrideInput.checked; persist(); });

  pushPanel.append(
    h("div", { class: "field-grid" }, [
      textField("Remote", settings.remote, "origin", (v) => { settings.remote = v; persist(); }),
      textField("Target branch", settings.pushBranch, "(default: generated integration branch)", (v) => { settings.pushBranch = v; persist(); }),
    ]),
    openPrRow,
    prPanel,
    switchWith(overrideInput, "Override safety checks (unsafe)", "Push even if integration failed, there were merge conflicts, or verification did not pass."),
  );
  pushPanel.hidden = !settings.pushToRemote;
  pushInput.addEventListener("change", () => { settings.pushToRemote = pushInput.checked; persist(); pushPanel.hidden = !pushInput.checked; });

  const envPanel = h("div", { class: "env-checks" });
  if (isTauri()) {
    envPanel.append(h("div", { class: "desc" }, ["Detected tools:"]));
    for (const name of ["codex", "kiro", "gh"]) {
      const ok = installed[name] === true;
      envPanel.append(h("span", { class: `tool ${ok ? "ok" : "missing"}` }, [`${name}: ${ok ? "installed" : "missing"}`]));
    }
    envPanel.append(h("div", { class: "desc" }, ["Pushing uses your local git credentials. Opening a PR needs gh installed and authenticated (gh auth status), or a GITHUB_TOKEN secret."]));
  } else {
    envPanel.append(h("div", { class: "desc" }, ["Pushing uses the engine host's git credentials; opening a PR needs the gh CLI authenticated or a GITHUB_TOKEN in the environment."]));
  }

  const publishCard = h("div", { class: "card" }, [
    h("h3", {}, ["Branch & publishing"]),
    h("div", { class: "desc" }, ["Control branch naming and whether a successful run is pushed to GitHub. Everything here is opt-in and off by default."]),
    h("div", { class: "options" }, [branchPrefixField, dryRunRow, pushRow]),
    pushPanel,
    envPanel,
  ]);

  page.append(repoCard, modelsCard, optionsCard, publishCard);
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
  // Steering: nudge an in-flight agent run with extra guidance. Only effective
  // for steerable backends (the native agent runner); other backends reply 409.
  const nudgeInput = h("input", {
    type: "text",
    class: "nudge-input",
    placeholder: "Nudge the agent…",
    "aria-label": "Nudge the in-flight run",
  }) as HTMLInputElement;
  const nudgeBtn = h("button", { class: "small" }, ["Nudge"]);

  const header = h("div", { class: "card run-head" }, [
    h("div", { class: "goal" }, [goal]),
    h("div", { class: "meta-row" }, [phase, stopBtn, h("span", { class: "session-id" }, [`session ${sessionId}`])]),
    h("div", { class: "meta-row nudge-row" }, [nudgeInput, nudgeBtn]),
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

  // Nudge control: inject steering guidance into the running agent.
  let nudging = false;
  const sendNudge = async (): Promise<void> => {
    if (nudging) return;
    const text = nudgeInput.value.trim();
    if (!text) return;
    nudging = true;
    nudgeBtn.setAttribute("disabled", "true");
    nudgeInput.setAttribute("disabled", "true");
    try {
      await nudgeRun(sessionId, text);
      nudgeInput.value = "";
      appendLog(`    · you → nudge: ${text}`);
    } catch (err) {
      plan.textContent = `Nudge failed: ${(err as Error).message}`;
    } finally {
      nudging = false;
      nudgeBtn.removeAttribute("disabled");
      nudgeInput.removeAttribute("disabled");
    }
  };
  nudgeBtn.addEventListener("click", () => void sendNudge());
  nudgeInput.addEventListener("keydown", (ev) => {
    if ((ev as KeyboardEvent).key === "Enter") {
      ev.preventDefault();
      void sendNudge();
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
      } else if (ev.type === "runner_activity") {
        // Live sub-step feed from an agent runner's inner loop (tool calls).
        const d = ev.data ?? {};
        if (d.phase === "tool_start") {
          appendLog(`    · ${d.role} → ${d.toolName}`);
        } else if (d.phase === "tool_end") {
          appendLog(`    · ${d.role} ✓ ${d.toolName}${d.isError ? " (error)" : ""}`);
        }
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

  // Publish (push + PR) card — surfaces what reached GitHub, or why it didn't.
  const publishEvent = trace.events.find((e) => e.type === "publish");
  if (publishEvent) {
    const d = publishEvent.data as {
      pushed?: boolean;
      remote?: string;
      branch?: string;
      pushBranch?: string;
      remoteUrl?: string;
      refused?: string;
      reason?: string;
      error?: string;
      pr?: { created?: boolean; url?: string; error?: string };
    };
    const pushed = d.pushed === true;
    const card = h("div", { class: `card${pushed ? "" : " integration-bad"}` });
    card.append(h("h3", {}, [icon(ICONS.github), " Push & pull request"]));

    if (pushed) {
      card.append(
        h("div", { class: "phase done" }, [
          `Pushed ${String(d.branch ?? "")} → ${String(d.remote ?? "origin")}/${String(d.pushBranch ?? d.branch ?? "")}`,
        ]),
      );
      if (d.remoteUrl) card.append(h("div", { class: "hint" }, [`remote: ${d.remoteUrl}`]));
      if (d.pr?.created) {
        const prLine = h("div", { class: "hint ok" }, ["Pull request opened"]);
        if (d.pr.url) {
          prLine.append(" — ");
          prLine.append(h("a", { href: d.pr.url, target: "_blank", rel: "noreferrer" }, [d.pr.url]));
        }
        card.append(prLine);
      } else if (d.pr?.error) {
        card.append(h("div", { class: "hint error" }, [`PR not opened: ${d.pr.error}`]));
      }
    } else if (d.refused) {
      card.append(
        h("div", { class: "phase error" }, ["Push refused by safety checks"]),
        h("pre", { class: "log" }, [d.reason ?? d.refused]),
      );
    } else if (d.error) {
      card.append(
        h("div", { class: "phase error" }, ["Push failed"]),
        h("pre", { class: "log" }, [d.error]),
      );
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

    const row = h("div", { class: "session-row" }, [btn]);

    // Resume-in-same-repo (item 14): only when we have the original start
    // payload (goal, runners, repo) saved locally and the run isn't still going.
    const saved = loadRunConfig(s.id);
    if (saved && s.status !== "running") {
      const resume = h("button", { class: "ghost small", title: saved.repoDir ?? "" }, [
        icon(ICONS.loop),
        "Resume",
      ]);
      resume.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        resume.setAttribute("disabled", "true");
        try {
          await startRun({
            goal: saved.goal,
            env: saved.env,
            ...(saved.repoDir ? { repoDir: saved.repoDir } : {}),
            sessionId: s.id,
            resume: true,
          });
          renderMonitor(s.id, saved.goal);
        } catch (err) {
          resume.removeAttribute("disabled");
          alert(`Resume failed: ${(err as Error).message}`);
        }
      });
      row.append(resume);
    }

    li.append(row);
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
      if (provider.kind !== "http" || !provider.apiKeyEnv) continue; // CLI agents have no key
      const has = stored.has(provider.apiKeyEnv);
      const head = h("div", { class: "key-cat-head" }, [
        icon(ICONS.key, "key-cat-ico"),
        h("code", {}, [provider.apiKeyEnv]),
        h("span", { class: "key-cat-prov" }, [provider.label]),
        h("span", { class: `key-cat-status ${has ? "on" : "off"}` }, [has ? "stored" : "not stored"]),
      ]);
      const models = h("div", { class: "key-cat-models" });
      for (const m of provider.models) models.append(h("span", { class: "model-tag" }, [m.label]));
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
