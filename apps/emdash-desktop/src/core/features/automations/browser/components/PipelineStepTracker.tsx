import { resolveDeploymentSteps, type PipelineStep } from '@emdash/core/runtimes/automations/api';
import type { AutomationRun } from '@emdash/core/runtimes/automations/api';
import { Button, Tooltip } from '@emdash/ui/react/primitives';
import { CheckCircle2, ChevronRight, Clock, Loader2, ShieldCheck, XCircle } from 'lucide-react';
import React, { useState } from 'react';
import { cn } from '@core/primitives/styling/browser/cn';
import { useAutomationRunActions } from '../use-automation-run-actions';

interface PipelineStepTrackerProps {
  run: AutomationRun;
  automationId: string;
  projectId: string | null;
}

export function PipelineStepTracker({ run, automationId, projectId }: PipelineStepTrackerProps) {
  const steps = resolveDeploymentSteps(run.configSnapshot);
  const { approveGate, isApproving } = useAutomationRunActions(automationId, projectId);
  const [approvingStep, setApprovingStep] = useState(false);

  // If single step with default auto gate and no custom name, we don't need the complex tracker
  if (steps.length <= 1 && !run.stepHistory?.length) {
    return null;
  }

  const currentStepIdx = run.currentStepIndex ?? 0;
  const isAwaitingGate = run.status === 'awaiting_gate';

  async function handleApprove(event: React.MouseEvent) {
    event.stopPropagation();
    try {
      setApprovingStep(true);
      await approveGate(run.id);
    } finally {
      setApprovingStep(false);
    }
  }

  return (
    <div className="mt-2 flex flex-col gap-2 rounded-md border border-border/40 bg-background-2/50 p-2.5 text-xs">
      <div className="flex items-center justify-between font-medium text-foreground-muted">
        <span className="flex items-center gap-1.5">
          <span>Multi-Agent Pipeline</span>
          <span className="rounded bg-background-3 px-1 py-0.5 text-[10px] text-foreground-muted">
            {steps.length} steps
          </span>
        </span>
        {isAwaitingGate && (
          <Button
            size="sm"
            variant="primary"
            disabled={isApproving || approvingStep}
            onClick={handleApprove}
            className="h-6 gap-1 px-2 text-xs font-semibold"
          >
            {isApproving || approvingStep ? (
              <>
                <Loader2 className="size-3 animate-spin" />
                Resuming...
              </>
            ) : (
              <>
                <CheckCircle2 className="size-3" />
                Approve & Continue
              </>
            )}
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {steps.map((step: PipelineStep, idx: number) => {
          const isDone =
            (run.status === 'done' && idx <= currentStepIdx) ||
            (run.stepHistory &&
              run.stepHistory.some((h) => h.stepIndex === idx && h.status === 'done'));

          const isCurrent = idx === currentStepIdx && run.status !== 'done';
          const isFailed = isCurrent && run.status === 'failed';
          const isStepAwaitingGate = isCurrent && isAwaitingGate;
          const isRunning = isCurrent && run.status === 'starting_session';
          const isPending = idx > currentStepIdx;

          const providerId = step.agent.start.providerId;
          const policy = step.accountPolicy;

          return (
            <React.Fragment key={step.id || idx}>
              <div
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors',
                  isDone &&
                    'bg-background-success/10 text-foreground-success border border-background-success/20',
                  isStepAwaitingGate &&
                    'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/30 animate-pulse',
                  isRunning &&
                    'bg-background-info/10 text-foreground-info border border-background-info/20',
                  isFailed && 'bg-destructive/10 text-destructive border border-destructive/30',
                  isPending && 'bg-background-3 text-foreground-muted/60 opacity-75'
                )}
              >
                {isDone && <CheckCircle2 className="size-3.5 shrink-0" />}
                {isStepAwaitingGate && <Clock className="size-3.5 shrink-0" />}
                {isRunning && <Loader2 className="size-3.5 shrink-0 animate-spin" />}
                {isFailed && <XCircle className="size-3.5 shrink-0" />}
                {isPending && (
                  <span className="flex size-3.5 items-center justify-center rounded-full border border-foreground-muted/40 text-[9px]">
                    {idx + 1}
                  </span>
                )}

                <div className="flex flex-col">
                  <span className="leading-tight font-medium">
                    {step.name || `Step ${idx + 1}`}
                  </span>
                  <div className="flex items-center gap-1 text-[10px] opacity-85">
                    <span className="font-mono">{providerId}</span>
                    {policy === 'different-from-previous' && (
                      <Tooltip.Root>
                        <Tooltip.Trigger
                          render={
                            <span className="text-primary inline-flex cursor-help items-center">
                              <ShieldCheck className="size-2.5" />
                            </span>
                          }
                        />
                        <Tooltip.Content>
                          Enforces different account from previous step
                        </Tooltip.Content>
                      </Tooltip.Root>
                    )}
                  </div>
                </div>
              </div>

              {idx < steps.length - 1 && (
                <ChevronRight className="size-3 shrink-0 text-foreground-muted/40" />
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
