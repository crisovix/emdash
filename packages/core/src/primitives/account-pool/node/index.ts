import { open, readdir, readFile, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import {
  accountState,
  accumulateUsage,
  parseTranscriptLine,
  RATE_LIMIT_WINDOW_MS,
  type AccountState,
  type AccountUsage,
  type PoolAccountProfile,
  type TranscriptEntry,
} from '../api';

export type AccountReport = {
  profile: PoolAccountProfile;
  usage: AccountUsage;
  status: AccountState;
  /** Transcript files read. Zero means a fresh or never-used account dir. */
  transcripts: number;
  /** Set when the account dir could not be read at all. */
  unreadable?: string;
};

/**
 * Claude Code's transcript root inside a config dir: one directory per project
 * (the cwd with separators flattened), each holding `<sessionId>.jsonl`.
 */
function transcriptRoot(accountDir: string): string {
  return path.join(accountDir, 'projects');
}

async function listTranscripts(accountDir: string): Promise<string[]> {
  const root = transcriptRoot(accountDir);
  let projects: string[];
  try {
    projects = await readdir(root);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const project of projects) {
    const dir = path.join(root, project);
    // Sub-agent transcripts live one level deeper, so walk instead of globbing
    // a fixed depth.
    await collectJsonl(dir, files);
  }
  return files;
}

async function collectJsonl(dir: string, into: string[]): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const full = path.join(dir, name);
    if (name.endsWith('.jsonl')) {
      into.push(full);
      continue;
    }
    try {
      if ((await stat(full)).isDirectory()) await collectJsonl(full, into);
    } catch {
      // Transcripts churn while sessions run; a vanished entry is not an error.
    }
  }
}

async function* readEntries(files: string[], since?: number): AsyncGenerator<TranscriptEntry> {
  for (const file of files) {
    if (since !== undefined) {
      try {
        if ((await stat(file)).mtimeMs < since) continue;
      } catch {
        continue;
      }
    }
    let raw: string;
    try {
      raw = await readFile(file, 'utf-8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      const entry = parseTranscriptLine(line);
      if (entry) yield entry;
    }
  }
}

/**
 * What one account has spent and whether it is usable, read from its own
 * transcripts. Only Claude accounts report anything: Antigravity keeps no
 * equivalent usage record on disk (see the fork's account-pool docs), so an
 * antigravity profile comes back with zeroed usage and state 'ok'.
 *
 * `since` scopes the report to a window. It skips files untouched before that
 * instant, and then drops individual turns older than it: a long-running session
 * touched today can hold turns from weeks ago, so filtering only by file would
 * report those inside a "last 7 days" window.
 *
 * Availability is judged on the unfiltered entries, because a failure outside the
 * window can still be the account's latest word on whether it works.
 */
export async function readAccountReport(
  profile: PoolAccountProfile,
  options: { now: number; since?: number; rateLimitWindowMs?: number }
): Promise<AccountReport> {
  if (profile.provider !== 'claude') {
    return {
      profile,
      usage: { ...zeroUsage() },
      status: { state: 'ok' },
      transcripts: 0,
      unreadable: 'provider keeps no on-disk usage record',
    };
  }

  try {
    await stat(profile.dir);
  } catch {
    return {
      profile,
      usage: { ...zeroUsage() },
      status: { state: 'ok' },
      transcripts: 0,
      unreadable: 'account dir not found',
    };
  }

  const files = await listTranscripts(profile.dir);
  // One pass would need the entries twice; transcripts are small enough that
  // materializing them is simpler than two walks.
  const entries: TranscriptEntry[] = [];
  for await (const entry of readEntries(files, options.since)) entries.push(entry);

  const counted =
    options.since === undefined
      ? entries
      : entries.filter((entry) => {
          if (!entry.timestamp) return true;
          const at = Date.parse(entry.timestamp);
          return Number.isNaN(at) || at >= options.since!;
        });

  return {
    profile,
    usage: accumulateUsage(counted),
    status: accountState(entries, {
      now: options.now,
      ...(options.rateLimitWindowMs !== undefined
        ? { rateLimitWindowMs: options.rateLimitWindowMs }
        : {}),
    }),
    transcripts: files.length,
  };
}

function zeroUsage(): AccountUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    thinkingTokens: 0,
    messages: 0,
    byModel: {},
  };
}

/**
 * Just the availability of an account, read cheaply enough to poll.
 *
 * `readAccountReport` walks every transcript, which on an established account
 * means tens of thousands of turns — fine for a report, far too slow to check
 * before spawning. Availability only depends on the newest events, so this reads
 * the tail of the few most recently touched transcripts instead.
 *
 * The bound is deliberate: a limit that predates those files has either been
 * superseded by later activity or aged out of the session window anyway.
 */
export async function readAccountStateQuick(
  profile: PoolAccountProfile,
  options: {
    now: number;
    rateLimitWindowMs?: number;
    /** Newest transcripts to inspect. */
    maxFiles?: number;
    /** Bytes to read from the end of each. */
    tailBytes?: number;
  }
): Promise<AccountState> {
  if (profile.provider !== 'claude') return { state: 'ok' };

  const window = options.rateLimitWindowMs ?? RATE_LIMIT_WINDOW_MS;
  const maxFiles = options.maxFiles ?? 8;
  const tailBytes = options.tailBytes ?? 64 * 1024;

  let files: string[];
  try {
    files = await listTranscripts(profile.dir);
  } catch {
    return { state: 'ok' };
  }

  const stamped: { file: string; mtimeMs: number; size: number }[] = [];
  for (const file of files) {
    try {
      const info = await stat(file);
      stamped.push({ file, mtimeMs: info.mtimeMs, size: info.size });
    } catch {
      // Raced with a session writing; skip.
    }
  }
  // Newest first, then bounded by maxFiles below. Deliberately NOT filtered by
  // age: only `rate_limit` expires, so dropping old files would hide a
  // `needs_login` or `org_blocked` that is still in force — the account would
  // look healthy again after a few idle hours and keep being handed work that
  // cannot run. Expiry is `accountState`'s decision, which knows the kind.
  stamped.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const entries: TranscriptEntry[] = [];
  for (const { file, size } of stamped.slice(0, maxFiles)) {
    for (const line of (await readTail(file, size, tailBytes)).split('\n')) {
      const entry = parseTranscriptLine(line);
      if (entry) entries.push(entry);
    }
  }

  return accountState(entries, { now: options.now, rateLimitWindowMs: window });
}

async function readTail(file: string, size: number, tailBytes: number): Promise<string> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(file, 'r');
    const start = Math.max(0, size - tailBytes);
    const length = size - start;
    if (length <= 0) return '';
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    const text = buffer.toString('utf-8');
    // A mid-file start almost certainly lands inside a line; drop the fragment.
    return start === 0 ? text : text.slice(text.indexOf('\n') + 1);
  } catch {
    return '';
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Reports for every account, read concurrently. */
export function readPoolReport(
  profiles: readonly PoolAccountProfile[],
  options: { now: number; since?: number; rateLimitWindowMs?: number }
): Promise<AccountReport[]> {
  return Promise.all(profiles.map((profile) => readAccountReport(profile, options)));
}
