import { err, ok } from '@emdash/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostFileRef } from '#primitives/path/api';
import type { StoreHandle } from '#primitives/sqlite-store/api';
import { automationRunConfigSnapshotSchema, type AutomationDeployment } from '../../api/deployment';
import type { AutomationRun } from '../../api/run';
import { AutomationRunStore } from '../persistence/run-store';
import { automationsStore, type AutomationsDb } from '../persistence/store';
import type { AutomationSessionPort } from '../ports/session-start';
import type { AutomationWorkspacePort } from '../ports/workspace-provisioning';
import { createAutomationRunExecutor } from './executor';
import { defaultFailoverResolver, isRateLimitError } from './failover';
import { AutomationRunTransitions } from './transitions';

const worktree: HostFileRef = {
  host: { type: 'local', id: 'local' },
  path: { root: { kind: 'posix' }, segments: ['tmp', 'failover-wt-1'] },
};

function claimedRun(
  handle: StoreHandle<AutomationsDb>,
  deployment: AutomationDeployment
): AutomationRun {
  const store = new AutomationRunStore(handle);
  return store.insertRun({
    id: 'run-failover-1',
    automationId: deployment.automationId,
    status: 'provisioning_workspace',
    triggerKind: 'manual',
    configSnapshot: automationRunConfigSnapshotSchema.parse(deployment),
    generatedName: 'failover-run-1',
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

describe('In-Flight Failover & Auto-Recovery', () => {
  describe('isRateLimitError', () => {
    it('detects standard rate limit codes and message patterns', () => {
      expect(isRateLimitError({ code: 'rate_limit' })).toBe(true);
      expect(isRateLimitError({ code: 'rate_limited' })).toBe(true);
      expect(isRateLimitError({ code: 'quota_exhausted' })).toBe(true);
      expect(isRateLimitError({ code: '429' })).toBe(true);
      expect(isRateLimitError({ message: 'Rate limit exceeded for organization' })).toBe(true);
      expect(isRateLimitError({ message: 'Usage limit reached. Try again in 4 hours' })).toBe(true);
      expect(isRateLimitError({ message: '429 Too Many Requests' })).toBe(true);
      expect(isRateLimitError({ code: 'unauthorized', message: 'Invalid token' })).toBe(false);
      expect(isRateLimitError({ code: 'network_error', message: 'ECONNREFUSED' })).toBe(false);
    });
  });

  describe('defaultFailoverResolver', () => {
    it('picks paired backup account when failing account is rate limited', () => {
      const backup = defaultFailoverResolver({
        failingProviderId: 'claude-empresa',
        step: {
          id: 's1',
          name: 'Step 1',
          gate: 'auto',
          agent: {
            type: 'acp',
            start: {
              providerId: 'claude-empresa',
              model: null,
              initialQueue: [{ text: 'prompt' }],
            },
          },
        },
        stepHistory: [],
        attemptedProviderIds: new Set(['claude-empresa']),
      });
      expect(backup).toBe('claude-personal');
    });

    it('returns null when all candidates have already been attempted', () => {
      const backup = defaultFailoverResolver({
        failingProviderId: 'claude-empresa',
        step: {
          id: 's1',
          name: 'Step 1',
          gate: 'auto',
          agent: {
            type: 'acp',
            start: {
              providerId: 'claude-empresa',
              model: null,
              initialQueue: [{ text: 'prompt' }],
            },
          },
        },
        stepHistory: [],
        attemptedProviderIds: new Set(['claude-empresa', 'claude-personal', 'claude']),
      });
      expect(backup).toBeNull();
    });
  });

  describe('Executor In-Flight Failover Retry', () => {
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

    it('automatically catches 429 rate limit, fails over to backup account, and completes run', async () => {
      const deployment: AutomationDeployment = {
        automationId: 'auto-failover-test',
        revision: 1,
        enabled: true,
        name: 'Failover Automation',
        schedule: { expr: '0 0 * * *', tz: 'UTC' },
        steps: [
          {
            id: 'step-1-code',
            name: 'Code Generation',
            gate: 'auto',
            agent: {
              type: 'acp',
              start: {
                providerId: 'claude-empresa',
                model: null,
                initialQueue: [{ text: 'Generate feature code' }],
              },
            },
          },
        ],
        workspace: { kind: 'directory', path: worktree },
      };

      const run = claimedRun(handle, deployment);

      const workspacePort: AutomationWorkspacePort = {
        provision: vi.fn(async () => ok({ workspace: worktree, branchName: 'failover-branch' })),
      };

      const attemptedCalls: string[] = [];
      const sessionPort: AutomationSessionPort = {
        start: vi.fn(async (input) => {
          attemptedCalls.push(input.agent.start.providerId);
          if (input.agent.start.providerId === 'claude-empresa') {
            // First attempt with claude-empresa hits Rate Limit (429)
            return err({
              code: 'rate_limited',
              message: 'Claude organization usage limit reached (429)',
            });
          }
          // Second attempt with claude-personal succeeds
          return ok({ sessionId: 'session-failover-success' });
        }),
      };

      const executor = createAutomationRunExecutor({
        transitions,
        workspacePort,
        sessionPort,
      });

      await executor(run, new AbortController().signal);

      const final = runStore.getRun('run-failover-1')!;
      expect(final.status).toBe('done');
      expect(final.sessionId).toBe('session-failover-success');

      // Verify failover happened: first tried claude-empresa, then succeeded with claude-personal
      expect(attemptedCalls).toEqual(['claude-empresa', 'claude-personal']);
      expect(final.stepHistory?.[0].providerId).toBe('claude-personal');
      expect(final.stepHistory?.[0].status).toBe('done');
    });
  });
});
