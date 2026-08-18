import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { accountPoolReportSchema } from '../api/contract';
import { createAccountPoolWireController } from './wire-controller';

const NOW = Date.parse('2026-08-18T00:00:00.000Z');

/**
 * A home dir laid out the way the pool expects: the profile list derives account
 * dirs from it, so seeding transcripts there exercises the real path resolution.
 */
function seedHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), 'pool-home-'));
  const dir = path.join(home, '.agentpool', 'claude-personal', 'projects', '-repo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 's1.jsonl'),
    [
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(NOW - 60_000).toISOString(),
        message: {
          model: 'claude-sonnet-5',
          usage: { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 33 },
        },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(NOW - 30_000).toISOString(),
        isApiErrorMessage: true,
        error: 'rate_limit',
        apiErrorStatus: 429,
        message: {
          model: '<synthetic>',
          content: [{ type: 'text', text: "You've hit your session limit · resets 5:10pm" }],
          usage: {},
        },
      }),
    ].join('\n') + '\n'
  );
  return home;
}

function report(home: string, input: { days?: number } = {}): Promise<unknown> {
  const controller = createAccountPoolWireController({ homeDir: home, now: () => NOW });
  return controller.call('report', input);
}

describe('account pool wire controller', () => {
  it('returns a payload that satisfies the contract schema', async () => {
    const result = await report(seedHome());
    const parsed = accountPoolReportSchema.parse(result);
    expect(parsed.generatedAt).toBe(NOW);
    expect(parsed.windowDays).toBeNull();
    // One entry per configured account, so the page can show idle ones too.
    expect(parsed.accounts.map((a) => a.accountId)).toEqual([
      'claude-personal',
      'claude-empresa',
      'gemini-personal',
      'gemini-empresa',
    ]);
  });

  it('reports usage and the rate limit for the seeded account', async () => {
    const parsed = accountPoolReportSchema.parse(await report(seedHome()));
    const personal = parsed.accounts.find((a) => a.accountId === 'claude-personal')!;
    expect(personal.usage).toMatchObject({ inputTokens: 11, outputTokens: 22, messages: 1 });
    expect(personal.byModel).toEqual([
      expect.objectContaining({ model: 'claude-sonnet-5', outputTokens: 22 }),
    ]);
    expect(personal.status.state).toBe('rate_limited');
  });

  it('marks antigravity accounts as not measurable rather than as zero usage', async () => {
    const parsed = accountPoolReportSchema.parse(await report(seedHome()));
    const gemini = parsed.accounts.find((a) => a.accountId === 'gemini-personal')!;
    expect(gemini.notMeasurable).toBeTruthy();
  });

  it('passes the window through', async () => {
    const parsed = accountPoolReportSchema.parse(await report(seedHome(), { days: 7 }));
    expect(parsed.windowDays).toBe(7);
  });

  it('counts the auto router bindings', async () => {
    const home = seedHome();
    mkdirSync(path.join(home, '.agentpool'), { recursive: true });
    writeFileSync(
      path.join(home, '.agentpool', 'routing.json'),
      JSON.stringify({ version: 1, routes: { c1: 'claude-personal', c2: 'claude-personal' } })
    );
    const parsed = accountPoolReportSchema.parse(await report(home));
    const personal = parsed.accounts.find((a) => a.accountId === 'claude-personal')!;
    expect(personal.boundConversations).toBe(2);
  });

  it('reports zeros for a home with no accounts, instead of failing', async () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'pool-empty-'));
    const parsed = accountPoolReportSchema.parse(await report(empty));
    for (const account of parsed.accounts) {
      expect(account.usage.messages).toBe(0);
      expect(account.notMeasurable).toBeTruthy();
    }
  });
});
