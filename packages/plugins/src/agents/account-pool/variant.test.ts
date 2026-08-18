import type { PoolAccountProfile } from '@emdash/core/primitives/account-pool/api';
import { describe, expect, it } from 'vitest';
import { provider as antigravity } from '../impl/antigravity';
import { provider as claude } from '../impl/claude';
import { pluginRegistry } from '../registry';
import { poolAccountProfiles } from './profiles';
import { accountVariant } from './variant';

const REAL_HOME = '/home/u';

const claudeWork: PoolAccountProfile = {
  id: 'claude-empresa',
  provider: 'claude',
  scope: 'work',
  label: 'empresa',
  dir: '/home/u/.claude-oddness',
};

const antigravityPersonal: PoolAccountProfile = {
  id: 'gemini-personal',
  provider: 'antigravity',
  scope: 'personal',
  label: 'personal',
  dir: '/home/u/.agentpool/gemini-personal',
};

const promptCtx = {
  cli: '/usr/bin/claude',
  autoApprove: false,
  model: '',
};

describe('accountVariant', () => {
  it('gives the variant its own provider id and a labelled name', () => {
    const variant = accountVariant(claude, claudeWork, { realHomeDir: REAL_HOME });
    expect(variant.metadata.id).toBe('claude-empresa');
    expect(variant.metadata.name).toBe('Claude Code · empresa');
    // The base provider must stay untouched — variants are derived, not mutated.
    expect(claude.metadata.id).toBe('claude');
  });

  it('injects CLAUDE_CONFIG_DIR into the TUI command env', () => {
    const variant = accountVariant(claude, claudeWork, { realHomeDir: REAL_HOME });
    const command = variant.behavior.prompt!.buildCommand(promptCtx);
    expect(command.env.CLAUDE_CONFIG_DIR).toBe('/home/u/.claude-oddness');
  });

  it('injects CLAUDE_CONFIG_DIR into the ACP spawn env, preserving base env', () => {
    const variant = accountVariant(claude, claudeWork, { realHomeDir: REAL_HOME });
    const spawn = variant.behavior.acp!.buildSpawn({
      cwd: '/repo',
      env: {},
      cli: '/usr/bin/claude',
    });
    expect(spawn.env?.CLAUDE_CONFIG_DIR).toBe('/home/u/.claude-oddness');
    // The base plugin's own env must survive the merge.
    expect(spawn.env?.CLAUDE_CODE_EXECUTABLE).toBe('/usr/bin/claude');
  });

  it('antigravity needs all three vars, since HOME alone does not isolate it', () => {
    const variant = accountVariant(antigravity, antigravityPersonal, { realHomeDir: REAL_HOME });
    const command = variant.behavior.prompt!.buildCommand({ ...promptCtx, cli: '/usr/bin/agy' });
    expect(command.env).toMatchObject({
      HOME: '/home/u/.agentpool/gemini-personal',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent/bus',
      GIT_CONFIG_GLOBAL: '/home/u/.gitconfig',
    });
  });

  it('two accounts of one CLI resolve to different dirs — the point of the pool', () => {
    const [personal] = poolAccountProfiles(REAL_HOME).filter((p) => p.id === 'claude-personal');
    const work = accountVariant(claude, claudeWork, { realHomeDir: REAL_HOME });
    const personalVariant = accountVariant(claude, personal!, { realHomeDir: REAL_HOME });
    const dirOf = (v: typeof work) =>
      v.behavior.prompt!.buildCommand(promptCtx).env.CLAUDE_CONFIG_DIR;
    expect(dirOf(work)).not.toBe(dirOf(personalVariant));
  });
});

describe('registry', () => {
  it('registers every pool account alongside the untouched base providers', () => {
    const ids = pluginRegistry.getAll().map((p) => p.metadata.id);
    expect(ids).toContain('claude');
    expect(ids).toContain('antigravity');
    for (const profile of poolAccountProfiles()) {
      expect(ids).toContain(profile.id);
    }
  });
});
