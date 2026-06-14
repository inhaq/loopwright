/**
 * Run settings + the model catalog.
 *
 * The engine itself is vendor-neutral: a run is configured purely by env vars
 * (LOOPWRIGHT_RUNNERS + role bindings + publishing flags) plus an optional
 * repo path. This module is the UI-side source of truth that turns a friendly
 * "which model writes / which model reviews" choice into those env vars, and
 * remembers every run-shaping preference between runs so the New run screen can
 * stay a minimal goal box while nothing is lost.
 *
 * HTTP models are grouped by the *environment key* (API key env var) that
 * unlocks them; CLI agents (Codex, Kiro) are grouped by the local command that
 * must be installed. CLI actors are the ones that actually edit files on disk —
 * HTTP runners only return a diff the engine does not apply.
 */

export type ProviderKind = "http" | "cli";

export interface CatalogModel {
  /** model id sent to the provider (the runner profile's `model`) */
  id: string;
  /** human label shown in the UI */
  label: string;
}

export interface Provider {
  /** stable provider id, e.g. "openai" or "codex" */
  id: string;
  /** display name, e.g. "OpenAI" */
  label: string;
  kind: ProviderKind;
  /** http: OpenAI-compatible base URL the HttpRunner targets */
  baseUrl?: string;
  /** http: env var name that holds this provider's API key */
  apiKeyEnv?: string;
  /** cli: the command that must be on PATH (used for install detection) */
  command?: string;
  /** true for CLI actors that edit files directly (can produce real changes) */
  editsFiles?: boolean;
  /** models this provider offers */
  models: CatalogModel[];
}

/**
 * Real providers and models. HTTP providers are keyed by the environment
 * variable that holds the API key; CLI providers are local file-editing agents.
 * No placeholder/demo entries: every option here is something a user can
 * actually run once the matching key is stored or the command is installed.
 */
export const MODEL_CATALOG: Provider[] = [
  {
    id: "openai",
    label: "OpenAI",
    kind: "http",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    models: [
      { id: "gpt-4o", label: "GPT-4o" },
      { id: "gpt-4o-mini", label: "GPT-4o mini" },
      { id: "gpt-4.1", label: "GPT-4.1" },
      { id: "gpt-4.1-mini", label: "GPT-4.1 mini" },
      { id: "o3", label: "o3" },
      { id: "o4-mini", label: "o4-mini" },
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    kind: "http",
    baseUrl: "https://api.anthropic.com/v1",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    models: [
      { id: "claude-3-7-sonnet-latest", label: "Claude 3.7 Sonnet" },
      { id: "claude-3-5-sonnet-latest", label: "Claude 3.5 Sonnet" },
      { id: "claude-3-5-haiku-latest", label: "Claude 3.5 Haiku" },
    ],
  },
  {
    id: "google",
    label: "Google",
    kind: "http",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyEnv: "GEMINI_API_KEY",
    models: [
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
      { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
    ],
  },
  {
    id: "codex",
    label: "Codex CLI",
    kind: "cli",
    command: "codex",
    editsFiles: true,
    models: [{ id: "codex", label: "Codex (edits files)" }],
  },
  {
    id: "kiro",
    label: "Kiro CLI",
    kind: "cli",
    command: "kiro",
    editsFiles: true,
    models: [{ id: "kiro", label: "Kiro (edits files)" }],
  },
];

/** A concrete model choice: which provider + which model id. */
export interface ModelChoice {
  provider: string;
  model: string;
}

export interface RunSettings {
  /** absolute path of the local git repo the run builds against ("" = engine cwd) */
  repo: string;
  /** model that writes the code (actor role) */
  writer: ModelChoice;
  /** model that reviews the code (critic role) */
  reviewer: ModelChoice;

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

const STORAGE_KEY = "loopwright.runSettings.v1";

/** First provider that has at least one model — the baseline for defaults. */
const firstProvider = MODEL_CATALOG[0]!;

export const DEFAULT_SETTINGS: RunSettings = {
  repo: "",
  writer: { provider: firstProvider.id, model: "gpt-4o-mini" },
  reviewer: { provider: firstProvider.id, model: "gpt-4o" },
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

export function getProvider(id: string): Provider | undefined {
  return MODEL_CATALOG.find((p) => p.id === id);
}

export function findModel(choice: ModelChoice): { provider: Provider; model: CatalogModel } | undefined {
  const provider = getProvider(choice.provider);
  if (!provider) return undefined;
  const model = provider.models.find((m) => m.id === choice.model);
  if (!model) return undefined;
  return { provider, model };
}

/** True when the choice resolves to a CLI agent that edits files on disk. */
export function editsFiles(choice: ModelChoice): boolean {
  return getProvider(choice.provider)?.editsFiles === true;
}

/** Just the model label, e.g. "GPT-4o mini" (falls back to the raw id). */
export function modelLabel(choice: ModelChoice): string {
  return findModel(choice)?.model.label ?? choice.model ?? "—";
}

/** True when an advanced runner-profile override is active. */
export function usesAdvancedRunners(settings: RunSettings): boolean {
  return settings.advancedRunners.trim() !== "";
}

/** Loads saved settings, falling back to defaults and tolerating bad/legacy data. */
export function loadSettings(): RunSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<RunSettings>;
    const merged: RunSettings = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      writer: { ...DEFAULT_SETTINGS.writer, ...(parsed.writer ?? {}) },
      reviewer: { ...DEFAULT_SETTINGS.reviewer, ...(parsed.reviewer ?? {}) },
    };
    // Drop selections that no longer exist in the catalog so the UI never shows
    // a stale/removed model as active.
    if (!findModel(merged.writer)) merged.writer = { ...DEFAULT_SETTINGS.writer };
    if (!findModel(merged.reviewer)) merged.reviewer = { ...DEFAULT_SETTINGS.reviewer };
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
  kind: ProviderKind;
  model: string;
  options: Record<string, unknown>;
}

function profileFor(id: string, choice: ModelChoice): RunnerProfile {
  const provider = getProvider(choice.provider) ?? firstProvider;
  if (provider.kind === "cli") {
    if (provider.id === "kiro") {
      return {
        id,
        kind: "cli",
        model: "",
        options: { command: "kiro", args: ["--headless", "--prompt", "{{prompt}}"], promptVia: "arg", output: { mode: "last-line" } },
      };
    }
    // Codex (default CLI shape)
    return {
      id,
      kind: "cli",
      model: "",
      options: {
        command: "codex",
        args: ["exec", "--json", "{{prompt}}"],
        promptVia: "arg",
        output: { mode: "json-stream", textPath: "msg.text", typeField: "type", type: "item.completed" },
      },
    };
  }
  return {
    id,
    kind: "http",
    model: choice.model,
    options: { baseUrl: provider.baseUrl, apiKeyEnv: provider.apiKeyEnv },
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
    runnersJson = JSON.stringify([profileFor("writer", settings.writer), profileFor("reviewer", settings.reviewer)]);
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
