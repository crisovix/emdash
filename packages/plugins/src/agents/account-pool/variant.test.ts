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

/** In-memory PluginFs rooted at the home dir, like the one callers pass in. */
function fakeHomeFs(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed));
  return {
    files,
    fs: {
      read: async (p: string) => files.get(p) ?? null,
      write: async (p: string, content: string) => void files.set(p, content),
      delete: async (p: string) => void files.delete(p),
      exists: async (p: string) => files.has(p),
      list: async () => [...files.keys()],
    },
  };
}

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

describe('accountVariant config-file capabilities', () => {
  const variant = accountVariant(claude, claudeWork, { realHomeDir: REAL_HOME });

  it('writes trust into the account dir, not the host home', async () => {
    const { files, fs } = fakeHomeFs();
    await variant.behavior.trust!.trustWorkspace(fs, { workspacePath: '/repo/worktree-1' });
    // Home-rooted fs + '.claude-oddness' prefix = <account dir>/.claude.json.
    expect([...files.keys()]).toEqual(['.claude-oddness/.claude.json']);
    expect(JSON.parse(files.get('.claude-oddness/.claude.json')!)).toMatchObject({
      projects: { '/repo/worktree-1': { hasTrustDialogAccepted: true } },
    });
  });

  it('reads MCP servers from the account dir', async () => {
    const { fs } = fakeHomeFs({
      '.claude-oddness/.claude.json': JSON.stringify({
        mcpServers: { 'in-account': { command: 'account-server' } },
      }),
      // Same key in the host home must not leak into the account's view.
      '.claude.json': JSON.stringify({ mcpServers: { 'in-home': { command: 'home-server' } } }),
    });
    const servers = await variant.behavior.mcp!.readServers(fs);
    expect(servers.map((s) => s.name)).toEqual(['in-account']);
  });

  it('points hooks at the account dir', () => {
    const roots = variant.behavior.hooks!.resolveConfigRoots({
      env: {},
      homeDir: REAL_HOME,
      platform: 'linux',
    });
    expect(roots).toEqual(['/home/u/.claude-oddness']);
  });

  it('turns mcp and trust off for an account dir outside the home dir', () => {
    const outside = accountVariant(
      claude,
      { ...claudeWork, dir: '/opt/elsewhere/claude' },
      { realHomeDir: REAL_HOME }
    );
    expect(outside.capabilities.mcp).toEqual({ kind: 'none' });
    expect(outside.capabilities.trust).toEqual({ kind: 'none' });
    expect(outside.behavior.mcp).toBeUndefined();
    expect(outside.behavior.trust).toBeUndefined();
    // Spawn isolation still works — that never depended on the fs.
    expect(outside.behavior.prompt!.buildCommand(promptCtx).env.CLAUDE_CONFIG_DIR).toBe(
      '/opt/elsewhere/claude'
    );
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
