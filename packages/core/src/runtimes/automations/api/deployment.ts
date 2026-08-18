import { z } from 'zod';
import { hostAbsolutePathSchema, hostFileRefSchema } from '#primitives/path/api';
import {
  acpSessionStartInputSchema,
  tuiSessionStartInputSchema,
} from '#services/session-start/api';

const nonBlankStringSchema = z.string().trim().min(1);

export const automationIdSchema = z.string().min(1);

export const automationGitRemoteSchema = z.object({
  name: nonBlankStringSchema,
  url: nonBlankStringSchema,
});

export const automationGitBranchRefSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('local'),
    branch: nonBlankStringSchema,
    remote: automationGitRemoteSchema.optional(),
  }),
  z.object({
    type: z.literal('remote'),
    branch: nonBlankStringSchema,
    remote: automationGitRemoteSchema,
  }),
]);

export const automationWorktreeConfigSchema = z.object({
  kind: z.literal('worktree'),
  repository: hostFileRefSchema,
  worktreePoolPath: hostAbsolutePathSchema,
  baseRemote: nonBlankStringSchema,
  preservePatterns: z.array(nonBlankStringSchema),
  git: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('create-branch'),
      fromBranch: automationGitBranchRefSchema,
      pushRemote: nonBlankStringSchema.nullable(),
    }),
    z.object({
      kind: z.literal('use-branch'),
      branchName: nonBlankStringSchema,
    }),
  ]),
});

export const automationDirectoryConfigSchema = z.object({
  kind: z.literal('directory'),
  path: hostFileRefSchema,
});

export const automationWorkspaceConfigSchema = z.discriminatedUnion('kind', [
  automationWorktreeConfigSchema,
  automationDirectoryConfigSchema,
]);

export const automationScheduleSchema = z.object({
  expr: z.string().trim().min(1),
  tz: z.string().trim().min(1),
});

export const automationAcpAgentConfigSchema = z.object({
  type: z.literal('acp'),
  start: acpSessionStartInputSchema.omit({
    conversationId: true,
    cwd: true,
    sessionId: true,
  }),
  title: nonBlankStringSchema.optional(),
});

export const automationTuiAgentConfigSchema = z.object({
  type: z.literal('tui'),
  start: tuiSessionStartInputSchema.omit({
    conversationId: true,
    cwd: true,
    sessionId: true,
    cols: true,
    rows: true,
  }),
  title: nonBlankStringSchema.optional(),
});

export const automationAgentConfigSchema = z.discriminatedUnion('type', [
  automationAcpAgentConfigSchema,
  automationTuiAgentConfigSchema,
]);

export const pipelineStepGateSchema = z.enum(['auto', 'manual_approval']);
export const pipelineStepAccountPolicySchema = z.enum([
  'any',
  'different-from-previous',
  'same-as-first',
]);

export const pipelineStepSchema = z.object({
  id: nonBlankStringSchema,
  name: nonBlankStringSchema,
  agent: automationAgentConfigSchema,
  gate: pipelineStepGateSchema.default('auto'),
  accountPolicy: pipelineStepAccountPolicySchema.optional(),
});

export const automationDeploymentSchema = z
  .object({
    automationId: automationIdSchema,
    revision: z.number().int().positive(),
    enabled: z.boolean(),
    name: nonBlankStringSchema,
    schedule: automationScheduleSchema,
    agent: automationAgentConfigSchema.optional(),
    steps: z.array(pipelineStepSchema).min(1).optional(),
    workspace: automationWorkspaceConfigSchema,
  })
  .refine((data) => Boolean(data.agent || (data.steps && data.steps.length > 0)), {
    message: 'Either `agent` or `steps` must be provided',
  });

export const automationRunConfigSnapshotSchema = z.object({
  name: nonBlankStringSchema,
  schedule: automationScheduleSchema,
  agent: automationAgentConfigSchema.optional(),
  steps: z.array(pipelineStepSchema).min(1).optional(),
  workspace: automationWorkspaceConfigSchema,
});

export function resolveDeploymentSteps(
  deployment: Pick<AutomationDeployment, 'name'> & {
    agent?: AutomationAgentConfig;
    steps?: PipelineStep[];
  }
): PipelineStep[] {
  if (deployment.steps && deployment.steps.length > 0) {
    return deployment.steps;
  }
  if (deployment.agent) {
    return [
      {
        id: 'step-0',
        name: deployment.name,
        agent: deployment.agent,
        gate: 'auto',
      },
    ];
  }
  throw new Error('Deployment must have either `agent` or `steps`');
}

export type AutomationId = z.infer<typeof automationIdSchema>;
export type AutomationGitRemote = z.infer<typeof automationGitRemoteSchema>;
export type AutomationGitBranchRef = z.infer<typeof automationGitBranchRefSchema>;
export type AutomationWorktreeConfig = z.infer<typeof automationWorktreeConfigSchema>;
export type AutomationDirectoryConfig = z.infer<typeof automationDirectoryConfigSchema>;
export type AutomationWorkspaceConfig = z.infer<typeof automationWorkspaceConfigSchema>;
export type AutomationSchedule = z.infer<typeof automationScheduleSchema>;
export type AutomationAcpAgentConfig = z.infer<typeof automationAcpAgentConfigSchema>;
export type AutomationTuiAgentConfig = z.infer<typeof automationTuiAgentConfigSchema>;
export type AutomationAgentConfig = z.infer<typeof automationAgentConfigSchema>;
export type PipelineStepGate = z.infer<typeof pipelineStepGateSchema>;
export type PipelineStepAccountPolicy = z.infer<typeof pipelineStepAccountPolicySchema>;
export type PipelineStep = z.infer<typeof pipelineStepSchema>;
export type AutomationDeployment = z.infer<typeof automationDeploymentSchema>;
export type AutomationRunConfigSnapshot = z.infer<typeof automationRunConfigSnapshotSchema>;
