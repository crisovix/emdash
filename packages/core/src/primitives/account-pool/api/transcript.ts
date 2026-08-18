/**
 * Reading an Account Pool account's own on-disk transcripts, which is the only
 * place a Claude Code subscription reports what it spent and when it was cut off
 * — there is no quota API.
 *
 * Claude Code appends JSONL to `<configDir>/projects/<slug>/<sessionId>.jsonl`,
 * and because the pool gives every account its own config dir, those files are
 * already partitioned per account.
 *
 * Every shape here was taken from real transcripts (400+ sessions), not from
 * docs: an API failure is an `assistant` entry with `isApiErrorMessage: true`,
 * a synthetic model, zero usage, and a machine-readable `error` discriminator.
 */

/** The `error` values observed across real transcripts, and nothing else. */
export type AccountFailureKind =
  /** `error: 'rate_limit'`, status 429. The subscription's window is spent. */
  | 'rate_limit'
  /** `error: 'oauth_org_not_allowed'`, status 403. Org disabled Claude Code. */
  | 'org_not_allowed'
  /** `error: 'authentication_failed'`. Login expired or absent. */
  | 'authentication_failed';

export type AccountFailure = {
  kind: AccountFailureKind;
  /** Entry timestamp, epoch ms. */
  at: number;
  /** HTTP status when the entry carried one. */
  status?: number;
  /** The message as emitted, e.g. "You've hit your session limit · resets 5:10pm (America/Santiago)". */
  message: string;
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  thinkingTokens: number;
  /** Assistant turns that reported real usage; synthetic error entries excluded. */
  messages: number;
};

export type AccountUsage = TokenUsage & {
  byModel: Record<string, TokenUsage>;
  /** Epoch ms of the first and last counted turn, or undefined when none. */
  firstAt?: number;
  lastAt?: number;
};

/** One transcript line, narrowed to the fields this module reads. */
export type TranscriptEntry = {
  type?: string;
  timestamp?: string;
  isApiErrorMessage?: boolean;
  error?: string;
  apiErrorStatus?: number;
  message?: {
    model?: string;
    content?: unknown;
    usage?: Record<string, unknown>;
  };
};

const FAILURE_KINDS: Record<string, AccountFailureKind> = {
  rate_limit: 'rate_limit',
  oauth_org_not_allowed: 'org_not_allowed',
  authentication_failed: 'authentication_failed',
};

/**
 * A transcript line as an entry, or null when the line is blank or not JSON.
 * Transcripts are appended to live, so a torn final line is normal and must not
 * fail the read.
 */
export function parseTranscriptLine(line: string): TranscriptEntry | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null ? (parsed as TranscriptEntry) : null;
  } catch {
    return null;
  }
}

function timestampOf(entry: TranscriptEntry): number | undefined {
  if (!entry.timestamp) return undefined;
  const ms = Date.parse(entry.timestamp);
  return Number.isNaN(ms) ? undefined : ms;
}

function textOf(entry: TranscriptEntry): string {
  const content = entry.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) =>
      typeof block === 'object' &&
      block !== null &&
      typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : ''
    )
    .join(' ')
    .trim();
}

/** The failure an entry represents, or null when it is not an API failure. */
export function classifyFailure(entry: TranscriptEntry): AccountFailure | null {
  if (entry.isApiErrorMessage !== true) return null;
  const kind = entry.error ? FAILURE_KINDS[entry.error] : undefined;
  if (!kind) return null;
  return {
    kind,
    at: timestampOf(entry) ?? 0,
    ...(typeof entry.apiErrorStatus === 'number' ? { status: entry.apiErrorStatus } : {}),
    message: textOf(entry),
  };
}

function num(usage: Record<string, unknown> | undefined, key: string): number {
  const value = usage?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    thinkingTokens: 0,
    messages: 0,
  };
}

function addInto(target: TokenUsage, entry: TranscriptEntry): void {
  const usage = entry.message?.usage;
  const details = usage?.['output_tokens_details'] as Record<string, unknown> | undefined;
  target.inputTokens += num(usage, 'input_tokens');
  target.outputTokens += num(usage, 'output_tokens');
  target.cacheCreationInputTokens += num(usage, 'cache_creation_input_tokens');
  target.cacheReadInputTokens += num(usage, 'cache_read_input_tokens');
  target.thinkingTokens += num(details, 'thinking_tokens');
  target.messages += 1;
}

/**
 * True for an assistant turn that actually consumed subscription capacity.
 * Failure entries also arrive as `assistant`, but with a synthetic model and
 * zeroed usage, so counting them would inflate turn counts with non-inference.
 */
function isBilledTurn(entry: TranscriptEntry): boolean {
  if (entry.type !== 'assistant' || entry.isApiErrorMessage === true) return false;
  const model = entry.message?.model;
  if (typeof model !== 'string' || model === '' || model.startsWith('<')) return false;
  return entry.message?.usage !== undefined;
}

/** Token totals over a transcript, overall and per model. */
export function accumulateUsage(entries: Iterable<TranscriptEntry>): AccountUsage {
  const total: AccountUsage = { ...emptyUsage(), byModel: {} };
  for (const entry of entries) {
    if (!isBilledTurn(entry)) continue;
    const model = entry.message!.model!;
    total.byModel[model] ??= emptyUsage();
    addInto(total.byModel[model]!, entry);
    addInto(total, entry);
    const at = timestampOf(entry);
    if (at !== undefined) {
      if (total.firstAt === undefined || at < total.firstAt) total.firstAt = at;
      if (total.lastAt === undefined || at > total.lastAt) total.lastAt = at;
    }
  }
  return total;
}

export type AccountState =
  | { state: 'ok' }
  | { state: 'rate_limited'; failure: AccountFailure }
  | { state: 'needs_login'; failure: AccountFailure }
  | { state: 'org_blocked'; failure: AccountFailure };

/**
 * Claude's session window. Used only to expire a stale `rate_limit` observation:
 * a limit older than this has reset, and the transcript never records the reset
 * itself.
 */
export const RATE_LIMIT_WINDOW_MS = 5 * 60 * 60 * 1000;

/**
 * Whether an account looks usable right now, from its most recent activity.
 *
 * Deliberately decided by ordering rather than by parsing the "resets 5:10pm
 * (America/Santiago)" text: a later successful turn is direct proof the window
 * reopened, while that text needs a timezone and a guess at which day it means.
 * The raw message is still carried on the failure for display.
 *
 * A limit with no success after it, but older than the session window, is
 * treated as expired — the transcript records being cut off, never recovering.
 */
export function accountState(
  entries: Iterable<TranscriptEntry>,
  options: { now: number; rateLimitWindowMs?: number }
): AccountState {
  let lastFailure: AccountFailure | null = null;
  let lastSuccessAt = -1;

  for (const entry of entries) {
    const failure = classifyFailure(entry);
    if (failure) {
      if (!lastFailure || failure.at >= lastFailure.at) lastFailure = failure;
      continue;
    }
    if (!isBilledTurn(entry)) continue;
    const at = timestampOf(entry);
    if (at !== undefined && at > lastSuccessAt) lastSuccessAt = at;
  }

  if (!lastFailure || lastSuccessAt > lastFailure.at) return { state: 'ok' };

  if (lastFailure.kind === 'rate_limit') {
    const window = options.rateLimitWindowMs ?? RATE_LIMIT_WINDOW_MS;
    if (options.now - lastFailure.at >= window) return { state: 'ok' };
    return { state: 'rate_limited', failure: lastFailure };
  }
  if (lastFailure.kind === 'org_not_allowed') return { state: 'org_blocked', failure: lastFailure };
  return { state: 'needs_login', failure: lastFailure };
}
