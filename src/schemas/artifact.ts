import { z } from "zod";
import { TaskSpecSchema } from "./plan.js";

/**
 * The standardized bundle handed to the critic for every task review.
 * Deliberately small: a diff + gate output, not the whole repo, to keep the
 * scarce critic calls cheap. All free-text fields are redacted before they
 * reach this struct (see engine/redaction).
 */

export const MechanicalStepResultSchema = z.object({
  command: z.string(),
  exitCode: z.number().int(),
  passed: z.boolean(),
  durationMs: z.number().nonnegative(),
  output: z.string(), // already redacted, may be truncated
});
export type MechanicalStepResult = z.infer<typeof MechanicalStepResultSchema>;

export const MechanicalGateResultSchema = z.object({
  passed: z.boolean(),
  steps: z.array(MechanicalStepResultSchema),
});
export type MechanicalGateResult = z.infer<typeof MechanicalGateResultSchema>;

export const TaskArtifactBundleSchema = z.object({
  task: TaskSpecSchema,
  diff: z.string(), // redacted unified diff
  touchedFiles: z.array(z.string()),
  mechanicalGate: MechanicalGateResultSchema,
  testCommands: z.array(z.string()),
});
export type TaskArtifactBundle = z.infer<typeof TaskArtifactBundleSchema>;
