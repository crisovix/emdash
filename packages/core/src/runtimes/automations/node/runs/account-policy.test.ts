import { describe, expect, it } from 'vitest';
import type { PipelineStep } from '../../api/deployment';
import type { StepRunRecord } from '../../api/run';
import { validateAccountPolicy } from './account-policy';

function createMockStep(
  name: string,
  providerId: string,
  accountPolicy?: PipelineStep['accountPolicy']
): PipelineStep {
  return {
    id: `step-${name}`,
    name,
    gate: 'auto',
    accountPolicy,
    agent: {
      type: 'acp',
      start: {
        providerId,
        model: null,
        initialQueue: [{ text: 'do something' }],
      },
    },
  };
}

function createMockRecord(stepIndex: number, name: string, providerId: string): StepRunRecord {
  return {
    stepIndex,
    stepId: `step-${name}`,
    name,
    providerId,
    conversationId: `conv-${stepIndex}`,
    sessionId: `session-${stepIndex}`,
    status: 'done',
    startedAt: 1000 + stepIndex * 100,
    finishedAt: 1050 + stepIndex * 100,
  };
}

describe('validateAccountPolicy', () => {
  it('allows any account when policy is "any" or unset', () => {
    const step = createMockStep('Implementer', 'claude-empresa');
    const result = validateAccountPolicy({
      step,
      stepHistory: [createMockRecord(0, 'Planner', 'claude-empresa')],
    });
    expect(result.valid).toBe(true);
  });

  it('rejects same account when policy is "different-from-previous"', () => {
    const step = createMockStep('Reviewer', 'claude-empresa', 'different-from-previous');
    const result = validateAccountPolicy({
      step,
      stepHistory: [createMockRecord(0, 'Implementer', 'claude-empresa')],
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe('account_policy_violation');
      expect(result.error.message).toContain('must not run on the same account');
    }
  });

  it('allows different account when policy is "different-from-previous"', () => {
    const step = createMockStep('Reviewer', 'claude-personal', 'different-from-previous');
    const result = validateAccountPolicy({
      step,
      stepHistory: [createMockRecord(0, 'Implementer', 'claude-empresa')],
    });
    expect(result.valid).toBe(true);
  });

  it('allows different provider when policy is "different-from-previous" (e.g. Gemini reviewer for Claude implementer)', () => {
    const step = createMockStep('Reviewer', 'gemini-empresa', 'different-from-previous');
    const result = validateAccountPolicy({
      step,
      stepHistory: [createMockRecord(0, 'Implementer', 'claude-empresa')],
    });
    expect(result.valid).toBe(true);
  });

  it('enforces "same-as-first" policy correctly', () => {
    const stepMatch = createMockStep('Finalizer', 'claude-empresa', 'same-as-first');
    const stepMismatch = createMockStep('Finalizer', 'claude-personal', 'same-as-first');

    const history = [
      createMockRecord(0, 'Planner', 'claude-empresa'),
      createMockRecord(1, 'Implementer', 'gemini-empresa'),
    ];

    expect(validateAccountPolicy({ step: stepMatch, stepHistory: history }).valid).toBe(true);
    expect(validateAccountPolicy({ step: stepMismatch, stepHistory: history }).valid).toBe(false);
  });
});
