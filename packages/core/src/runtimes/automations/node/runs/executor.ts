import { randomUUID } from 'node:crypto';
import { resolveDeploymentSteps } from '../../api/deployment';
import type { AutomationRun, StepRunRecord } from '../../api/run';
import type { AutomationPortError } from '../ports/port-error';
import type { AutomationSessionPort } from '../ports/session-start';
import type { AutomationWorkspacePort } from '../ports/workspace-provisioning';
import { validateAccountPolicy, type AccountResolver } from './account-policy';
import { defaultFailoverResolver, isRateLimitError, type FailoverResolver } from './failover';
import type { AutomationRunTransitions } from './transitions';

export type AutomationRunExecutorOptions = {
  transitions: AutomationRunTransitions;
  workspacePort: AutomationWorkspacePort;
  sessionPort: AutomationSessionPort;
  createConversationId?: () => string;
  resolveAccount?: AccountResolver;
  resolveFailover?: FailoverResolver;
};

export type AutomationRunExecutor = (run: AutomationRun, signal: AbortSignal) => Promise<void>;

export function createAutomationRunExecutor(
  options: AutomationRunExecutorOptions
): AutomationRunExecutor {
  const {
    transitions,
    workspacePort,
    sessionPort,
    createConversationId = randomUUID,
    resolveAccount,
    resolveFailover = defaultFailoverResolver,
  } = options;

  return async (run: AutomationRun, signal: AbortSignal): Promise<void> => {
    let workspace = run.workspace;
    let branchName = run.branchName;

    if (!workspace) {
      const provisionResult = await workspacePort.provision({
        workspace: run.configSnapshot.workspace,
        generatedName: run.generatedName,
        runId: run.id,
        signal,
      });

      if (!provisionResult.success) {
        transitions.markFailed(
          run.id,
          toRunError('provision_workspace', provisionResult.error),
          Date.now()
        );
        return;
      }

      workspace = provisionResult.data.workspace;
      branchName = provisionResult.data.branchName;
    }

    const steps = resolveDeploymentSteps(run.configSnapshot);
    const startIndex =
      run.status === 'awaiting_gate' && run.currentStepIndex !== undefined
        ? run.currentStepIndex + 1
        : (run.currentStepIndex ?? 0);

    const history: StepRunRecord[] = [...(run.stepHistory ?? [])];

    for (let i = startIndex; i < steps.length; i++) {
      const step = steps[i];
      if (!step) continue;

      // Validate account policy (e.g. 'different-from-previous')
      const policyCheck = validateAccountPolicy({
        step,
        stepHistory: history,
        resolveAccount,
      });

      if (!policyCheck.valid) {
        transitions.markFailed(
          run.id,
          {
            step: 'account_policy',
            code: policyCheck.error.code,
            message: policyCheck.error.message,
          },
          Date.now(),
          { currentStepIndex: i, stepHistory: history }
        );
        return;
      }

      const starting = transitions.markStartingSession(run.id, {
        workspace,
        branchName,
        currentStepIndex: i,
        stepHistory: history,
      });
      if (!starting) return;

      let currentAgent = step.agent;
      let conversationId = createConversationId();
      const stepStartedAt = Date.now();

      let startResult = await sessionPort.start({
        conversationId,
        cwd: workspace,
        agent: currentAgent,
        fallbackTitle: `${run.configSnapshot.name} - ${step.name}`,
        signal,
      });

      // In-flight Failover: if hit by rate limit, rotate account and retry
      const attemptedProviders = new Set<string>([currentAgent.start.providerId]);
      while (!startResult.success && isRateLimitError(startResult.error)) {
        const failoverProvider = resolveFailover({
          failingProviderId: currentAgent.start.providerId,
          step,
          stepHistory: history,
          attemptedProviderIds: attemptedProviders,
          resolveAccount,
        });

        if (!failoverProvider) break;
        attemptedProviders.add(failoverProvider);

        currentAgent =
          currentAgent.type === 'acp'
            ? {
                ...currentAgent,
                start: {
                  ...currentAgent.start,
                  providerId: failoverProvider,
                },
              }
            : {
                ...currentAgent,
                start: {
                  ...currentAgent.start,
                  providerId: failoverProvider,
                },
              };

        conversationId = createConversationId();

        startResult = await sessionPort.start({
          conversationId,
          cwd: workspace,
          agent: currentAgent,
          fallbackTitle: `${run.configSnapshot.name} - ${step.name}`,
          signal,
        });
      }

      if (!startResult.success) {
        const failedRecord: StepRunRecord = {
          stepIndex: i,
          stepId: step.id,
          name: step.name,
          providerId: currentAgent.start.providerId,
          conversationId,
          sessionId: null,
          status: 'failed',
          startedAt: stepStartedAt,
          finishedAt: Date.now(),
          error: toRunError('start_session', startResult.error),
        };
        history.push(failedRecord);

        transitions.markFailed(run.id, toRunError('start_session', startResult.error), Date.now(), {
          currentStepIndex: i,
          stepHistory: history,
        });
        return;
      }

      const stepRecord: StepRunRecord = {
        stepIndex: i,
        stepId: step.id,
        name: step.name,
        providerId: currentAgent.start.providerId,
        conversationId,
        sessionId: startResult.data.sessionId,
        status: 'done',
        startedAt: stepStartedAt,
        finishedAt: Date.now(),
      };
      history.push(stepRecord);

      const isLastStep = i === steps.length - 1;
      if (!isLastStep && step.gate === 'manual_approval') {
        transitions.markAwaitingGate(run.id, {
          currentStepIndex: i,
          stepHistory: history,
          conversationId,
          sessionId: startResult.data.sessionId,
        });
        return;
      }
    }

    const lastRecord = history[history.length - 1];
    transitions.markDone(
      run.id,
      {
        conversationId: lastRecord ? lastRecord.conversationId : (run.conversationId ?? ''),
        sessionId: lastRecord ? lastRecord.sessionId : null,
        currentStepIndex: steps.length - 1,
        stepHistory: history,
      },
      Date.now()
    );
  };
}

function toRunError(step: 'provision_workspace' | 'start_session', portError: AutomationPortError) {
  return { step, code: portError.code, message: portError.message };
}
