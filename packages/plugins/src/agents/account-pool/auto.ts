import { envForAccount, type PoolAccountProfile } from '@emdash/core/primitives/account-pool/api';
import type {
  AcpSpawnContext,
  CLIAgentPluginProvider,
  CommandContext,
  PluginFs,
  TrustContext,
} from '@emdash/core/services/agent-plugins/api/plugins';
import { prefixedFs, relativeToHome } from './fs-reroot';

/**
 * FNV-1a. Any stable string hash works here; what matters is that it is pure
 * and identical across processes and restarts.
 */
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The account a given routing key maps to. Pure: same key, same account. */
export function pickAccount<T>(accounts: readonly T[], key: string): T {
  return accounts[hash(key) % accounts.length]!;
}

type RoutableAccount = { profile: PoolAccountProfile; env: Record<string, string> };

/**
 * The account to spawn on, and whether that choice needs remembering.
 *
 * Three rules, in order:
 *
 * 1. A conversation already bound to an account keeps it. Its session lives in
 *    that account's config dir, so moving it would leave the session unfindable.
 *    This outranks availability: a bound account that is now rate-limited is
 *    still the only place the conversation can continue.
 * 2. A resume with no binding falls back to the hash. That covers conversations
 *    started before any binding existed, and reproduces the original behavior.
 * 3. A fresh conversation prefers an available account, and the choice is
 *    returned as one to remember — precisely because it may deviate from the
 *    hash, which is what rule 1 then has to honour.
 */
export function chooseAccount<T extends RoutableAccount>(
  accounts: readonly T[],
  input: {
    key: string;
    isResuming: boolean;
    boundAccountId?: string;
    unavailableIds: ReadonlySet<string>;
  }
): { account: T; bind: boolean } {
  const bound = input.boundAccountId
    ? accounts.find((a) => a.profile.id === input.boundAccountId)
    : undefined;
  if (bound) return { account: bound, bind: false };

  if (input.isResuming) return { account: pickAccount(accounts, input.key), bind: false };

  const available = accounts.filter((a) => !input.unavailableIds.has(a.profile.id));
  // All unavailable means the information is useless, not that nothing can run:
  // fall back to the full list so a spawn is still attempted.
  const pool = available.length > 0 ? available : accounts;
  return { account: pickAccount(pool, input.key), bind: true };
}

export type AutoAccountProviderOptions = {
  realHomeDir: string;
  /**
   * Accounts to keep new work away from. Omitted means no avoidance, which is
   * plain hash routing.
   */
  unavailableIds?: (now: number) => ReadonlySet<string>;
  /** Where a fresh conversation's account choice is recorded. */
  routing?: {
    get(conversationId: string): string | undefined;
    remember(conversationId: string, accountId: string): void;
  };
  /** Injected for tests. */
  now?: () => number;
};

/**
 * A provider that spreads conversations across every account of one CLI, so
 * tasks distribute over the subscriptions without the user choosing per task.
 *
 * Assignment starts from a pure hash of the conversation id, not a counter,
 * because a conversation must always land back on the same account: session
 * history and project state live inside each account's own config dir, so
 * resuming against a different account would not find the session. Hashing gets
 * that for free and survives app restarts, which an in-memory round-robin would
 * not.
 *
 * When `unavailableIds` is supplied, a *fresh* conversation also steers away from
 * accounts that are rate-limited or unusable, and the account it lands on is
 * recorded through `routing` — once the choice can deviate from the hash, the
 * deviation is the only thing that makes a later resume correct. See
 * `chooseAccount` for the exact precedence.
 *
 * It still balances by conversation count rather than by quota consumed: a long
 * task and a short one weigh the same. Editing the account list also re-maps
 * conversations that have no recorded binding, which breaks resume for the ones
 * that move — change the list between sessions, not while tasks are live.
 *
 * The per-account variants stay registered; this is an extra option, not a
 * replacement for picking one deliberately.
 */
export function autoAccountProvider(
  base: CLIAgentPluginProvider,
  profiles: readonly PoolAccountProfile[],
  options: AutoAccountProviderOptions
): CLIAgentPluginProvider {
  const accounts = profiles.map((profile) => ({
    profile,
    env: envForAccount(profile, options),
    dirFromHome: relativeToHome(options.realHomeDir, profile.dir),
  }));
  const { prompt, acp, hooks, trust } = base.behavior;
  const now = options.now ?? (() => Date.now());
  const noneUnavailable: ReadonlySet<string> = new Set();

  /** Availability and routing are best-effort: neither may break a spawn. */
  function route(key: string, isResuming: boolean): Record<string, string> {
    let unavailableIds = noneUnavailable;
    try {
      unavailableIds = options.unavailableIds?.(now()) ?? noneUnavailable;
    } catch {
      unavailableIds = noneUnavailable;
    }

    let boundAccountId: string | undefined;
    try {
      boundAccountId = options.routing?.get(key);
    } catch {
      boundAccountId = undefined;
    }

    const { account, bind } = chooseAccount(accounts, {
      key,
      isResuming,
      ...(boundAccountId !== undefined ? { boundAccountId } : {}),
      unavailableIds,
    });

    if (bind && options.routing) {
      try {
        options.routing.remember(key, account.profile.id);
      } catch {
        // A lost binding degrades to hash routing, not to a failed spawn.
      }
    }
    return account.env;
  }

  return {
    ...base,
    metadata: {
      ...base.metadata,
      id: `${base.metadata.id}-auto`,
      name: `${base.metadata.name} · auto`,
      description:
        `${base.metadata.description} Spreads conversations across the pool accounts: ` +
        `${profiles.map((p) => p.label).join(', ')}.`,
    },
    capabilities: {
      ...base.capabilities,
      // A single fs cannot represent "every account", and a union of servers
      // across accounts has no meaningful write target. Configure MCP on a
      // specific account variant instead.
      mcp: { kind: 'none' },
    },
    behavior: {
      ...base.behavior,
      mcp: undefined,
      // Hooks and trust take every account dir: the routing key differs between
      // them and the spawn paths, so the only correct move is to cover all
      // candidates rather than guess which one a spawn will pick.
      ...(hooks
        ? {
            hooks: {
              ...hooks,
              resolveConfigRoots: () => accounts.map((a) => a.profile.dir),
            },
          }
        : {}),
      ...(trust
        ? {
            trust: {
              ...trust,
              trustWorkspace: async (fs: PluginFs, ctx: TrustContext) => {
                for (const account of accounts) {
                  if (account.dirFromHome === null) continue;
                  await trust.trustWorkspace(prefixedFs(fs, account.dirFromHome), ctx);
                }
              },
            },
          }
        : {}),
      ...(prompt
        ? {
            prompt: {
              ...prompt,
              buildCommand: (ctx: CommandContext) => {
                const command = prompt.buildCommand(ctx);
                // Emdash's conversation id: stable for the life of the
                // conversation, including across resumes.
                const key = ctx.sessionId ?? ctx.providerSessionId ?? '';
                const env = route(key, ctx.isResuming === true);
                return { ...command, env: { ...command.env, ...env } };
              },
            },
          }
        : {}),
      ...(acp
        ? {
            acp: {
              ...acp,
              buildSpawn: (ctx: AcpSpawnContext) => {
                const spawn = acp.buildSpawn(ctx);
                // ACP connections are pooled per (providerId, cwd), so the cwd
                // is the routing key that keeps one workspace on one account.
                // A connection is never "resumed" the way a TUI session is — the
                // pool key is the workspace itself — so it routes as fresh and
                // gets the same avoidance and binding as a new conversation.
                const env = route(ctx.cwd, false);
                return { ...spawn, env: { ...spawn.env, ...env } };
              },
            },
          }
        : {}),
    },
  };
}
