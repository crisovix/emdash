import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
 * Kept as one small JSON file rather than in memory because the ACP worker and
 * the TUI worker are separate processes, and both spawn agents. Reads and writes
 * are synchronous because the only caller — a plugin's `buildCommand` — is
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

type RoutingFile = {
  version: 1;
  /** conversationId -> accountId */
  routes: Record<string, string>;
};

function emptyFile(): RoutingFile {
  return { version: 1, routes: {} };
}

function parse(raw: string): RoutingFile {
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as RoutingFile).version !== 1 ||
    typeof (parsed as RoutingFile).routes !== 'object' ||
    (parsed as RoutingFile).routes === null
  ) {
    return emptyFile();
  }
  const routes: Record<string, string> = {};
  for (const [key, value] of Object.entries((parsed as RoutingFile).routes)) {
    if (typeof value === 'string') routes[key] = value;
  }
  return { version: 1, routes };
}

/**
 * A store backed by `filePath`.
 *
 * `maxRoutes` caps the file: conversations are unbounded over time, and an
 * ever-growing map read on every spawn would eventually cost more than it saves.
 * Oldest bindings are dropped first — they belong to conversations long finished,
 * and a dropped binding degrades to hash routing, which is the pre-avoidance
 * behavior rather than a failure.
 */
export function createRoutingStore(
  filePath: string,
  options: { maxRoutes?: number } = {}
): RoutingStore {
  const maxRoutes = options.maxRoutes ?? 2000;
  // Insertion order carries age, which is what the cap trims by.
  let cache: RoutingFile | null = null;

  function load(): RoutingFile {
    if (cache) return cache;
    try {
      cache = parse(readFileSync(filePath, 'utf-8'));
    } catch {
      cache = emptyFile();
    }
    return cache;
  }

  function persist(next: RoutingFile): void {
    try {
      mkdirSync(path.dirname(filePath), { recursive: true });
      // Write-then-rename so a concurrent reader never sees a half-written file.
      // Two workers writing at once means last-one-wins on a lost binding, which
      // degrades to hash routing rather than to a corrupt file.
      const tmp = `${filePath}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(next)}\n`, 'utf-8');
      renameSync(tmp, filePath);
    } catch {
      // Best effort: an unwritable store must not stop a spawn.
    }
  }

  return {
    get(conversationId) {
      if (conversationId === '') return undefined;
      // Re-read rather than trust the cache: the other worker may have written
      // this binding since, and a stale miss would route a resume incorrectly.
      cache = null;
      return load().routes[conversationId];
    },

    remember(conversationId, accountId) {
      if (conversationId === '') return;
      cache = null;
      const current = load();
      if (current.routes[conversationId] === accountId) return;

      const routes = { ...current.routes, [conversationId]: accountId };
      const keys = Object.keys(routes);
      const trimmed =
        keys.length <= maxRoutes
          ? routes
          : Object.fromEntries(keys.slice(keys.length - maxRoutes).map((k) => [k, routes[k]!]));

      const next: RoutingFile = { version: 1, routes: trimmed };
      cache = next;
      persist(next);
    },
  };
}

/** Where the pool keeps its routing record: alongside the account dirs. */
export function defaultRoutingStorePath(realHomeDir: string): string {
  return path.join(realHomeDir, '.agentpool', 'routing.json');
}
