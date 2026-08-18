import { envForAccount, type PoolAccountProfile } from '@emdash/core/primitives/account-pool/api';
import type {
  AcpSpawnContext,
  CLIAgentPluginProvider,
  CommandContext,
  PluginFs,
} from '@emdash/core/services/agent-plugins/api/plugins';
import { prefixedFs, relativeToHome } from './fs-reroot';

/**
 * Bind a base agent provider to one Account Pool account, producing a distinct
 * provider whose spawns carry that account's isolation env.
 *
 * Accounts are modelled as provider variants rather than as a per-task setting
 * because every spawn path already resolves env per `providerId`
 * (`AgentPluginHost.buildPromptCommand` / `buildAcpSpawn`). That makes N
 * accounts of the same CLI runnable concurrently — each conversation spawns its
 * own process with its own env — with no shared mutable state to serialize on.
 *
 * Config-file capabilities are resolved from the worker's own env, not from this
 * per-account override, so each is re-rooted at the account dir here:
 * - hooks: `resolveConfigRoots` returns the account dir, which the hook
 *   installer turns into an fs itself.
 * - mcp and trust: their fs is wrapped so `.claude.json` resolves inside the
 *   account dir — verified as the real layout: with `CLAUDE_CONFIG_DIR` set,
 *   Claude Code keeps `.claude.json` inside that dir.
 *
 * Trust matters more than it looks: Emdash gives every task its own worktree, so
 * without it the agent re-prompts for trust on each new task.
 *
 * An account dir outside the home dir cannot be reached through the home-rooted
 * fs the callers pass, so mcp and trust are turned off for it rather than left
 * pointing at the wrong account's config.
 */
export function accountVariant(
  base: CLIAgentPluginProvider,
  profile: PoolAccountProfile,
  options: { realHomeDir: string }
): CLIAgentPluginProvider {
  const accountEnv = envForAccount(profile, options);
  const { prompt, acp, hooks, mcp, trust } = base.behavior;

  // Null disables the fs-rooted capabilities; see relativeToHome.
  const dirFromHome = relativeToHome(options.realHomeDir, profile.dir);
  const canRerootFs = dirFromHome !== null;

  return {
    ...base,
    metadata: {
      ...base.metadata,
      id: profile.id,
      name: `${base.metadata.name} · ${profile.label}`,
    },
    capabilities: {
      ...base.capabilities,
      ...(canRerootFs ? {} : { mcp: { kind: 'none' }, trust: { kind: 'none' } }),
    },
    behavior: {
      ...base.behavior,
      ...(canRerootFs
        ? {
            ...(mcp
              ? {
                  mcp: {
                    readServers: (fs: PluginFs) => mcp.readServers(prefixedFs(fs, dirFromHome)),
                    writeServers: (fs: PluginFs, servers) =>
                      mcp.writeServers(prefixedFs(fs, dirFromHome), servers),
                    removeServer: (fs: PluginFs, name: string) =>
                      mcp.removeServer(prefixedFs(fs, dirFromHome), name),
                  },
                }
              : {}),
            ...(trust
              ? {
                  trust: {
                    ...trust,
                    trustWorkspace: (fs: PluginFs, ctx) =>
                      trust.trustWorkspace(prefixedFs(fs, dirFromHome), ctx),
                  },
                }
              : {}),
          }
        : { mcp: undefined, trust: undefined }),
      ...(hooks ? { hooks: { ...hooks, resolveConfigRoots: () => [profile.dir] } } : {}),
      ...(prompt
        ? {
            prompt: {
              ...prompt,
              buildCommand: (ctx: CommandContext) => {
                const command = prompt.buildCommand(ctx);
                return { ...command, env: { ...command.env, ...accountEnv } };
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
                return { ...spawn, env: { ...spawn.env, ...accountEnv } };
              },
            },
          }
        : {}),
    },
  };
}
