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
  openStream,
  pickDirectory,
  restartEngine,
  setSecret,
  startRun,
} from "./api.js";
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

type Nav = "start" | "sessions" | "secrets";
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

interface Preset {
  label: string;
  json: string;
}

const PRESETS: Record<string, Preset> = {
  openai: {
    label: "OpenAI (gpt-4o-mini)",
    json: JSON.stringify(
      [{ id: "primary", kind: "http", model: "gpt-4o-mini", options: { baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" } }],
      null,
      2,
    ),
  },
  anthropic: {
    label: "Anthropic (claude-3-5-sonnet)",
    json: JSON.stringify(
      [{ id: "primary", kind: "http", model: "claude-3-5-sonnet-latest", options: { baseUrl: "https://api.anthropic.com/v1", apiKeyEnv: "ANTHROPIC_API_KEY" } }],
      null,
      2,
    ),
  },
  local: {
    label: "Local (Ollama / OpenAI-compatible)",
    json: JSON.stringify(
      [{ id: "primary", kind: "http", model: "llama3.1", options: { baseUrl: "http://localhost:11434/v1", apiKeyEnv: "OLLAMA_API_KEY" } }],
      null,
      2,
    ),
  },
  split: {
    label: "Split actor + critic",
    json: JSON.stringify(
      [
        { id: "builder", kind: "http", model: "gpt-4o-mini", options: { baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" } },
        { id: "reviewer", kind: "http", model: "gpt-4o", options: { baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" } },
      ],
      null,
      2,
    ),
  },
  codex: {
    label: "Codex CLI (edits files locally)",
    json: JSON.stringify(
      [
        {
          id: "codex",
          kind: "cli",
          model: "",
          options: {
            command: "codex",
            args: ["exec", "--json", "{{prompt}}"],
            promptVia: "arg",
            output: { mode: "json-stream", textPath: "msg.text", typeField: "type", type: "item.completed" },
          },
        },
      ],
      null,
      2,
    ),
  },
  kiro: {
    label: "Kiro CLI (edits files locally)",
    json: JSON.stringify(
      [
        {
          id: "kiro",
          kind: "cli",
          model: "",
          options: {
            command: "kiro",
            args: ["--headless", "--prompt", "{{prompt}}"],
            promptVia: "arg",
            output: { mode: "last-line" },
          },
        },
      ],
      null,
      2,
    ),
  },
  codexCritic: {
    label: "Codex actor + OpenAI critic",
    json: JSON.stringify(
      [
        {
          id: "codex",
          kind: "cli",
          model: "",
          options: {
            command: "codex",
            args: ["exec", "--json", "{{prompt}}"],
            promptVia: "arg",
            output: { mode: "json-stream", textPath: "msg.text", typeField: "type", type: "item.completed" },
          },
        },
        { id: "reviewer", kind: "http", model: "gpt-4o", options: { baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" } },
      ],
      null,
      2,
    ),
  },
};

/**
 * Presets whose actor runner edits files directly on disk (CLI agents). Only
 * these can actually CHANGE code in the selected repo — HTTP runners return a
 * diff string the engine does not apply. The UI nudges toward a CLI actor when
 * a repo is selected so a run can produce real, committable changes (item 5).
 */
const FILE_EDITING_PRESETS = new Set(["codex", "kiro", "codexCritic"]);

/** Default actor/critic ids per preset, so roles match the chosen profiles. */
const PRESET_ROLES: Record<string, { actor: string; critic: string }> = {
  openai: { actor: "primary", critic: "primary" },
  anthropic: { actor: "primary", critic: "primary" },
  local: { actor: "primary", critic: "primary" },
  split: { actor: "builder", critic: "reviewer" },
  codex: { actor: "codex", critic: "codex" },
  kiro: { actor: "kiro", critic: "kiro" },
  codexCritic: { actor: "codex", critic: "reviewer" },
};

const EXAMPLE_GOALS = [
  "Add a /healthz endpoint with a test",
  "Fix the failing auth middleware tests",
  "Add input validation to the signup form",
  "Refactor the config loader to use zod",
];

function renderStart(): void {
  const page = h("section", { class: "page" });

  // Header
  page.append(
    h("div", { class: "page-head" }, [
      h("div", { class: "eyebrow" }, ["Actor – Critic loop"]),
      h("h1", {}, ["Start a new run"]),
      h("p", { class: "page-sub" }, [
        "Describe a goal in plain language. Loopwright plans the work, an actor agent implements it, a critic agent reviews each change, and the loop repeats until the work is verified.",
      ]),
    ]),
  );

  // How it works
  const steps = h("div", { class: "steps" });
  const stepData: Array<[string, string, string, string]> = [
    ["1", ICONS.plan, "Plan", "The goal is broken into small, independently verifiable tasks."],
    ["2", ICONS.loop, "Build & critique", "An actor writes code; a critic reviews it. They iterate until it holds up."],
    ["3", ICONS.verify, "Verify & integrate", "Mechanical checks run, branches merge, and results are traced end to end."],
  ];
  for (const [n, p, title, desc] of stepData) {
    steps.append(
      h("div", { class: "step", "data-n": n }, [
        icon(p, "step-ico"),
        h("h4", {}, [title]),
        h("p", {}, [desc]),
      ]),
    );
  }
  page.append(steps);

  // Form
  const form = h("form", { class: "card form" });

  // -- Goal field
  const goalField = h("div", { class: "field" });
  const goalArea = h("textarea", {
    id: "start-goal",
    name: "goal",
    rows: "3",
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
  goalField.append(
    h("label", { class: "label", for: "start-goal" }, ["Goal"]),
    h("div", { class: "desc" }, ["What should the agents accomplish? Be specific about the outcome you expect."]),
    goalArea,
    chips,
  );

  // -- Repository field (folder picker + recent repos + validation)
  const repoField = h("div", { class: "field" });
  const repoInput = h("input", {
    type: "text",
    id: "start-repo",
    name: "repoDir",
    placeholder: isTauri() ? "Select a local git repository…" : "/absolute/path/to/your/repo",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  const browseBtn = h("button", { type: "button", class: "ghost" }, [icon(ICONS.folder), "Browse…"]);
  const repoStatus = h("span", { class: "hint", id: "repo-status" });
  const repoRow = h("div", { class: "repo-row" }, [repoInput, browseBtn]);

  // Validate the path: in the desktop app we can check the filesystem directly;
  // in a browser the engine validates on submit, so we just note that.
  let repoValid = false;
  async function validateRepo(): Promise<void> {
    const dir = repoInput.value.trim();
    if (!dir) {
      repoValid = false;
      repoStatus.textContent = "Optional — leave empty to build in the engine's working directory (no worktrees).";
      repoStatus.className = "hint";
      return;
    }
    const ok = await checkGitRepo(dir);
    if (ok === null) {
      // Browser: can't check locally; the engine validates on start.
      repoValid = true;
      repoStatus.textContent = "Will be validated as a git repository when the run starts.";
      repoStatus.className = "hint";
      return;
    }
    repoValid = ok;
    repoStatus.textContent = ok ? "✓ Git repository detected." : "Not a git repository — pick a folder that contains a .git directory.";
    repoStatus.className = ok ? "hint ok" : "hint error";
  }
  repoInput.addEventListener("change", () => void validateRepo());
  repoInput.addEventListener("blur", () => void validateRepo());

  browseBtn.addEventListener("click", async () => {
    const dir = await pickDirectory();
    if (dir) {
      repoInput.value = dir;
      await validateRepo();
    }
  });
  if (!isTauri()) browseBtn.setAttribute("disabled", "true");

  // Recent repos (item 11): quick re-selection of previously used folders.
  const recents = recentRepos();
  const recentChips = h("div", { class: "chips" });
  if (recents.length) {
    recentChips.append(h("span", { class: "desc" }, ["Recent:"]));
    for (const dir of recents) {
      const short = dir.length > 40 ? `…${dir.slice(-40)}` : dir;
      const chip = h("button", { type: "button", class: "chip", title: dir }, [short]);
      chip.addEventListener("click", () => {
        repoInput.value = dir;
        void validateRepo();
      });
      recentChips.append(chip);
    }
  }

  repoField.append(
    h("label", { class: "label", for: "start-repo" }, ["Repository"]),
    h("div", { class: "desc" }, ["The local git repo the agents will edit. Each task builds in an isolated worktree off this repo."]),
    repoRow,
    repoStatus,
    recentChips,
  );
  void validateRepo();

  // -- Model / runner field
  const runnerField = h("div", { class: "field" });
  const presetSelect = h("select", { id: "start-preset", name: "preset" }) as HTMLSelectElement;
  for (const [key, p] of Object.entries(PRESETS)) {
    presetSelect.append(h("option", { value: key }, [p.label]));
  }
  const runnersArea = h("textarea", { name: "runners", rows: "10", spellcheck: "false", class: "mono", "aria-label": "Runner profiles (JSON)" }) as HTMLTextAreaElement;
  runnersArea.value = PRESETS.openai!.json;

  const advanced = h("details", { class: "advanced" });
  const summary = h("summary", {}, [icon(ICONS.caret, "caret"), "Advanced — edit runner profiles (JSON)"]);
  advanced.append(
    summary,
    h("div", { class: "advanced-body" }, [
      runnersArea,
      h("small", { class: "desc" }, [
        "Maps to LOOPWRIGHT_RUNNERS. API keys are referenced by env var name (apiKeyEnv) and resolved from secure storage — never pasted here.",
      ]),
    ]),
  );

  // Nudge: only CLI (file-editing) actors actually change code on disk. HTTP
  // runners return a diff the engine does not apply, so they can't update a
  // selected repo (item 5).
  const runnerHint = h("div", { class: "hint", id: "runner-hint" });
  function updateRunnerHint(): void {
    const isFileEditing = FILE_EDITING_PRESETS.has(presetSelect.value);
    if (isFileEditing) {
      runnerHint.textContent = "✓ This actor edits files directly in the repo, so a run can produce real, committable changes.";
      runnerHint.className = "hint ok";
    } else {
      runnerHint.textContent =
        "Note: HTTP model runners return a diff but do NOT edit files. To actually change a selected repo, pick a CLI actor (Codex or Kiro).";
      runnerHint.className = "hint warn";
    }
  }

  presetSelect.addEventListener("change", () => {
    const p = PRESETS[presetSelect.value];
    if (p) {
      runnersArea.value = p.json;
      syncRunnerIds();
      const roles = PRESET_ROLES[presetSelect.value];
      if (roles) {
        actorInput.value = roles.actor;
        criticInput.value = roles.critic;
      }
      updateRunnerHint();
    }
  });

  runnerField.append(
    h("label", { class: "label", for: "start-preset" }, ["Model provider"]),
    h("div", { class: "desc" }, ["Pick a preset to get started, or open Advanced to define your own runner profiles."]),
    presetSelect,
    runnerHint,
    advanced,
  );

  // -- Roles
  const rolesGrid = h("div", { class: "field-grid" });
  const actorInput = h("input", { type: "text", name: "actor", value: "primary", list: "runner-ids" }) as HTMLInputElement;
  const criticInput = h("input", { type: "text", name: "critic", value: "primary", list: "runner-ids" }) as HTMLInputElement;
  const idDatalist = h("datalist", { id: "runner-ids" });
  rolesGrid.append(
    h("label", { class: "inline-label" }, ["Actor runner", h("span", { class: "desc" }, ["Writes the code"]), actorInput]),
    h("label", { class: "inline-label" }, ["Critic runner", h("span", { class: "desc" }, ["Reviews the code"]), criticInput]),
    idDatalist,
  );
  const rolesField = h("div", { class: "field" }, [
    h("div", { class: "label" }, ["Roles"]),
    h("div", { class: "desc" }, ["Which runner profile plays each role. They can be the same."]),
    rolesGrid,
  ]);

  function syncRunnerIds(): void {
    idDatalist.innerHTML = "";
    try {
      const arr = JSON.parse(runnersArea.value) as Array<{ id?: string }>;
      const ids = arr.map((r) => r.id).filter((x): x is string => typeof x === "string");
      for (const id of ids) idDatalist.append(h("option", { value: id }));
      // If current actor/critic aren't valid ids, point them at the first one.
      if (ids[0] && !ids.includes(actorInput.value)) actorInput.value = ids[0];
      if (ids[0] && !ids.includes(criticInput.value)) criticInput.value = ids[0];
    } catch {
      /* invalid JSON — leave inputs as-is, validated on submit */
    }
  }
  runnersArea.addEventListener("input", syncRunnerIds);
  syncRunnerIds();
  updateRunnerHint();

  // -- Options
  const optionsField = h("div", { class: "field" });
  const options = h("div", { class: "options" });

  function optionRow(name: string, title: string, desc: string, checked: boolean): HTMLElement {
    const input = h("input", { type: "checkbox", name, "aria-label": title }) as HTMLInputElement;
    if (checked) input.checked = true;
    return h("div", { class: "option" }, [
      h("div", { class: "option-text" }, [h("strong", {}, [title]), h("span", {}, [desc])]),
      h("label", { class: "switch" }, [input, h("span", { class: "track" })]),
    ]);
  }

  // Max parallel stepper
  const parallelInput = h("input", { type: "number", name: "maxParallel", min: "1", value: "2", "aria-label": "Max parallel tasks" }) as HTMLInputElement;
  const dec = h("button", { type: "button", "aria-label": "decrease" }, [icon("<path d='M5 12h14'/>")]);
  const inc = h("button", { type: "button", "aria-label": "increase" }, [icon("<path d='M12 5v14'/><path d='M5 12h14'/>")]);
  dec.addEventListener("click", () => { parallelInput.value = String(Math.max(1, Number(parallelInput.value || "1") - 1)); });
  inc.addEventListener("click", () => { parallelInput.value = String(Number(parallelInput.value || "1") + 1); });
  const stepper = h("div", { class: "stepper" }, [parallelInput, h("div", { class: "steps-btns" }, [inc, dec])]);

  options.append(
    h("div", { class: "option" }, [
      h("div", { class: "option-text" }, [h("strong", {}, ["Max parallel tasks"]), h("span", {}, ["How many tasks run at the same time."])]),
      stepper,
    ]),
    optionRow("worktrees", "Use git worktrees", "Isolate each task in its own worktree so parallel work never collides.", true),
    optionRow("gate", "Mechanical gate", "Run build / test / lint checks before the critic reviews each change.", true),
  );
  optionsField.append(h("div", { class: "label" }, ["Options"]), options);

  // -- Publish (GitHub) field --------------------------------------------
  // All push/PR controls live here; everything is opt-in and OFF by default so
  // a run never touches a remote unless the user asks (items 7, 8, 9, 12, 13).
  const publishField = h("div", { class: "field" });

  /** Reads the checkbox inside a row built by optionRow. */
  function checkboxOf(row: HTMLElement, name: string): HTMLInputElement {
    return row.querySelector(`input[name="${name}"]`) as HTMLInputElement;
  }
  function labeledInput(label: string, name: string, value: string, placeholder = ""): HTMLElement {
    const input = h("input", { type: "text", name, value, placeholder, autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
    return h("label", { class: "inline-label" }, [label, input]);
  }

  // Branch naming (item 12) + dry run (item 13).
  const branchPrefixField = labeledInput("Branch prefix", "branchPrefix", "loopwright", "loopwright");
  const dryRunRow = optionRow("dryRun", "Dry run", "Build a local integration branch but never push, even if pushing is enabled.", false);
  const pushRow = optionRow("pushToRemote", "Push to GitHub", "After a clean, verified integration, push the integration branch to a remote.", false);

  // Push sub-panel (revealed when "Push to GitHub" is on).
  const pushPanel = h("div", { class: "subpanel", hidden: "true" });
  const remoteGrid = h("div", { class: "field-grid" }, [
    labeledInput("Remote", "remote", "origin", "origin"),
    labeledInput("Target branch", "pushBranch", "", "(default: generated integration branch)"),
  ]);
  const openPrRow = optionRow("openPr", "Open a pull request", "After pushing, open a PR with the GitHub CLI (gh).", false);
  const prPanel = h("div", { class: "subpanel", hidden: "true" });
  prPanel.append(
    h("div", { class: "field-grid" }, [
      labeledInput("PR base branch", "prBase", "", "(repo default branch)"),
      labeledInput("PR title", "prTitle", "", "(generated from the goal)"),
    ]),
    optionRow("prDraft", "Open as draft", "Recommended — open the PR as a draft for review.", true),
  );
  const overrideRow = optionRow(
    "pushOverride",
    "Override safety checks (unsafe)",
    "Push even if integration failed, there were merge conflicts, or verification did not pass.",
    false,
  );

  checkboxOf(pushRow, "pushToRemote").addEventListener("change", (e) => {
    pushPanel.hidden = !(e.target as HTMLInputElement).checked;
  });
  checkboxOf(openPrRow, "openPr").addEventListener("change", (e) => {
    prPanel.hidden = !(e.target as HTMLInputElement).checked;
  });

  pushPanel.append(remoteGrid, openPrRow, prPanel, overrideRow);

  // Environment readiness (items 9, 15): show whether the CLI tools the run may
  // need are installed. Desktop only; a browser can't probe local commands.
  const envPanel = h("div", { class: "env-checks" });
  if (isTauri()) {
    void detectCommands(["gh", "codex", "kiro"]).then((found) => {
      envPanel.innerHTML = "";
      envPanel.append(h("div", { class: "desc" }, ["Detected tools:"]));
      for (const name of ["codex", "kiro", "gh"]) {
        const ok = found[name] === true;
        envPanel.append(
          h("span", { class: `tool ${ok ? "ok" : "missing"}` }, [`${name}: ${ok ? "installed" : "missing"}`]),
        );
      }
      envPanel.append(
        h("div", { class: "desc" }, [
          "Pushing uses your local git credentials. Opening a PR needs gh installed and authenticated (gh auth status), or a GITHUB_TOKEN secret.",
        ]),
      );
    });
  } else {
    envPanel.append(
      h("div", { class: "desc" }, [
        "Pushing uses the engine host's git credentials; opening a PR needs the gh CLI authenticated or a GITHUB_TOKEN in the environment.",
      ]),
    );
  }

  publishField.append(
    h("div", { class: "label" }, ["Branch & publishing"]),
    h("div", { class: "desc" }, ["Control branch naming and whether a successful run is pushed to GitHub."]),
    h("div", { class: "options" }, [branchPrefixField, dryRunRow, pushRow]),
    pushPanel,
    envPanel,
  );

  // -- Submit
  const hint = h("span", { class: "hint", id: "start-hint" });
  const submit = h("button", { type: "submit", class: "primary" }, [icon(ICONS.rocket), "Start run"]);
  const actions = h("div", { class: "actions" }, [submit, hint]);

  form.append(goalField, repoField, runnerField, rolesField, optionsField, publishField, actions);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const goal = String(data.get("goal") ?? "").trim();
    if (!goal) {
      goalArea.focus();
      return;
    }

    const repoDir = String(data.get("repoDir") ?? "").trim();
    const pushToRemote = Boolean(data.get("pushToRemote"));

    // Revalidate now: `repoValid` reflects the last change/blur, but a user can
    // edit or pick a path and submit before those handlers fire (stale state).
    if (repoDir) await validateRepo();

    // Guard: pushing (or worktrees) requires a repo. Fail early with a clear,
    // inline message rather than a server 400.
    if (pushToRemote && !repoDir) {
      hint.textContent = "Select a repository before enabling “Push to GitHub”.";
      hint.className = "hint error";
      repoInput.focus();
      return;
    }

    // In the desktop app we know locally whether the path is a git repo; block
    // a clearly-invalid selection before hitting the engine.
    if (repoDir && !repoValid) {
      hint.textContent = "The selected repository path is not a git repository.";
      hint.className = "hint error";
      repoInput.focus();
      return;
    }

    const env: Record<string, string> = {
      LOOPWRIGHT_RUNNERS: String(data.get("runners") ?? "").trim(),
      LOOPWRIGHT_ACTOR_RUNNER: String(data.get("actor") ?? "").trim(),
      LOOPWRIGHT_CRITIC_RUNNER: String(data.get("critic") ?? "").trim(),
      LOOPWRIGHT_MAX_PARALLEL: String(data.get("maxParallel") ?? "2"),
      LOOPWRIGHT_USE_WORKTREES: data.get("worktrees") ? "true" : "false",
      LOOPWRIGHT_MECHANICAL_GATE: data.get("gate") ? "true" : "false",
      LOOPWRIGHT_BRANCH_PREFIX: String(data.get("branchPrefix") ?? "loopwright").trim() || "loopwright",
      LOOPWRIGHT_DRY_RUN: data.get("dryRun") ? "true" : "false",
      LOOPWRIGHT_PUSH_TO_REMOTE: pushToRemote ? "true" : "false",
      LOOPWRIGHT_REMOTE: String(data.get("remote") ?? "origin").trim() || "origin",
      LOOPWRIGHT_PUSH_BRANCH: String(data.get("pushBranch") ?? "").trim(),
      LOOPWRIGHT_OPEN_PR: data.get("openPr") ? "true" : "false",
      LOOPWRIGHT_PR_BASE: String(data.get("prBase") ?? "").trim(),
      LOOPWRIGHT_PR_TITLE: String(data.get("prTitle") ?? "").trim(),
      LOOPWRIGHT_PR_DRAFT: data.get("prDraft") ? "true" : "false",
      LOOPWRIGHT_PUSH_OVERRIDE_SAFETY: data.get("pushOverride") ? "true" : "false",
    };

    try {
      // Validate JSON early so the user gets a clear message, not a 400.
      if (env.LOOPWRIGHT_RUNNERS) JSON.parse(env.LOOPWRIGHT_RUNNERS);
    } catch (err) {
      advanced.setAttribute("open", "true");
      hint.textContent = `Runner profiles must be valid JSON: ${(err as Error).message}`;
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
