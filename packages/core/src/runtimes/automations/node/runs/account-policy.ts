import type { PipelineStep, PipelineStepAccountPolicy } from '../../api/deployment';
import type { StepRunRecord } from '../../api/run';

export type AccountResolver = (providerId: string, conversationId?: string | null) => string;

/**
 * Default fallback resolver that extracts account identity from providerId.
 * For example: 'claude-empresa' -> 'claude-empresa', 'gemini-personal' -> 'gemini-personal'.
 */
export function defaultAccountResolver(providerId: string): string {
  return providerId;
}

export type AccountPolicyValidationResult =
  | { valid: true }
  | {
      valid: false;
      error: {
        code: 'account_policy_violation';
        message: string;
      };
    };

/**
 * Validates whether the current step satisfies its accountPolicy relative to
 * the previous steps in the pipeline.
 *
 * Core rule: "El revisor nunca es la misma cuenta que el implementador."
 */
export function validateAccountPolicy(options: {
  step: PipelineStep;
  stepHistory: readonly StepRunRecord[];
  resolveAccount?: AccountResolver;
}): AccountPolicyValidationResult {
  const { step, stepHistory, resolveAccount = defaultAccountResolver } = options;
  const policy: PipelineStepAccountPolicy = step.accountPolicy ?? 'any';

  if (policy === 'any' || stepHistory.length === 0) {
    return { valid: true };
  }

  const currentProviderId = step.agent.start.providerId;
  const currentAccount = resolveAccount(currentProviderId, null);

  if (policy === 'different-from-previous') {
    const lastStep = stepHistory[stepHistory.length - 1];
    if (lastStep) {
      const prevAccount = resolveAccount(lastStep.providerId, lastStep.conversationId);
      if (currentAccount === prevAccount) {
        return {
          valid: false,
          error: {
            code: 'account_policy_violation',
            message: `Account policy violation: Step '${step.name}' (account: ${currentAccount}) must not run on the same account as previous step '${lastStep.name}' (account: ${prevAccount}).`,
          },
        };
      }
    }
  }

  if (policy === 'same-as-first') {
    const firstStep = stepHistory[0];
    if (firstStep) {
      const firstAccount = resolveAccount(firstStep.providerId, firstStep.conversationId);
      if (currentAccount !== firstAccount) {
        return {
          valid: false,
          error: {
            code: 'account_policy_violation',
            message: `Account policy violation: Step '${step.name}' (account: ${currentAccount}) must run on the same account as the first step '${firstStep.name}' (account: ${firstAccount}).`,
          },
        };
      }
    }
  }

  return { valid: true };
}
