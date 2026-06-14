/**
 * Run settings + the model catalog.
 *
 * The engine itself is vendor-neutral: a run is configured purely by env vars
 * (LOOPWRIGHT_RUNNERS + role bindings). This module is the UI-side source of
 * truth that turns a friendly "which model writes / which model reviews"
 * choice into those env vars, and remembers the user's choice between runs.
 *
 * Models are grouped by the *environment key* (API key env var) that unlocks
 * them, so the Secrets view can show exactly what each key enables and the
 * Model-settings view can offer only models the user can actually run.
 */

export interface CatalogModel {
  /** model id sent to the provider (the runner profile's `model`) */
  id: string;
  /** human label shown in the UI */
  label: string;
}

export interface Provider {
  /** stable provider id, e.g. "openai" */
  id: string;
  /** display name, e.g. "OpenAI" */
  label: string;
  /** OpenAI-compatible base URL the HttpRunner targets */
  baseUrl: string;
  /** env var name that holds this provider's API key */
  apiKeyEnv: string;
  /** models this key unlocks */
  models: CatalogModel[];
}

/**
 * Real providers and models, keyed by the environment variable that holds the
 * API key. No placeholder/demo entries: every model here is something a user
 * can actually run once the matching key is stored.
 */
export const MODEL_CATALOG: Provider[] = [
  {
    id: "openai",
    label: "OpenAI",
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
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyEnv: "GEMINI_API_KEY",
    models: [
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
      { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
    ],
  },
];

/** A concrete model choice: which provider + which model id. */
export interface ModelChoice {
  provider: string;
  model: string;
}

export interface RunSettings {
  /** label of the repository the run targets (shown on the New run box) */
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

/** Friendly one-line label for a model choice, e.g. "GPT-4o mini · OpenAI". */
export function describeChoice(choice: ModelChoice): string {
  const found = findModel(choice);
  if (!found) return choice.model || "Not selected";
  return `${found.model.label} · ${found.provider.label}`;
}

/** Just the model label, e.g. "GPT-4o mini" (falls back to the raw id). */
export function modelLabel(choice: ModelChoice): string {
  return findModel(choice)?.model.label ?? choice.model ?? "—";
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
  kind: "http";
  model: string;
  options: { baseUrl: string; apiKeyEnv: string };
}

function profileFor(id: string, choice: ModelChoice): RunnerProfile {
  const provider = getProvider(choice.provider) ?? firstProvider;
  return {
    id,
    kind: "http",
    model: choice.model,
    options: { baseUrl: provider.baseUrl, apiKeyEnv: provider.apiKeyEnv },
  };
}

/**
 * Translates the saved settings into the LOOPWRIGHT_* env the engine expects.
 * The writer backs the actor role, the reviewer backs the critic role.
 */
export function buildRunEnv(settings: RunSettings): Record<string, string> {
  const runners: RunnerProfile[] = [
    profileFor("writer", settings.writer),
    profileFor("reviewer", settings.reviewer),
  ];
  return {
    LOOPWRIGHT_RUNNERS: JSON.stringify(runners),
    LOOPWRIGHT_ACTOR_RUNNER: "writer",
    LOOPWRIGHT_CRITIC_RUNNER: "reviewer",
    LOOPWRIGHT_MAX_PARALLEL: String(settings.maxParallel),
    LOOPWRIGHT_USE_WORKTREES: settings.worktrees ? "true" : "false",
    LOOPWRIGHT_MECHANICAL_GATE: settings.mechanicalGate ? "true" : "false",
  };
}
