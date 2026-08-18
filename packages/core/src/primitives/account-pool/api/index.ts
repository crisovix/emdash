/**
 * Per-account process env for the Account Pool: 4 CLI subscriptions (Claude
 * personal, Claude work, Antigravity personal, Antigravity work) treated as
 * schedulable capacity, isolated by process env rather than by credential-file
 * swapping. TS port of `run_as()` in the agentic-os spike
 * (scripts/fase0-spike.sh) — see that repo's docs/ESTADO-ACTUAL.md §2 for the
 * empirical validation behind each variable below.
 */

export type PoolProvider = 'claude' | 'antigravity';

export type PoolScope = 'work' | 'personal';

export type PoolAccountProfile = {
  /** Provider id of the account-bound plugin variant, e.g. 'claude-personal'. */
  id: string;
  provider: PoolProvider;
  scope: PoolScope;
  /** Short display label for the agent picker, e.g. 'personal'. */
  label: string;
  /** Isolated config dir for this account (CLAUDE_CONFIG_DIR for claude, fake HOME for antigravity). */
  dir: string;
};

/**
 * Antigravity has no auth subcommand and no isolated credential-dir flag: it
 * only isolates via a fake HOME, and only if DBUS_SESSION_BUS_ADDRESS points
 * nowhere — otherwise it writes the token to the GNOME keyring, which is
 * global per user session and HOME does not isolate it. GIT_CONFIG_GLOBAL
 * restores git identity that the fake HOME would otherwise hide.
 */
const NULL_DBUS_ADDRESS = 'unix:path=/nonexistent/bus';

/**
 * Env overrides to merge into an agent spawn for this account. Does not
 * include HOME's real-world default or PATH — callers merge this on top of
 * the process's normal allowlisted env, same as every other override in the
 * spawn-context chain (last write wins).
 */
export function envForAccount(
  profile: PoolAccountProfile,
  options: { realHomeDir: string }
): Record<string, string> {
  switch (profile.provider) {
    case 'claude':
      return { CLAUDE_CONFIG_DIR: profile.dir };
    case 'antigravity':
      return {
        HOME: profile.dir,
        DBUS_SESSION_BUS_ADDRESS: NULL_DBUS_ADDRESS,
        GIT_CONFIG_GLOBAL: `${options.realHomeDir}/.gitconfig`,
      };
  }
}
