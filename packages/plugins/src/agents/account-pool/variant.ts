import { envForAccount, type PoolAccountProfile } from '@emdash/core/primitives/account-pool/api';
import type {
  AcpSpawnContext,
  CLIAgentPluginProvider,
  CommandContext,
} from '@emdash/core/services/agent-plugins/api/plugins';

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
 * Config-file capabilities need care, because they are resolved from the
 * worker's own env rather than from this per-account override:
 * - hooks: redirected here to the account dir, so agent status events keep
 *   working per account.
 * - mcp and trust: turned off. Their helpers resolve paths against the host
 *   home dir with no override seam, so leaving them on would advertise
 *   features that write to the wrong account's config. The cost is that
 *   MCP servers must be configured per account dir by hand, and the agent
 *   shows its own trust prompt on first run in a new worktree.
 */
export function accountVariant(
  base: CLIAgentPluginProvider,
  profile: PoolAccountProfile,
  options: { realHomeDir: string }
): CLIAgentPluginProvider {
  const accountEnv = envForAccount(profile, options);
  const { prompt, acp, hooks } = base.behavior;

  return {
    ...base,
    metadata: {
      ...base.metadata,
      id: profile.id,
      name: `${base.metadata.name} · ${profile.label}`,
    },
    capabilities: {
      ...base.capabilities,
      mcp: { kind: 'none' },
      trust: { kind: 'none' },
    },
    behavior: {
      ...base.behavior,
      mcp: undefined,
      trust: undefined,
      ...(hooks
        ? { hooks: { ...hooks, resolveConfigRoots: () => [profile.dir] } }
        : {}),
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
