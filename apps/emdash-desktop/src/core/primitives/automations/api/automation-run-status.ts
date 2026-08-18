export type AutomationRunStatus =
  | 'scheduled'
  | 'queued'
  | 'provisioning_workspace'
  | 'starting_session'
  | 'awaiting_gate'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export type AutomationRunTriggerKind = 'cron' | 'manual';
