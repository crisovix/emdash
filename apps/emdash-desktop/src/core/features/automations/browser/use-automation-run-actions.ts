import {
  useAdoptAutomationRun,
  useApproveAutomationGate,
  useAutomationTargetAvailability,
  useStopAutomationRun,
} from './use-automations';

export function useAutomationRunActions(automationId: string, projectId: string | null) {
  const adopt = useAdoptAutomationRun();
  const stop = useStopAutomationRun();
  const approve = useApproveAutomationGate();
  const availability = useAutomationTargetAvailability(projectId ?? undefined);
  return {
    stopRun: (runId: string) => {
      if (!projectId) return;
      stop.mutate({ projectId, automationId, runId });
    },
    approveGate: (runId: string) => {
      if (!projectId) return;
      return approve.mutateAsync({ projectId, automationId, runId });
    },
    adoptRun: (runId: string) => adopt.mutateAsync({ automationId, runId }),
    isAdopting: adopt.isPending,
    isApproving: approve.isPending,
    runtimeAvailable: availability.data?.available === true,
  };
}
