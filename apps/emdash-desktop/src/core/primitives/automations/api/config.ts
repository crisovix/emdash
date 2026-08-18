import { defineVersionedSchema } from '@emdash/core/primitives/versioned-schema/api';
import z from 'zod';
import { taskConfig } from '@core/primitives/tasks/api';
import { workspaceConfig } from '@core/primitives/workspaces/api';

export const triggerConfigSchema = z.object({
  expr: z.string(),
  tz: z.string().optional(),
});

export type TriggerConfig = z.infer<typeof triggerConfigSchema>;

export const automationTriggerConfig = defineVersionedSchema()
  .unversioned(triggerConfigSchema)
  .build();

export const pipelineStepConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  providerId: z.string(),
  prompt: z.string(),
  gate: z.enum(['auto', 'manual_approval']).default('auto'),
  accountPolicy: z.enum(['any', 'different-from-previous', 'same-as-first']).optional(),
  model: z.string().optional(),
});

export type PipelineStepConfig = z.infer<typeof pipelineStepConfigSchema>;

export const conversationConfigSchema = z.object({
  prompt: z.string(),
  provider: z.string(),
  title: z.string().optional(),
  autoApprove: z.boolean(),
  /** Model to pass to the agent CLI. Absent or empty string means use the CLI default. */
  model: z.string().optional(),
  /** Conversation transport: 'pty' for terminal or 'acp' for structured chat UI. */
  type: z.enum(['pty', 'acp']).optional(),
  /** Multi-agent pipeline steps executed sequentially in the same worktree. */
  pipelineSteps: z.array(pipelineStepConfigSchema).optional(),
});

export type ConversationConfig = z.infer<typeof conversationConfigSchema>;

export const automationConversationConfig = defineVersionedSchema()
  .unversioned(conversationConfigSchema)
  .build();

const storedAutomationTaskConfigV1Schema = z.object({
  version: z.literal('1'),
  taskConfig: taskConfig.asNested(),
  workspaceConfig: workspaceConfig.asNested(),
});

export const storedAutomationTaskConfig = defineVersionedSchema()
  .initial('1', storedAutomationTaskConfigV1Schema)
  .build();

export const storedAutomationTaskConfigSchema = storedAutomationTaskConfig.schema;
export type StoredAutomationTaskConfig = typeof storedAutomationTaskConfig.Type;
