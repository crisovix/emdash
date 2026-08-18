/**
 * Account Pool report: what each subscription has spent, and whether it is
 * usable right now.
 *
 * Parallelising four accounts burns quota four times faster, so knowing which
 * subscription is being drained is what makes the pool a pool rather than four
 * taps left running. Read from each account's own transcripts — there is no
 * quota API to ask.
 *
 *   pnpm run pool:report            # all history
 *   pnpm run pool:report -- --days 7
 *   pnpm run pool:report -- --json
 */
import { readPoolReport, type AccountReport } from '../../packages/core/src/primitives/account-pool/node/index.ts';
import { poolAccountProfiles } from '../../packages/plugins/src/agents/account-pool/profiles.ts';

const args = process.argv.slice(2);

function flagValue(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const asJson = args.includes('--json');
const days = Number(flagValue('--days') ?? '');
const now = Date.now();
const since = Number.isFinite(days) && days > 0 ? now - days * 86_400_000 : undefined;

const reports = await readPoolReport(poolAccountProfiles(), { now, ...(since ? { since } : {}) });

if (asJson) {
  console.log(JSON.stringify({ generatedAt: new Date(now).toISOString(), reports }, null, 2));
  process.exit(0);
}

function thousands(n: number): string {
  return n.toLocaleString('en-US');
}

/** Cache reads are the bulk of a coding session and are not billed like input. */
function statusLabel(report: AccountReport): string {
  const { status } = report;
  switch (status.state) {
    case 'ok':
      return report.unreadable ? `n/a (${report.unreadable})` : 'ok';
    case 'rate_limited':
      return `RATE LIMITED · ${status.failure.message || 'session limit'}`;
    case 'needs_login':
      return 'NEEDS LOGIN';
    case 'org_blocked':
      return 'ORG BLOCKED · subscription access disabled';
  }
}

const window = since ? `last ${days} day(s)` : 'all recorded history';
console.log(`\nAccount Pool — usage and status (${window})\n`);

const rows = reports.map((report) => ({
  account: `${report.profile.id} (${report.profile.scope})`,
  turns: report.usage.messages,
  input: report.usage.inputTokens,
  output: report.usage.outputTokens,
  cacheRead: report.usage.cacheReadInputTokens,
  status: statusLabel(report),
}));

const width = (key: 'account' | 'status'): number =>
  Math.max(key.length, ...rows.map((r) => r[key].length));
const accountWidth = width('account');

console.log(
  `${'account'.padEnd(accountWidth)}  ${'turns'.padStart(7)}  ${'in'.padStart(11)}  ` +
    `${'out'.padStart(11)}  ${'cache read'.padStart(13)}  status`
);
console.log('-'.repeat(accountWidth + 55 + width('status')));

for (const row of rows) {
  console.log(
    `${row.account.padEnd(accountWidth)}  ${thousands(row.turns).padStart(7)}  ` +
      `${thousands(row.input).padStart(11)}  ${thousands(row.output).padStart(11)}  ` +
      `${thousands(row.cacheRead).padStart(13)}  ${row.status}`
  );
}

const claude = reports.filter((r) => r.profile.provider === 'claude' && !r.unreadable);
if (claude.length > 1) {
  const totalOut = claude.reduce((sum, r) => sum + r.usage.outputTokens, 0);
  console.log('\nShare of Claude output tokens:');
  for (const report of claude) {
    const share = totalOut === 0 ? 0 : (report.usage.outputTokens / totalOut) * 100;
    const bar = '█'.repeat(Math.round(share / 2.5));
    console.log(`  ${report.profile.id.padEnd(18)} ${share.toFixed(1).padStart(5)}%  ${bar}`);
  }
  console.log('\n  An account far below its share is capacity going unused.');
}

const unreadable = reports.filter((r) => r.unreadable);
if (unreadable.length > 0) {
  console.log('\nNot measurable:');
  for (const report of unreadable) {
    console.log(`  ${report.profile.id.padEnd(18)} ${report.unreadable}`);
  }
}

const byModel = new Map<string, number>();
for (const report of claude) {
  for (const [model, usage] of Object.entries(report.usage.byModel)) {
    byModel.set(model, (byModel.get(model) ?? 0) + usage.outputTokens);
  }
}
if (byModel.size > 0) {
  console.log('\nOutput tokens by model:');
  for (const [model, out] of [...byModel].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${model.padEnd(28)} ${thousands(out).padStart(12)}`);
  }
}
console.log();
