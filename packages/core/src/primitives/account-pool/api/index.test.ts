import { describe, expect, it } from 'vitest';
import { envForAccount, type PoolAccountProfile } from './index';

const REAL_HOME = '/home/u';

describe('envForAccount', () => {
  it('claude: isolates via CLAUDE_CONFIG_DIR only', () => {
    const profile: PoolAccountProfile = {
      id: 'claude-personal',
      provider: 'claude',
      scope: 'personal',
      label: 'personal',
      dir: '/home/u/.agentpool/claude-personal',
    };
    expect(envForAccount(profile, { realHomeDir: REAL_HOME })).toEqual({
      CLAUDE_CONFIG_DIR: '/home/u/.agentpool/claude-personal',
    });
  });

  it('antigravity: fakes HOME, neutralizes DBUS, and restores real git identity', () => {
    const profile: PoolAccountProfile = {
      id: 'gemini-personal',
      provider: 'antigravity',
      scope: 'personal',
      label: 'personal',
      dir: '/home/u/.agentpool/gemini-personal',
    };
    expect(envForAccount(profile, { realHomeDir: REAL_HOME })).toEqual({
      HOME: '/home/u/.agentpool/gemini-personal',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent/bus',
      GIT_CONFIG_GLOBAL: '/home/u/.gitconfig',
    });
  });

  it('antigravity: GIT_CONFIG_GLOBAL always points at the real home, not the fake one', () => {
    const workProfile: PoolAccountProfile = {
      id: 'gemini-empresa',
      provider: 'antigravity',
      scope: 'work',
      label: 'empresa',
      dir: '/home/u/.gemini-oddness',
    };
    const env = envForAccount(workProfile, { realHomeDir: REAL_HOME });
    expect(env.GIT_CONFIG_GLOBAL).toBe(`${REAL_HOME}/.gitconfig`);
    expect(env.GIT_CONFIG_GLOBAL).not.toContain(workProfile.dir);
  });
});
