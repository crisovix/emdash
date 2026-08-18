import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PoolAccountProfile } from '../api';
import { RATE_LIMIT_WINDOW_MS } from '../api';
import { readAccountReport, readAccountStateQuick } from './index';

const NOW = Date.parse('2026-08-18T12:00:00.000Z');

function account(dir: string): PoolAccountProfile {
  return { id: 'acct', provider: 'claude', scope: 'personal', label: 'acct', dir };
}

function turn(offsetMs: number, output = 20): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(NOW + offsetMs).toISOString(),
    message: {
      model: 'claude-sonnet-5',
      usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 5 },
    },
  });
}

function failure(offsetMs: number, error: string, status?: number): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(NOW + offsetMs).toISOString(),
    isApiErrorMessage: true,
    error,
    ...(status !== undefined ? { apiErrorStatus: status } : {}),
    message: { model: '<synthetic>', content: [{ type: 'text', text: error }], usage: {} },
  });
}

/** Seeds a transcript and back-dates its mtime, as an idle account would look. */
function seed(lines: string[], options: { mtimeMs?: number } = {}): PoolAccountProfile {
  const dir = mkdtempSync(path.join(tmpdir(), 'acct-'));
  const projects = path.join(dir, 'projects', '-repo');
  mkdirSync(projects, { recursive: true });
  const file = path.join(projects, 's1.jsonl');
  writeFileSync(file, lines.join('\n') + '\n');
  if (options.mtimeMs !== undefined) {
    const seconds = options.mtimeMs / 1000;
    utimesSync(file, seconds, seconds);
  }
  return account(dir);
}

describe('readAccountStateQuick', () => {
  it('sees a fresh rate limit', async () => {
    const profile = seed([turn(-60_000), failure(-30_000, 'rate_limit', 429)]);
    const state = await readAccountStateQuick(profile, { now: NOW });
    expect(state.state).toBe('rate_limited');
  });

  it('keeps reporting needs_login on an account idle for longer than the limit window', async () => {
    // The bug this guards: bounding the read by the rate-limit window hid
    // non-expiring failures, so a dead account looked healthy again after a few
    // idle hours and kept being handed work it could not run.
    const idleFor = RATE_LIMIT_WINDOW_MS * 4;
    const profile = seed([turn(-idleFor - 60_000), failure(-idleFor, 'authentication_failed')], {
      mtimeMs: NOW - idleFor,
    });
    const state = await readAccountStateQuick(profile, { now: NOW });
    expect(state.state).toBe('needs_login');
  });

  it('keeps reporting org_blocked on a long-idle account', async () => {
    const idleFor = RATE_LIMIT_WINDOW_MS * 10;
    const profile = seed([failure(-idleFor, 'oauth_org_not_allowed', 403)], {
      mtimeMs: NOW - idleFor,
    });
    const state = await readAccountStateQuick(profile, { now: NOW });
    expect(state.state).toBe('org_blocked');
  });

  it('still expires a stale rate limit, which does reset on its own', async () => {
    const idleFor = RATE_LIMIT_WINDOW_MS * 2;
    const profile = seed([failure(-idleFor, 'rate_limit', 429)], { mtimeMs: NOW - idleFor });
    const state = await readAccountStateQuick(profile, { now: NOW });
    expect(state.state).toBe('ok');
  });

  it('treats a missing account dir as available rather than as a failure', async () => {
    const state = await readAccountStateQuick(account('/nonexistent/pool/acct'), { now: NOW });
    expect(state).toEqual({ state: 'ok' });
  });

  it('reports ok for a provider that keeps no transcripts', async () => {
    const profile = { ...seed([failure(0, 'rate_limit', 429)]), provider: 'antigravity' as const };
    expect(await readAccountStateQuick(profile, { now: NOW })).toEqual({ state: 'ok' });
  });
});

describe('readAccountReport', () => {
  it('counts only turns inside the requested window', async () => {
    // A long-running session touched today can hold turns from weeks ago, so the
    // window has to be applied per entry, not just per file.
    const day = 86_400_000;
    const profile = seed([turn(-30 * day, 100), turn(-1 * day, 7)]);
    const report = await readAccountReport(profile, { now: NOW, since: NOW - 7 * day });
    expect(report.usage.outputTokens).toBe(7);
    expect(report.usage.messages).toBe(1);
  });

  it('counts everything when no window is given', async () => {
    const day = 86_400_000;
    const profile = seed([turn(-30 * day, 100), turn(-1 * day, 7)]);
    const report = await readAccountReport(profile, { now: NOW });
    expect(report.usage.outputTokens).toBe(107);
    expect(report.usage.messages).toBe(2);
  });

  it('marks a non-claude account as not measurable instead of reporting zeros', async () => {
    const profile = { ...account('/tmp'), provider: 'antigravity' as const };
    const report = await readAccountReport(profile, { now: NOW });
    expect(report.unreadable).toBeTruthy();
    expect(report.usage.messages).toBe(0);
  });
});
