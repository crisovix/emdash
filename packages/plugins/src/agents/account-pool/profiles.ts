import os from 'node:os';
import type { PoolAccountProfile } from '@emdash/core/primitives/account-pool/api';

/**
 * The Account Pool's account list. This is the fork's configuration point:
 * editing this file is how accounts are added, removed, or repointed.
 *
 * Work-scoped dirs deliberately reuse the pre-existing authenticated dirs
 * (`~/.claude-oddness`, `~/.gemini-oddness`) rather than living under
 * `~/.agentpool/`, so no re-login is needed for them.
 *
 * Each dir must already be logged in — the pool does not perform auth. See the
 * agentic-os repo's docs/ESTADO-ACTUAL.md §7 for the login commands, and note
 * that Antigravity's login is interactive and needs a real TTY.
 */
export function poolAccountProfiles(homeDir: string = os.homedir()): PoolAccountProfile[] {
  return [
    {
      id: 'claude-personal',
      provider: 'claude',
      scope: 'personal',
      label: 'personal',
      dir: `${homeDir}/.agentpool/claude-personal`,
    },
    {
      id: 'claude-empresa',
      provider: 'claude',
      scope: 'work',
      label: 'empresa',
      dir: `${homeDir}/.claude-oddness`,
    },
    {
      id: 'gemini-personal',
      provider: 'antigravity',
      scope: 'personal',
      label: 'personal',
      dir: `${homeDir}/.agentpool/gemini-personal`,
    },
    {
      id: 'gemini-empresa',
      provider: 'antigravity',
      scope: 'work',
      label: 'empresa',
      dir: `${homeDir}/.gemini-oddness`,
    },
  ];
}
