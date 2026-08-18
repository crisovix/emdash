import { ok, type Result } from '@emdash/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostFileRef } from '#primitives/path/api';
import type { StoreHandle } from '#primitives/sqlite-store/api';
import type { AutomationDeployment } from '../../api/deployment';
import { automationRunConfigSnapshotSchema } from '../../api/deployment';
import type { AutomationRun } from '../../api/run';
import { AutomationRunStore } from '../persistence/run-store';
import { automationsStore, type AutomationsDb } from '../persistence/store';
import type { AutomationPortError } from '../ports/port-error';
import type { AutomationSessionPort } from '../ports/session-start';
import type {
  AutomationWorkspacePort,
  AutomationWorkspaceResult,
} from '../ports/workspace-provisioning';
import { createAutomationRunExecutor } from './executor';
import { AutomationRunTransitions } from './transitions';

const worktree: HostFileRef = {
  host: { type: 'local', id: 'local' },
  path: { root: { kind: 'posix' }, segments: ['tmp', 'pipeline-wt-1'] },
};

function claimedRun(
  handle: StoreHandle<AutomationsDb>,
  deployment: AutomationDeployment
): AutomationRun {
  const store = new AutomationRunStore(handle);
  return store.insertRun({
    id: 'run-pipe-1',
    automationId: deployment.automationId,
    status: 'provisioning_workspace',
    triggerKind: 'manual',
    configSnapshot: automationRunConfigSnapshotSchema.parse(deployment),
    generatedName: 'pipeline-run-1',
    scheduledAt: null,
    deadlineAt: null,
    startedAt: 1000,
    finishedAt: null,
    workspace: null,
    branchName: null,
    conversationId: null,
    sessionId: null,
    error: null,
  })!;
}

function createMultiStepPipelineDeployment(
  overrides?: Partial<AutomationDeployment>
): AutomationDeployment {
  return {
    automationId: 'auto-pipe-1',
    revision: 1,
    enabled: true,
    name: 'Multi-Agent Feature Pipeline',
    schedule: { expr: '0 0 * * *', tz: 'UTC' },
    steps: [
      {
        id: 'step-1-plan',
        name: 'Plan with Claude Opus',
        gate: 'auto',
        agent: {
          type: 'acp',
          start: {
            providerId: 'claude-empresa',
            model: 'claude-3-7-opus',
            initialQueue: [{ text: 'Plan implementation in docs/plan.md' }],
          },
        },
      },
      {
        id: 'step-2-exec',
        name: 'Execute with Gemini Pro',
        gate: 'auto',
        agent: {
          type: 'acp',
          start: {
            providerId: 'gemini-empresa',
            model: 'gemini-2.5-pro',
            initialQueue: [{ text: 'Implement code according to docs/plan.md' }],
          },
        },
      },
      {
        id: 'step-3-review',
        name: 'Review with Claude Personal',
        gate: 'auto',
        accountPolicy: 'different-from-previous',
        agent: {
          type: 'acp',
          start: {
            providerId: 'claude-personal',
            model: null,
            initialQueue: [{ text: 'Review git diff and check tests' }],
          },
        },
      },
    ],

    workspace: {
      kind: 'directory',
      path: worktree,
    },
    ...overrides,
  };
}

describe('Multi-Agent Pipeline Executor', () => {
  let handle: StoreHandle<AutomationsDb>;
  let runStore: AutomationRunStore;
  let transitions: AutomationRunTransitions;

  beforeEach(async () => {
    handle = await automationsStore.openTemp();
    runStore = new AutomationRunStore(handle);
    transitions = new AutomationRunTransitions({ runStore });
  });

  afterEach(async () => {
    await handle.close();
  });

  it('executes all 3 pipeline steps sequentially on the same worktree', async () => {
    const deployment = createMultiStepPipelineDeployment();
    const run = claimedRun(handle, deployment);

    const startedSessions: Array<{ conversationId: string; cwd: HostFileRef; providerId: string }> =
      [];

    const workspacePort: AutomationWorkspacePort = {
      provision: vi.fn(
        async (): Promise<Result<AutomationWorkspaceResult, AutomationPortError>> => {
          return ok({ workspace: worktree, branchName: 'feature-pipeline' });
        }
      ),
    };

    let sessionCounter = 0;
    const sessionPort: AutomationSessionPort = {
      start: vi.fn(async (input) => {
        sessionCounter++;
        startedSessions.push({
          conversationId: input.conversationId,
          cwd: input.cwd,
          providerId: input.agent.start.providerId,
        });
        return ok({ sessionId: `session-${sessionCounter}` });
      }),
    };

    let convCounter = 0;
    const executor = createAutomationRunExecutor({
      transitions,
      workspacePort,
      sessionPort,
      createConversationId: () => `conv-${++convCounter}`,
    });

    await executor(run, new AbortController().signal);

    const final = runStore.getRun('run-pipe-1')!;
    expect(final.status).toBe('done');
    expect(final.stepHistory).toHaveLength(3);

    // Verify all 3 steps ran in order
    expect(final.stepHistory?.[0].name).toBe('Plan with Claude Opus');
    expect(final.stepHistory?.[0].providerId).toBe('claude-empresa');
    expect(final.stepHistory?.[0].conversationId).toBe('conv-1');

    expect(final.stepHistory?.[1].name).toBe('Execute with Gemini Pro');
    expect(final.stepHistory?.[1].providerId).toBe('gemini-empresa');
    expect(final.stepHistory?.[1].conversationId).toBe('conv-2');

    expect(final.stepHistory?.[2].name).toBe('Review with Claude Personal');
    expect(final.stepHistory?.[2].providerId).toBe('claude-personal');
    expect(final.stepHistory?.[2].conversationId).toBe('conv-3');

    // All steps executed on the same worktree
    expect(startedSessions).toHaveLength(3);
    for (const session of startedSessions) {
      expect(session.cwd).toEqual(worktree);
    }
  });

  it('pauses at awaiting_gate when a step has gate: manual_approval and resumes on approval', async () => {
    const deployment = createMultiStepPipelineDeployment({
      steps: [
        {
          id: 'step-1-plan',
          name: 'Plan with Claude Opus',
          gate: 'manual_approval', // gate after planning
          agent: {
            type: 'acp',
            start: {
              providerId: 'claude-empresa',
              model: null,
              initialQueue: [{ text: 'Plan in docs/plan.md' }],
            },
          },
        },
        {
          id: 'step-2-exec',
          name: 'Execute with Gemini Pro',
          gate: 'auto',
          agent: {
            type: 'acp',
            start: {
              providerId: 'gemini-empresa',
              model: null,
              initialQueue: [{ text: 'Execute code' }],
            },
          },
        },
      ],
    });

    const run = claimedRun(handle, deployment);

    const workspacePort: AutomationWorkspacePort = {
      provision: vi.fn(async () => ok({ workspace: worktree, branchName: 'feature-pipeline' })),
    };

    let sessionCount = 0;
    const sessionPort: AutomationSessionPort = {
      start: vi.fn(async () => ok({ sessionId: `session-${++sessionCount}` })),
    };

    let convCounter = 0;
    const executor = createAutomationRunExecutor({
      transitions,
      workspacePort,
      sessionPort,
      createConversationId: () => `conv-${++convCounter}`,
    });

    // Run first stage
    await executor(run, new AbortController().signal);

    const midway = runStore.getRun('run-pipe-1')!;
    expect(midway.status).toBe('awaiting_gate');
    expect(midway.currentStepIndex).toBe(0);
    expect(midway.stepHistory).toHaveLength(1);
    expect(sessionPort.start).toHaveBeenCalledTimes(1);

    // User approves the gate
    const updated = transitions.approveGate(run.id, 1)!;
    expect(updated.status).toBe('starting_session');
    expect(updated.currentStepIndex).toBe(1);

    // Resume execution
    await executor(updated, new AbortController().signal);

    const final = runStore.getRun('run-pipe-1')!;
    expect(final.status).toBe('done');
    expect(final.stepHistory).toHaveLength(2);
    expect(sessionPort.start).toHaveBeenCalledTimes(2);
  });

  it('enforces accountPolicy different-from-previous: fails if reviewer has same account as implementer', async () => {
    const deployment = createMultiStepPipelineDeployment({
      steps: [
        {
          id: 'step-1-exec',
          name: 'Implementer',
          gate: 'auto',
          agent: {
            type: 'acp',
            start: {
              providerId: 'claude-empresa',
              model: null,
              initialQueue: [{ text: 'Write code' }],
            },
          },
        },
        {
          id: 'step-2-review',
          name: 'Reviewer',
          gate: 'auto',
          accountPolicy: 'different-from-previous',
          agent: {
            type: 'acp',
            start: {
              // Same account as implementer -> MUST FAIL POLICY
              providerId: 'claude-empresa',
              model: null,
              initialQueue: [{ text: 'Review code' }],
            },
          },
        },
      ],
    });

    const run = claimedRun(handle, deployment);

    const workspacePort: AutomationWorkspacePort = {
      provision: vi.fn(async () => ok({ workspace: worktree, branchName: 'feature-pipeline' })),
    };

    const sessionPort: AutomationSessionPort = {
      start: vi.fn(async () => ok({ sessionId: 'session-1' })),
    };

    const executor = createAutomationRunExecutor({
      transitions,
      workspacePort,
      sessionPort,
    });

    await executor(run, new AbortController().signal);

    const final = runStore.getRun('run-pipe-1')!;
    expect(final.status).toBe('failed');
    expect(final.error?.step).toBe('account_policy');
    expect(final.error?.code).toBe('account_policy_violation');
    expect(final.error?.message).toContain('must not run on the same account');
  });
});
