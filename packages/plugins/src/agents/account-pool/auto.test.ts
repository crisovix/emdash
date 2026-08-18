import type { PoolAccountProfile } from '@emdash/core/primitives/account-pool/api';
import { describe, expect, it } from 'vitest';
import { provider as claude } from '../impl/claude';
import { pluginRegistry } from '../registry';
import { autoAccountProvider, pickAccount } from './auto';
import { poolAccountProfiles } from './profiles';

const REAL_HOME = '/home/u';

const claudeAccounts: PoolAccountProfile[] = [
  {
    id: 'claude-personal',
    provider: 'claude',
    scope: 'personal',
    label: 'personal',
    dir: '/home/u/.agentpool/claude-personal',
  },
  {
    id: 'claude-empresa',
    provider: 'claude',
    scope: 'work',
    label: 'empresa',
    dir: '/home/u/.claude-oddness',
  },
];

const auto = autoAccountProvider(claude, claudeAccounts, { realHomeDir: REAL_HOME });

const dirFor = (conversationId: string): string | undefined =>
  auto.behavior.prompt!.buildCommand({
    cli: '/usr/bin/claude',
    autoApprove: false,
    model: '',
    sessionId: conversationId,
  }).env.CLAUDE_CONFIG_DIR;

describe('autoAccountProvider routing', () => {
  it('always sends one conversation to the same account, so resume finds its session', () => {
    // Session history lives inside each account's config dir, so this is a
    // correctness property, not a preference.
    const first = dirFor('conv-abc');
    for (let i = 0; i < 20; i++) expect(dirFor('conv-abc')).toBe(first);
  });

  it('routes to an account dir that belongs to the pool', () => {
    const dirs = claudeAccounts.map((a) => a.dir);
    for (const id of ['a', 'b', 'c', 'd']) expect(dirs).toContain(dirFor(id));
  });

  it('spreads conversations across every account', () => {
    const used = new Set<string | undefined>();
    for (let i = 0; i < 200; i++) used.add(dirFor(`conv-${i}`));
    expect(used).toEqual(new Set(claudeAccounts.map((a) => a.dir)));
  });

  it('distributes roughly evenly over many conversations', () => {
    const counts = new Map<string | undefined, number>();
    const total = 2000;
    for (let i = 0; i < total; i++) {
      const dir = dirFor(`conversation-uuid-${i}`);
      counts.set(dir, (counts.get(dir) ?? 0) + 1);
    }
    // Uniform-ish: no account takes more than 65% of a 2-account split.
    for (const count of counts.values()) expect(count).toBeLessThan(total * 0.65);
  });

  it('keeps one ACP workspace on one account, since connections pool per cwd', () => {
    const spawnDir = (cwd: string) =>
      auto.behavior.acp!.buildSpawn({ cwd, env: {}, cli: '/usr/bin/claude' }).env
        ?.CLAUDE_CONFIG_DIR;
    expect(spawnDir('/repo/one')).toBe(spawnDir('/repo/one'));
    expect(claudeAccounts.map((a) => a.dir)).toContain(spawnDir('/repo/one'));
  });
});

describe('pickAccount', () => {
  it('is pure and total over the account list', () => {
    const accounts = ['a', 'b', 'c'];
    expect(pickAccount(accounts, 'k')).toBe(pickAccount(accounts, 'k'));
    for (const key of ['', 'x', 'long-conversation-uuid']) {
      expect(accounts).toContain(pickAccount(accounts, key));
    }
  });
});

describe('autoAccountProvider capabilities', () => {
  it('covers every account dir for hooks and trust, since routing is per spawn', () => {
    expect(
      auto.behavior.hooks!.resolveConfigRoots({ env: {}, homeDir: REAL_HOME, platform: 'linux' })
    ).toEqual(claudeAccounts.map((a) => a.dir));
  });

  it('trusts a workspace in every account, so whichever is picked is ready', async () => {
    const files = new Map<string, string>();
    const fs = {
      read: async (p: string) => files.get(p) ?? null,
      write: async (p: string, c: string) => void files.set(p, c),
      delete: async (p: string) => void files.delete(p),
      exists: async (p: string) => files.has(p),
      list: async () => [...files.keys()],
    };
    await auto.behavior.trust!.trustWorkspace(fs, { workspacePath: '/repo/wt' });
    expect([...files.keys()].sort()).toEqual([
      '.agentpool/claude-personal/.claude.json',
      '.claude-oddness/.claude.json',
    ]);
  });

  it('leaves MCP off, since one fs cannot represent every account', () => {
    expect(auto.capabilities.mcp).toEqual({ kind: 'none' });
    expect(auto.behavior.mcp).toBeUndefined();
  });
});

describe('registry', () => {
  it('registers an auto provider only for CLIs with more than one account', () => {
    const ids = pluginRegistry.getAll().map((p) => p.metadata.id);
    const profiles = poolAccountProfiles();
    for (const providerKey of ['claude', 'antigravity']) {
      const count = profiles.filter((p) => p.provider === providerKey).length;
      if (count >= 2) expect(ids).toContain(`${providerKey}-auto`);
      else expect(ids).not.toContain(`${providerKey}-auto`);
    }
  });
});
