/**
 * Run settings + the runner-preset catalog.
 *
 * The engine itself is vendor-neutral: a run is configured purely by env vars
 * (LOOPWRIGHT_RUNNERS + role bindings + publishing flags) plus an optional
 * repo path. This module is the UI-side source of truth that turns a friendly
 * "which preset writes / which preset reviews" choice into those env vars, and
 * remembers every run-shaping preference between runs so the New run screen can
 * stay a minimal goal box while nothing is lost.
 *
 * The catalog is a small, opinionated set of first-class RUNNER PRESETS rather
 * than a generic provider/model matrix:
 *
 *   - codex-cli        `codex exec --json --model <model>` — a local CLI agent
 *                      that edits files; best with a ChatGPT/Codex entitlement
 *                      or an OpenAI key.
 *   - openai-responses the OpenAI Responses API (`/v1/responses`) for a model
 *                      id like gpt-5.5 — returns a diff, does not edit files.
 *   - kiro-cli         `kiro-cli chat --no-interactive --trust-tools=…` with
 *                      KIRO_API_KEY — a local CLI agent that edits files.
 *
 * CLI presets are the ones that actually edit files on disk; the Responses
 * preset only returns a diff the engine does not apply.
 */

/** Wire format each preset maps to (matches the engine's RunnerProfile.kind). */
export type PresetKind = "cli" | "http-responses";

export interface RunnerPreset {
  /** stable preset id, e.g. "codex-cli" */
  id: string;
  /** display name */
  label: string;
  kind: PresetKind;
  /** one-line description shown under the picker */
  description: string;
  /** default model id (the run uses this unless the user overrides it) */
  defaultModel: string;
  /** whether the user can edit the model id (false for account-driven CLIs) */
  configurableModel: boolean;
  /** true for presets that edit files directly (can produce real changes) */
  editsFiles: boolean;
  /** how this preset authenticates, shown in the UI */
  authHint: string;

  /** http-responses: base URL the ResponsesRunner targets */
  baseUrl?: string;
  /** http-responses: request path (default "/responses") */
  path?: string;
  /** http-responses: env var holding the API key (also used for auth status) */
  apiKeyEnv?: string;

  /** cli: the command that must be on PATH (used for install detection) */
  command?: string;
  /** an env var the preset needs to authenticate (used for auth status) */
  requiresEnv?: string;
}

/**
 * The three first-class presets. Every entry is something a user can actually
 * run once the matching key is stored and/or the command is installed.
 */
export const PRESETS: RunnerPreset[] = [
  {
    id: "codex-cli",
    label: "Codex CLI",
    kind: "cli",
    description: "Runs `codex exec --json --model <model>` locally and edits files directly.",
    defaultModel: "gpt-5.5",
    configurableModel: true,
    editsFiles: true,
    authHint: "Sign in with `codex login` (ChatGPT Business / Codex) or set OPENAI_API_KEY.",
    command: "codex",
  },
  {
    id: "openai-responses",
    label: "OpenAI Responses API",
    kind: "http-responses",
    description: "Calls the OpenAI Responses API (/v1/responses). Returns a diff; does not edit files.",
    defaultModel: "gpt-5.5",
    configurableModel: true,
    editsFiles: false,
    authHint: "Needs OPENAI_API_KEY stored under Secrets.",
    baseUrl: "https://api.openai.com/v1",
    path: "/responses",
    apiKeyEnv: "OPENAI_API_KEY",
  },
  {
    id: "kiro-cli",
    label: "Kiro CLI",
    kind: "cli",
    description: "Runs `kiro-cli chat --no-interactive` headlessly and edits files directly.",
    defaultModel: "",
    configurableModel: false,
    editsFiles: true,
    authHint: "Needs the kiro-cli command installed and KIRO_API_KEY stored under Secrets.",
    command: "kiro-cli",
    requiresEnv: "KIRO_API_KEY",
  },
];

/** A concrete preset choice: which preset + (for configurable presets) model id. */
export interface ModelChoice {
  preset: string;
  model: string;
}

export interface RunSettings {
  /** absolute path of the local git repo the run builds against ("" = engine cwd) */
  repo: string;
  /** preset that writes the code (actor role) */
  writer: ModelChoice;
  /** preset that reviews the code (critic role) */
  reviewer: ModelChoice;

  /**
   * Tools kiro-cli is trusted with in headless mode (`--trust-tools=<value>`).
   * Empty falls back to `--trust-all-tools`. Only used by the kiro-cli preset.
   */
  kiroTrustTools: string;

  /** how many tasks run at once */
  maxParallel: number;
  /** isolate each task in its own git worktree */
  worktrees: boolean;
  /** run build/test/lint before the critic reviews */
  mechanicalGate: boolean;

  /** prefix for generated branch names */
  branchPrefix: string;
  /** build a local integration branch but never push */
  dryRun: boolean;
  /** push the integration branch after a clean, verified run */
  pushToRemote: boolean;
  /** git remote to push to */
  remote: string;
  /** target branch to push to ("" = generated integration branch) */
  pushBranch: string;
  /** open a pull request after pushing (needs gh) */
  openPr: boolean;
  /** PR base branch ("" = repo default) */
  prBase: string;
  /** PR title ("" = generated from goal) */
  prTitle: string;
  /** open the PR as a draft */
  prDraft: boolean;
  /** push even if integration/verification failed (unsafe) */
  pushOverride: boolean;

  /**
   * Power-user escape hatch: raw runner-profile JSON. When non-empty it
   * overrides the catalog-derived writer/reviewer runners, and the role ids
   * below pick which profile backs each role.
   */
  advancedRunners: string;
  advancedActor: string;
  advancedCritic: string;
}

const STORAGE_KEY = "loopwright.runSettings.v2";

export const DEFAULT_SETTINGS: RunSettings = {
  repo: "",
  // Writer edits files -> a CLI preset. Reviewer just reads -> Responses is fine.
  writer: { preset: "codex-cli", model: "gpt-5.5" },
  reviewer: { preset: "openai-responses", model: "gpt-5.5" },
  kiroTrustTools: "fs_read,fs_write,execute_bash",
  maxParallel: 2,
  worktrees: true,
  mechanicalGate: true,
  branchPrefix: "loopwright",
  dryRun: false,
  pushToRemote: false,
  remote: "origin",
  pushBranch: "",
  openPr: false,
  prBase: "",
  prTitle: "",
  prDraft: true,
  pushOverride: false,
  advancedRunners: "",
  advancedActor: "",
  advancedCritic: "",
};

export function getPreset(id: string): RunnerPreset | undefined {
  return PRESETS.find((p) => p.id === id);
}

/** True when the choice resolves to a CLI preset that edits files on disk. */
export function editsFiles(choice: ModelChoice): boolean {
  return getPreset(choice.preset)?.editsFiles === true;
}

/**
 * A short, human label for a choice: the model id for presets with a
 * configurable model (e.g. "gpt-5.5"), otherwise the preset label.
 */
export function modelLabel(choice: ModelChoice): string {
  const preset = getPreset(choice.preset);
  if (!preset) return choice.model || "—";
  if (preset.configurableModel) return (choice.model || preset.defaultModel) || preset.label;
  return preset.label;
}

/** The effective model id a choice will run with (falls back to the default). */
export function effectiveModel(choice: ModelChoice): string {
  const preset = getPreset(choice.preset);
  if (!preset) return choice.model;
  return preset.configurableModel ? (choice.model || preset.defaultModel) : preset.defaultModel;
}

/** True when an advanced runner-profile override is active. */
export function usesAdvancedRunners(settings: RunSettings): boolean {
  return settings.advancedRunners.trim() !== "";
}

/** Normalizes a possibly-legacy/partial choice into a valid preset choice. */
function coerceChoice(value: unknown, fallback: ModelChoice): ModelChoice {
  if (value === null || typeof value !== "object") return { ...fallback };
  const v = value as Record<string, unknown>;
  // Tolerate the legacy { provider, model } shape by mapping provider->preset.
  const presetId = typeof v.preset === "string" ? v.preset : typeof v.provider === "string" ? v.provider : "";
  const preset = getPreset(presetId);
  if (!preset) return { ...fallback };
  const model = typeof v.model === "string" ? v.model : "";
  return { preset: preset.id, model };
}

/** Loads saved settings, falling back to defaults and tolerating bad/legacy data. */
export function loadSettings(): RunSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<RunSettings> & Record<string, unknown>;
    const merged: RunSettings = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      writer: coerceChoice(parsed.writer, DEFAULT_SETTINGS.writer),
      reviewer: coerceChoice(parsed.reviewer, DEFAULT_SETTINGS.reviewer),
    };
    const str = (v: unknown, d: string): string => (typeof v === "string" ? v : d);
    const bool = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d);
    merged.repo = str(merged.repo, DEFAULT_SETTINGS.repo);
    merged.kiroTrustTools = str(merged.kiroTrustTools, DEFAULT_SETTINGS.kiroTrustTools);
    merged.maxParallel =
      Number.isFinite(merged.maxParallel) && merged.maxParallel >= 1
        ? Math.floor(merged.maxParallel)
        : DEFAULT_SETTINGS.maxParallel;
    merged.worktrees = bool(merged.worktrees, DEFAULT_SETTINGS.worktrees);
    merged.mechanicalGate = bool(merged.mechanicalGate, DEFAULT_SETTINGS.mechanicalGate);
    merged.branchPrefix = str(merged.branchPrefix, DEFAULT_SETTINGS.branchPrefix);
    merged.dryRun = bool(merged.dryRun, DEFAULT_SETTINGS.dryRun);
    merged.pushToRemote = bool(merged.pushToRemote, DEFAULT_SETTINGS.pushToRemote);
    merged.remote = str(merged.remote, DEFAULT_SETTINGS.remote);
    merged.pushBranch = str(merged.pushBranch, DEFAULT_SETTINGS.pushBranch);
    merged.openPr = bool(merged.openPr, DEFAULT_SETTINGS.openPr);
    merged.prBase = str(merged.prBase, DEFAULT_SETTINGS.prBase);
    merged.prTitle = str(merged.prTitle, DEFAULT_SETTINGS.prTitle);
    merged.prDraft = bool(merged.prDraft, DEFAULT_SETTINGS.prDraft);
    merged.pushOverride = bool(merged.pushOverride, DEFAULT_SETTINGS.pushOverride);
    merged.advancedRunners = str(merged.advancedRunners, DEFAULT_SETTINGS.advancedRunners);
    merged.advancedActor = str(merged.advancedActor, DEFAULT_SETTINGS.advancedActor);
    merged.advancedCritic = str(merged.advancedCritic, DEFAULT_SETTINGS.advancedCritic);
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: RunSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable (private mode / quota) — settings stay in-memory */
  }
}

/** A runner profile as accepted by LOOPWRIGHT_RUNNERS. */
interface RunnerProfile {
  id: string;
  kind: "cli" | "http-responses";
  model: string;
  options: Record<string, unknown>;
}

function profileFor(settings: RunSettings, id: string, choice: ModelChoice): RunnerProfile {
  const preset = getPreset(choice.preset) ?? getPreset(DEFAULT_SETTINGS.writer.preset)!;

  if (preset.id === "kiro-cli") {
    const trust = settings.kiroTrustTools.trim();
    const trustArg = trust ? `--trust-tools=${trust}` : "--trust-all-tools";
    return {
      id,
      kind: "cli",
      model: "",
      options: {
        command: "kiro-cli",
        args: ["chat", "--no-interactive", trustArg, "{{prompt}}"],
        promptVia: "arg",
        // Headless Kiro prints the assistant's answer to stdout; the engine's
        // JSON extraction tolerates surrounding log lines for structured calls.
        output: { mode: "stdout" },
      },
    };
  }

  if (preset.kind === "cli") {
    // codex-cli
    return {
      id,
      kind: "cli",
      model: effectiveModel(choice),
      options: {
        command: "codex",
        args: ["exec", "--json", "--model", "{{model}}", "{{prompt}}"],
        promptVia: "arg",
        output: { mode: "json-stream", textPath: "msg.text", typeField: "type", type: "item.completed" },
      },
    };
  }

  // openai-responses
  return {
    id,
    kind: "http-responses",
    model: effectiveModel(choice),
    options: {
      baseUrl: preset.baseUrl,
      path: preset.path ?? "/responses",
      apiKeyEnv: preset.apiKeyEnv,
    },
  };
}

/**
 * Translates the saved settings into the LOOPWRIGHT_* env the engine expects.
 * The writer backs the actor role, the reviewer backs the critic role. An
 * advanced runner-profile override, when present, wins over the catalog.
 *
 * Note: LOOPWRIGHT_RUNNERS is returned verbatim from `advancedRunners` when set;
 * callers should validate it is JSON before starting a run.
 */
export function buildRunEnv(settings: RunSettings): Record<string, string> {
  let runnersJson: string;
  let actor: string;
  let critic: string;
  if (usesAdvancedRunners(settings)) {
    runnersJson = settings.advancedRunners.trim();
    actor = settings.advancedActor.trim();
    critic = settings.advancedCritic.trim();
  } else {
    runnersJson = JSON.stringify([
      profileFor(settings, "writer", settings.writer),
      profileFor(settings, "reviewer", settings.reviewer),
    ]);
    actor = "writer";
    critic = "reviewer";
  }
  return {
    LOOPWRIGHT_RUNNERS: runnersJson,
    LOOPWRIGHT_ACTOR_RUNNER: actor,
    LOOPWRIGHT_CRITIC_RUNNER: critic,
    LOOPWRIGHT_MAX_PARALLEL: String(settings.maxParallel),
    LOOPWRIGHT_USE_WORKTREES: settings.worktrees ? "true" : "false",
    LOOPWRIGHT_MECHANICAL_GATE: settings.mechanicalGate ? "true" : "false",
    LOOPWRIGHT_BRANCH_PREFIX: settings.branchPrefix.trim() || "loopwright",
    LOOPWRIGHT_DRY_RUN: settings.dryRun ? "true" : "false",
    LOOPWRIGHT_PUSH_TO_REMOTE: settings.pushToRemote ? "true" : "false",
    LOOPWRIGHT_REMOTE: settings.remote.trim() || "origin",
    LOOPWRIGHT_PUSH_BRANCH: settings.pushBranch.trim(),
    LOOPWRIGHT_OPEN_PR: settings.openPr ? "true" : "false",
    LOOPWRIGHT_PR_BASE: settings.prBase.trim(),
    LOOPWRIGHT_PR_TITLE: settings.prTitle.trim(),
    LOOPWRIGHT_PR_DRAFT: settings.prDraft ? "true" : "false",
    LOOPWRIGHT_PUSH_OVERRIDE_SAFETY: settings.pushOverride ? "true" : "false",
  };
}
