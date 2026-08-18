import type { AutomationAgentConfig, PipelineStep } from '../../api/deployment';
import type { StepRunRecord } from '../../api/run';
import { validateAccountPolicy, type AccountResolver } from './account-policy';

export type FailoverContext = {
  failingProviderId: string;
  step: PipelineStep;
  stepHistory: readonly StepRunRecord[];
  attemptedProviderIds: ReadonlySet<string>;
  resolveAccount?: AccountResolver;
};

export type FailoverResolver = (context: FailoverContext) => string | null;

/** Known paired account pool profiles that can seamlessly failover to one another. */
const DEFAULT_ACCOUNT_POOL_PAIRS: Record<string, readonly string[]> = {
  'claude-empresa': ['claude-personal', 'claude'],
  'claude-personal': ['claude-empresa', 'claude'],
  claude: ['claude-personal', 'claude-empresa'],
  'gemini-empresa': ['gemini-personal', 'gemini'],
  'gemini-personal': ['gemini-empresa', 'gemini'],
  gemini: ['gemini-personal', 'gemini-empresa'],
};

export function isRateLimitError(error: { code?: string; message?: string }): boolean {
  const code = (error.code ?? '').toLowerCase();
  const msg = (error.message ?? '').toLowerCase();

  return (
    code === 'rate_limit' ||
    code === 'rate_limited' ||
    code === 'rate_limit_exceeded' ||
    code === 'quota_exhausted' ||
    code === '429' ||
    code === 'too_many_requests' ||
    msg.includes('rate limit') ||
    msg.includes('rate_limit') ||
    msg.includes('429') ||
    msg.includes('quota exceeded') ||
    msg.includes('usage limit') ||
    msg.includes('too many requests') ||
    msg.includes('overloaded') ||
    msg.includes('exhausted your quota')
  );
}

export function defaultFailoverResolver(context: FailoverContext): string | null {
  const candidates = DEFAULT_ACCOUNT_POOL_PAIRS[context.failingProviderId] ?? [];

  for (const candidate of candidates) {
    if (context.attemptedProviderIds.has(candidate)) continue;

    const candidateAgent: AutomationAgentConfig =
      context.step.agent.type === 'acp'
        ? {
            ...context.step.agent,
            start: {
              ...context.step.agent.start,
              providerId: candidate,
            },
          }
        : {
            ...context.step.agent,
            start: {
              ...context.step.agent.start,
              providerId: candidate,
            },
          };

    const candidateStep: PipelineStep = {
      ...context.step,
      agent: candidateAgent,
    };

    const policyCheck = validateAccountPolicy({
      step: candidateStep,
      stepHistory: context.stepHistory,
      resolveAccount: context.resolveAccount,
    });

    if (policyCheck.valid) {
      return candidate;
    }
  }

  return null;
}
