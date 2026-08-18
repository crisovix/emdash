import { describe, expect, it } from 'vitest';
import {
  accountState,
  accumulateUsage,
  classifyFailure,
  parseTranscriptLine,
  RATE_LIMIT_WINDOW_MS,
  type TranscriptEntry,
} from './transcript';

const T0 = Date.parse('2026-08-11T17:00:00.000Z');
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

/** Shaped exactly like a real billed assistant turn. */
function turn(
  offsetMs: number,
  overrides: { model?: string; input?: number; output?: number; cacheRead?: number } = {}
): TranscriptEntry {
  return {
    type: 'assistant',
    timestamp: at(offsetMs),
    message: {
      model: overrides.model ?? 'claude-sonnet-5',
      usage: {
        input_tokens: overrides.input ?? 2,
        output_tokens: overrides.output ?? 4,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: overrides.cacheRead ?? 200,
        output_tokens_details: { thinking_tokens: 7 },
        service_tier: 'standard',
      },
    },
  };
}

/** Shaped exactly like a real API failure entry: synthetic model, zero usage. */
function failure(offsetMs: number, error: string, status?: number, text = 'boom'): TranscriptEntry {
  return {
    type: 'assistant',
    timestamp: at(offsetMs),
    isApiErrorMessage: true,
    error,
    ...(status !== undefined ? { apiErrorStatus: status } : {}),
    message: {
      model: '<synthetic>',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  };
}

describe('parseTranscriptLine', () => {
  it('ignores blank lines and a torn trailing line, since transcripts are appended live', () => {
    expect(parseTranscriptLine('')).toBeNull();
    expect(parseTranscriptLine('   ')).toBeNull();
    expect(parseTranscriptLine('{"type":"assis')).toBeNull();
  });

  it('ignores JSON that is not an object', () => {
    expect(parseTranscriptLine('42')).toBeNull();
    expect(parseTranscriptLine('null')).toBeNull();
  });

  it('parses an entry', () => {
    expect(parseTranscriptLine('{"type":"assistant"}')).toEqual({ type: 'assistant' });
  });
});

describe('classifyFailure', () => {
  it('reads the rate limit shape seen in real transcripts, keeping the reset text', () => {
    const text = "You've hit your session limit · resets 5:10pm (America/Santiago)";
    expect(classifyFailure(failure(0, 'rate_limit', 429, text))).toEqual({
      kind: 'rate_limit',
      at: T0,
      status: 429,
      message: text,
    });
  });

  it('distinguishes an org block from a spent quota — it must not trigger failover', () => {
    const result = classifyFailure(failure(0, 'oauth_org_not_allowed', 403));
    expect(result?.kind).toBe('org_not_allowed');
  });

  it('reads an expired login, which carries no status', () => {
    const result = classifyFailure(failure(0, 'authentication_failed'));
    expect(result?.kind).toBe('authentication_failed');
    expect(result?.status).toBeUndefined();
  });

  it('is null for ordinary turns and for unknown error strings', () => {
    expect(classifyFailure(turn(0))).toBeNull();
    expect(classifyFailure(failure(0, 'some_future_error', 500))).toBeNull();
  });
});

describe('accumulateUsage', () => {
  it('sums tokens overall and per model', () => {
    const usage = accumulateUsage([
      turn(0, { input: 10, output: 20 }),
      turn(1000, { input: 5, output: 1, model: 'claude-opus-5' }),
    ]);
    expect(usage.inputTokens).toBe(15);
    expect(usage.outputTokens).toBe(21);
    expect(usage.thinkingTokens).toBe(14);
    expect(usage.messages).toBe(2);
    expect(Object.keys(usage.byModel).sort()).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(usage.byModel['claude-opus-5']!.outputTokens).toBe(1);
  });

  it('excludes synthetic failure entries, which would inflate the turn count', () => {
    const usage = accumulateUsage([turn(0), failure(1000, 'rate_limit', 429)]);
    expect(usage.messages).toBe(1);
    expect(usage.byModel['<synthetic>']).toBeUndefined();
  });

  it('tracks the first and last counted turn', () => {
    const usage = accumulateUsage([turn(5000), turn(0), turn(2000)]);
    expect(usage.firstAt).toBe(T0);
    expect(usage.lastAt).toBe(T0 + 5000);
  });

  it('tolerates missing or non-numeric usage fields', () => {
    const usage = accumulateUsage([
      { type: 'assistant', message: { model: 'm', usage: { input_tokens: 'x' } } },
      { type: 'user', message: { model: 'm', usage: { input_tokens: 5 } } },
    ]);
    expect(usage.inputTokens).toBe(0);
    expect(usage.messages).toBe(1);
  });
});

describe('accountState', () => {
  const now = T0 + 60_000;

  it('is ok with no failures', () => {
    expect(accountState([turn(0)], { now })).toEqual({ state: 'ok' });
  });

  it('reports rate_limited when the limit is the most recent event', () => {
    const state = accountState([turn(0), failure(1000, 'rate_limit', 429)], { now });
    expect(state.state).toBe('rate_limited');
  });

  it('clears once a later billed turn proves the window reopened', () => {
    // Ordering is the evidence, rather than parsing "resets 5:10pm".
    const state = accountState([failure(1000, 'rate_limit', 429), turn(2000)], { now });
    expect(state).toEqual({ state: 'ok' });
  });

  it('expires a stale limit, since the transcript never records the reset', () => {
    const stale = accountState([failure(0, 'rate_limit', 429)], {
      now: T0 + RATE_LIMIT_WINDOW_MS + 1,
    });
    expect(stale).toEqual({ state: 'ok' });

    const fresh = accountState([failure(0, 'rate_limit', 429)], {
      now: T0 + RATE_LIMIT_WINDOW_MS - 1,
    });
    expect(fresh.state).toBe('rate_limited');
  });

  it('does not expire an org block or a login failure — those need a human', () => {
    const later = { now: T0 + RATE_LIMIT_WINDOW_MS * 10 };
    expect(accountState([failure(0, 'oauth_org_not_allowed', 403)], later).state).toBe(
      'org_blocked'
    );
    expect(accountState([failure(0, 'authentication_failed')], later).state).toBe('needs_login');
  });

  it('uses the newest failure when several are present', () => {
    const state = accountState(
      [failure(2000, 'authentication_failed'), failure(1000, 'rate_limit', 429)],
      { now }
    );
    expect(state.state).toBe('needs_login');
  });

  it('honours a caller-supplied window', () => {
    const state = accountState([failure(0, 'rate_limit', 429)], {
      now: T0 + 10_000,
      rateLimitWindowMs: 5_000,
    });
    expect(state).toEqual({ state: 'ok' });
  });
});
