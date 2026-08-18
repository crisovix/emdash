import { PageLayout, SettingsSection } from '@emdash/ui/react/patterns';
import { Badge, Button, Spinner, Text } from '@emdash/ui/react/primitives';
import React from 'react';
import { getAccountPoolClient } from '@core/features/account-pool/api/client';
import type { AccountPoolEntry, AccountPoolReport } from '@core/features/account-pool/api/contract';

const WINDOWS: { label: string; days?: number }[] = [
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: 'All time' },
];

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function StatusBadge({ entry }: { entry: AccountPoolEntry }) {
  if (entry.notMeasurable) return <Badge tone="neutral">not measurable</Badge>;
  switch (entry.status.state) {
    case 'ok':
      return <Badge tone="success">available</Badge>;
    case 'rate_limited':
      return <Badge tone="warning">rate limited</Badge>;
    case 'needs_login':
      return <Badge tone="error">needs login</Badge>;
    case 'org_blocked':
      return <Badge tone="error">org blocked</Badge>;
  }
}

/** Output tokens are the clearest single proxy for how hard an account is used. */
function AccountRow({ entry, shareOfOutput }: { entry: AccountPoolEntry; shareOfOutput: number }) {
  const detail = entry.notMeasurable ?? (entry.status.state === 'ok' ? null : entry.status.message);

  return (
    <div className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Text variant="body">{entry.accountId}</Text>
        <Badge tone="neutral">{entry.scope}</Badge>
        <StatusBadge entry={entry} />
        <div className="ml-auto flex items-center gap-4">
          <Text variant="caption" tone="muted">
            {entry.usage.messages.toLocaleString()} turns
          </Text>
          <Text variant="caption" tone="muted">
            {formatTokens(entry.usage.outputTokens)} out
          </Text>
        </div>
      </div>

      {entry.notMeasurable === undefined && (
        <div className="flex items-center gap-3">
          <div
            className="bg-muted h-1.5 flex-1 overflow-hidden rounded-full"
            role="progressbar"
            aria-label={`${entry.accountId} share of output tokens`}
            aria-valuenow={Math.round(shareOfOutput)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="bg-primary h-full rounded-full"
              style={{ width: `${shareOfOutput > 0 ? Math.max(shareOfOutput, 1) : 0}%` }}
            />
          </div>
          <Text variant="caption" tone="muted">
            {shareOfOutput.toFixed(1)}%
          </Text>
        </div>
      )}

      {detail && (
        <Text variant="caption" tone="muted">
          {detail}
        </Text>
      )}

      {entry.boundConversations > 0 && (
        <Text variant="caption" tone="muted">
          {entry.boundConversations} conversation(s) routed here by auto
        </Text>
      )}
    </div>
  );
}

export const AccountPoolView: React.FC = () => {
  const [report, setReport] = React.useState<AccountPoolReport | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [days, setDays] = React.useState<number | undefined>(30);

  const load = React.useCallback((windowDays: number | undefined) => {
    setLoading(true);
    setError(null);
    getAccountPoolClient()
      .then((client) => client.report(windowDays === undefined ? {} : { days: windowDays }))
      .then(setReport)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    load(days);
  }, [days, load]);

  // Share is computed over measurable accounts only, so an unmeasurable one
  // cannot silently dilute the percentages.
  const measurable = report?.accounts.filter((a) => a.notMeasurable === undefined) ?? [];
  const totalOutput = measurable.reduce((sum, a) => sum + a.usage.outputTokens, 0);
  const idle = measurable.filter((a) => a.usage.outputTokens === 0);

  return (
    <div className="space-y-8">
      <PageLayout.Header
        sticky
        title="Account Pool"
        description="What each subscription has spent, and whether it can take work right now."
      />

      <div className="flex items-center gap-2">
        {WINDOWS.map((window) => (
          <Button
            key={window.label}
            variant={window.days === days ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setDays(window.days)}
          >
            {window.label}
          </Button>
        ))}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          disabled={loading}
          onClick={() => load(days)}
        >
          Refresh
        </Button>
      </div>

      {loading && !report && (
        <div className="flex items-center gap-2">
          <Spinner size="sm" />
          <Text variant="body" tone="muted">
            Reading account transcripts…
          </Text>
        </div>
      )}

      {error && <Text variant="body">Could not read the pool: {error}</Text>}

      {report && (
        <SettingsSection title="Accounts">
          {report.accounts.map((entry) => (
            <AccountRow
              key={entry.accountId}
              entry={entry}
              shareOfOutput={totalOutput === 0 ? 0 : (entry.usage.outputTokens / totalOutput) * 100}
            />
          ))}
        </SettingsSection>
      )}

      {report && idle.length > 0 && (
        <Text variant="caption" tone="muted">
          Idle capacity: {idle.map((a) => a.accountId).join(', ')} recorded no usage in this window.
          Picking an &ldquo;· auto&rdquo; agent spreads new conversations across accounts.
        </Text>
      )}

      {report && (
        <Text variant="caption" tone="muted">
          Usage comes from each account&apos;s own Claude Code transcripts, since there is no quota
          API to query. Antigravity keeps no usage record on disk, so those accounts cannot be
          measured.
        </Text>
      )}
    </div>
  );
};
