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

/**
 * A provider that spreads conversations across every account of one CLI, so
 * tasks distribute over the subscriptions without the user choosing per task.
 *
 * Assignment is a pure hash of the conversation id, not a counter, because a
 * conversation must always land back on the same account: session history and
 * project state live inside each account's own config dir, so resuming against
 * a different account would not find the session. Hashing gets that for free —
 * no persisted mapping to keep in sync, and it survives app restarts, which an
 * in-memory round-robin would not.
 *
 * The trade-off is that it balances by conversation count, not by quota actually
 * consumed: a long task and a short one weigh the same, and it cannot know an
 * account is rate-limited. Editing the account list also re-maps existing
 * conversations, which breaks resume for the ones that move — change the list
 * between sessions, not while tasks are live.
 *
 * The per-account variants stay registered; this is an extra option, not a
 * replacement for picking one deliberately.
 */
export function autoAccountProvider(
  base: CLIAgentPluginProvider,
  profiles: readonly PoolAccountProfile[],
  options: { realHomeDir: string }
): CLIAgentPluginProvider {
  const accounts = profiles.map((profile) => ({
    profile,
    env: envForAccount(profile, options),
    dirFromHome: relativeToHome(options.realHomeDir, profile.dir),
  }));
  const { prompt, acp, hooks, trust } = base.behavior;

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
                return { ...command, env: { ...command.env, ...pickAccount(accounts, key).env } };
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
                return { ...spawn, env: { ...spawn.env, ...pickAccount(accounts, ctx.cwd).env } };
              },
            },
          }
        : {}),
    },
  };
}
