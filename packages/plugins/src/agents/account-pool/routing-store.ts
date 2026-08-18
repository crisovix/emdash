import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Which account each conversation was actually spawned on.
 *
 * The auto provider normally derives the account from a hash of the conversation
 * id, which needs no storage. But once it starts *avoiding* a rate-limited
 * account, the choice stops being a function of the id alone: a conversation
 * that was pushed onto its second choice would hash back to its first on resume,
 * and resuming against the wrong config dir cannot find the session. So a
 * deviation has to be remembered.
 *
 * Stored as one small file rather than in memory because the ACP worker and the
 * TUI worker are separate processes, and both spawn agents. Reads and writes are
 * synchronous because the only caller — a plugin's `buildCommand` — is
 * synchronous; the cost is trivial next to spawning a CLI process.
 *
 * Every operation fails open: a missing, unreadable, or corrupt file degrades to
 * pure hash routing rather than blocking a spawn.
 */
export type RoutingStore = {
  /** The account a conversation is already bound to, if any. */
  get(conversationId: string): string | undefined;
  /** Bind a conversation to an account. Ignored if it is already bound. */
  remember(conversationId: string, accountId: string): void;
};

/** One binding, kept short because the file is read on every spawn. */
type Line = { c: string; a: string };

function parseLines(raw: string): Map<string, string> {
  const routes = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const { c, a } = parsed as Line;
      // Later lines win, which is what makes an append a valid update.
      if (typeof c === 'string' && typeof a === 'string' && c !== '') routes.set(c, a);
    } catch {
      // A torn final line is expected while another process appends.
    }
  }
  return routes;
}

/**
 * A store backed by `filePath`, written as an append-only log.
 *
 * Append rather than rewrite because two worker processes both bind conversations:
 * a read-modify-write loses whichever update landed second, and losing the binding
 * of a conversation that *was* deviated by failover breaks its resume. A single
 * short `O_APPEND` write is atomic between processes, so both bindings survive.
 * Bindings are only ever added, never edited, which is what makes a log sufficient.
 *
 * `maxRoutes` bounds the file, since conversations accumulate without end and this
 * is read synchronously on every spawn. Compaction rewrites the newest bindings
 * once the log grows past twice that. Two costs, both deliberate and bounded to
 * conversations long finished: a compaction racing an append can drop that append,
 * and a binding trimmed away falls back to the hash — which for a deviated
 * conversation means its resume may not find its session.
 */
export function createRoutingStore(
  filePath: string,
  options: { maxRoutes?: number } = {}
): RoutingStore {
  const maxRoutes = options.maxRoutes ?? 2000;

  function read(): { routes: Map<string, string>; lines: number } {
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const lines = raw.split('\n').filter((line) => line.trim() !== '').length;
      return { routes: parseLines(raw), lines };
    } catch {
      return { routes: new Map(), lines: 0 };
    }
  }

  /** Collapse the log to the newest bindings. Best effort; never throws. */
  function compact(routes: Map<string, string>): void {
    try {
      const kept = [...routes.entries()].slice(-maxRoutes);
      const body = kept.map(([c, a]) => JSON.stringify({ c, a })).join('\n');
      const tmp = `${filePath}.${process.pid}.tmp`;
      writeFileSync(tmp, body === '' ? '' : `${body}\n`, 'utf-8');
      // Rename so a concurrent reader never sees a half-written file.
      renameSync(tmp, filePath);
    } catch {
      // Leaving the log long is harmless; it will be retried next time.
    }
  }

  return {
    get(conversationId) {
      if (conversationId === '') return undefined;
      // Always re-read: the other worker may have appended this binding since,
      // and a stale miss would route a resume to the wrong account.
      return read().routes.get(conversationId);
    },

    remember(conversationId, accountId) {
      if (conversationId === '' || accountId === '') return;
      try {
        const { routes, lines } = read();
        if (routes.get(conversationId) === accountId) return;

        mkdirSync(path.dirname(filePath), { recursive: true });
        appendFileSync(
          filePath,
          `${JSON.stringify({ c: conversationId, a: accountId })}\n`,
          'utf-8'
        );

        if (lines + 1 > maxRoutes * 2) {
          routes.set(conversationId, accountId);
          compact(routes);
        }
      } catch {
        // Best effort: an unwritable store must not stop a spawn.
      }
    },
  };
}

/** Where the pool keeps its routing record: alongside the account dirs. */
export function defaultRoutingStorePath(realHomeDir: string): string {
  return path.join(realHomeDir, '.agentpool', 'routing.jsonl');
}

/**
 * Every binding in the log, for reporting. Exported so readers do not re-implement
 * the log format — the store owns it.
 *
 * An absent or unreadable file yields an empty map: it means the auto router has
 * not run, not that something is wrong.
 */
export function readRoutingBindings(filePath: string): Map<string, string> {
  try {
    return parseLines(readFileSync(filePath, 'utf-8'));
  } catch {
    return new Map();
  }
}
