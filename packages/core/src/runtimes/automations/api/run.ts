import { z } from 'zod';
import { hostFileRefSchema } from '#primitives/path/api';
import { automationIdSchema, automationRunConfigSnapshotSchema } from './deployment';

const nonBlankStringSchema = z.string().trim().min(1);
const nullableTimestampSchema = z.number().int().nonnegative().nullable();

export const automationRunIdSchema = z.string().min(1);

export const automationRunStatuses = [
  'scheduled',
  'queued',
  'provisioning_workspace',
  'starting_session',
  'awaiting_gate',
  'done',
  'failed',
  'skipped',
  'cancelled',
] as const;

export const automationRunStatusSchema = z.enum(automationRunStatuses);

export const automationRunTriggerKindSchema = z.enum(['cron', 'manual']);

export const automationRunErrorStepSchema = z.enum([
  'queue',
  'provision_workspace',
  'start_session',
  'run',
  'gate',
  'account_policy',
]);

export const automationRunErrorSchema = z.object({
  step: automationRunErrorStepSchema,
  code: nonBlankStringSchema,
  message: z.string().optional(),
});

export const stepRunRecordSchema = z.object({
  stepIndex: z.number().int().nonnegative(),
  stepId: nonBlankStringSchema,
  name: nonBlankStringSchema,
  providerId: nonBlankStringSchema,
  conversationId: nonBlankStringSchema,
  sessionId: nonBlankStringSchema.nullable(),
  status: z.enum(['running', 'done', 'failed', 'skipped']),
  startedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative().nullable(),
  error: automationRunErrorSchema.nullable().optional(),
});

export const automationRunSchema = z.object({
  id: automationRunIdSchema,
  seq: z.number().int().positive(),
  automationId: automationIdSchema,
  status: automationRunStatusSchema,
  triggerKind: automationRunTriggerKindSchema,
  configSnapshot: automationRunConfigSnapshotSchema,
  generatedName: nonBlankStringSchema,
  scheduledAt: nullableTimestampSchema,
  deadlineAt: nullableTimestampSchema,
  startedAt: nullableTimestampSchema,
  finishedAt: nullableTimestampSchema,
  workspace: hostFileRefSchema.nullable(),
  branchName: nonBlankStringSchema.nullable(),
  conversationId: nonBlankStringSchema.nullable(),
  sessionId: nonBlankStringSchema.nullable(),
  currentStepIndex: z.number().int().nonnegative().optional(),
  stepHistory: z.array(stepRunRecordSchema).optional(),
  error: automationRunErrorSchema.nullable(),
});

export type AutomationRunId = z.infer<typeof automationRunIdSchema>;
export type AutomationRunStatus = z.infer<typeof automationRunStatusSchema>;
export type AutomationRunTriggerKind = z.infer<typeof automationRunTriggerKindSchema>;
export type AutomationRunErrorStep = z.infer<typeof automationRunErrorStepSchema>;
export type AutomationRunError = z.infer<typeof automationRunErrorSchema>;
export type StepRunRecord = z.infer<typeof stepRunRecordSchema>;
export type AutomationRun = z.infer<typeof automationRunSchema>;
