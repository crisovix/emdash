import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  accountState,
  accumulateUsage,
  parseTranscriptLine,
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
 * `since` skips files untouched before that instant — enough to scope a report
 * to a recent window without reading years of history.
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

  return {
    profile,
    usage: accumulateUsage(entries),
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

/** Reports for every account, read concurrently. */
export function readPoolReport(
  profiles: readonly PoolAccountProfile[],
  options: { now: number; since?: number; rateLimitWindowMs?: number }
): Promise<AccountReport[]> {
  return Promise.all(profiles.map((profile) => readAccountReport(profile, options)));
}
