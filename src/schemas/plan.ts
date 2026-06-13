import { z } from "zod";

/**
 * A single unit of work the actor builds and the critic reviews.
 * `verifyCommands` is the machine-checkable definition-of-done for the
 * mechanical gate; the task is never GREEN without these passing.
 */
export const TaskSpecSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(""),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  verifyCommands: z.array(z.string().min(1)).default([]),
  dependencies: z.array(z.string()).default([]),
});

export type TaskSpec = z.infer<typeof TaskSpecSchema>;

/** The decomposition the actor drafts and the critic reviews before any building. */
export const PlanSchema = z.object({
  goal: z.string().min(1),
  tasks: z.array(TaskSpecSchema).min(1),
});

export type Plan = z.infer<typeof PlanSchema>;
