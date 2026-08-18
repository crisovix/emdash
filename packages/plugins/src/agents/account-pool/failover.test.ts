import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AccountState, PoolAccountProfile } from '@emdash/core/primitives/account-pool/api';
import { describe, expect, it, vi } from 'vitest';
import { provider as claude } from '../impl/claude';
import { autoAccountProvider, chooseAccount } from './auto';
import { createAvailabilityTracker } from './availability';
import { createRoutingStore } from './routing-store';

const REAL_HOME = '/home/u';

const profile = (id: string, dir: string): PoolAccountProfile => ({
  id,
  provider: 'claude',
  scope: 'personal',
  label: id,
  dir,
});

const A = profile('acct-a', '/home/u/.agentpool/a');
const B = profile('acct-b', '/home/u/.agentpool/b');

const accounts = [A, B].map((p) => ({ profile: p, env: { CLAUDE_CONFIG_DIR: p.dir } }));
const none: ReadonlySet<string> = new Set();

describe('chooseAccount precedence', () => {
  it('keeps a bound account even when it is unavailable, since the session lives there', () => {
    const { account, bind } = chooseAccount(accounts, {
      key: 'conv-1',
      isResuming: true,
      boundAccountId: 'acct-b',
      unavailableIds: new Set(['acct-b']),
    });
    expect(account.profile.id).toBe('acct-b');
    expect(bind).toBe(false);
  });

  it('falls back to the hash on a resume with no binding', () => {
    const withoutBinding = chooseAccount(accounts, {
      key: 'conv-1',
      isResuming: true,
      unavailableIds: none,
    });
    const fresh = chooseAccount(accounts, {
      key: 'conv-1',
      isResuming: false,
      unavailableIds: none,
    });
    expect(withoutBinding.account.profile.id).toBe(fresh.account.profile.id);
    expect(withoutBinding.bind).toBe(false);
  });

  it('steers a fresh conversation away from an unavailable account', () => {
    // Whichever the hash prefers, the result must be the available one.
    for (const key of ['k1', 'k2', 'k3', 'k4']) {
      const { account, bind } = chooseAccount(accounts, {
        key,
        isResuming: false,
        unavailableIds: new Set(['acct-a']),
      });
      expect(account.profile.id).toBe('acct-b');
      expect(bind).toBe(true);
    }
  });

  it('still spawns when every account is unavailable, rather than refusing', () => {
    const { account } = chooseAccount(accounts, {
      key: 'k',
      isResuming: false,
      unavailableIds: new Set(['acct-a', 'acct-b']),
    });
    expect(['acct-a', 'acct-b']).toContain(account.profile.id);
  });
});

describe('createRoutingStore', () => {
  const storePath = (): string => path.join(mkdtempSync(path.join(tmpdir(), 'pool-')), 'r.json');

  it('remembers and returns a binding', () => {
    const store = createRoutingStore(storePath());
    expect(store.get('conv-1')).toBeUndefined();
    store.remember('conv-1', 'acct-b');
    expect(store.get('conv-1')).toBe('acct-b');
  });

  it('sees a binding written by another process, so resumes are not misrouted', () => {
    const file = storePath();
    const reader = createRoutingStore(file);
    expect(reader.get('conv-1')).toBeUndefined();
    // Stand-in for the other worker.
    createRoutingStore(file).remember('conv-1', 'acct-a');
    expect(reader.get('conv-1')).toBe('acct-a');
  });

  it('degrades to no binding on a corrupt or foreign file instead of throwing', () => {
    const file = storePath();
    writeFileSync(file, '{ this is not json');
    expect(createRoutingStore(file).get('conv-1')).toBeUndefined();

    writeFileSync(file, JSON.stringify({ version: 99, routes: { 'conv-1': 'acct-a' } }));
    expect(createRoutingStore(file).get('conv-1')).toBeUndefined();
  });

  it('never throws when the path cannot be created', () => {
    // A regular file standing where a directory is needed: mkdir fails with
    // ENOTDIR. (Deliberately not a path under /proc — recursive mkdirSync hangs
    // there on Linux rather than failing.)
    const blocker = path.join(mkdtempSync(path.join(tmpdir(), 'pool-')), 'blocker');
    writeFileSync(blocker, 'x');
    const store = createRoutingStore(path.join(blocker, 'sub', 'r.json'));
    expect(() => store.remember('conv-1', 'acct-a')).not.toThrow();
    expect(store.get('conv-1')).toBeUndefined();
  });

  it('caps the file so an unbounded conversation history cannot grow it forever', () => {
    const file = storePath();
    const store = createRoutingStore(file, { maxRoutes: 3 });
    for (let i = 0; i < 6; i++) store.remember(`conv-${i}`, 'acct-a');
    const routes = JSON.parse(readFileSync(file, 'utf-8')).routes as Record<string, string>;
    expect(Object.keys(routes)).toEqual(['conv-3', 'conv-4', 'conv-5']);
    // A trimmed binding is a miss, which falls back to hash routing.
    expect(store.get('conv-0')).toBeUndefined();
  });
});

describe('createAvailabilityTracker', () => {
  const limited: AccountState = {
    state: 'rate_limited',
    failure: { kind: 'rate_limit', at: 0, status: 429, message: 'session limit' },
  };

  it('knows nothing before its first refresh, so nothing is sidelined', () => {
    const tracker = createAvailabilityTracker({
      profiles: [A, B],
      readState: async () => limited,
    });
    expect([...tracker.unavailableIds(0)]).toEqual([]);
  });

  it('reports the unavailable accounts after a refresh', async () => {
    const tracker = createAvailabilityTracker({
      profiles: [A, B],
      readState: async (p) => (p.id === 'acct-a' ? limited : { state: 'ok' }),
    });
    await tracker.refresh(0);
    expect([...tracker.unavailableIds(0)]).toEqual(['acct-a']);
  });

  it('treats needs_login and org_blocked as unavailable too — they cannot run either', async () => {
    const tracker = createAvailabilityTracker({
      profiles: [A, B],
      readState: async (p) =>
        p.id === 'acct-a'
          ? { state: 'needs_login', failure: { kind: 'authentication_failed', at: 0, message: '' } }
          : { state: 'org_blocked', failure: { kind: 'org_not_allowed', at: 0, message: '' } },
    });
    await tracker.refresh(0);
    expect([...tracker.unavailableIds(0)].sort()).toEqual(['acct-a', 'acct-b']);
  });

  it('treats an unreadable account as available rather than sidelining it', async () => {
    const tracker = createAvailabilityTracker({
      profiles: [A],
      readState: async () => {
        throw new Error('unreadable');
      },
    });
    await tracker.refresh(0);
    expect([...tracker.unavailableIds(0)]).toEqual([]);
  });

  it('throttles refreshes to the configured interval', async () => {
    const readState = vi.fn(async () => ({ state: 'ok' }) as AccountState);
    const tracker = createAvailabilityTracker({ profiles: [A], readState, refreshMs: 1000 });
    await tracker.refresh(0);
    expect(readState).toHaveBeenCalledTimes(1);

    tracker.unavailableIds(500);
    await Promise.resolve();
    expect(readState).toHaveBeenCalledTimes(1);

    tracker.unavailableIds(1500);
    await vi.waitFor(() => expect(readState).toHaveBeenCalledTimes(2));
  });
});

describe('autoAccountProvider with failover', () => {
  function build(unavailable: string[], routes = new Map<string, string>()) {
    return autoAccountProvider(claude, [A, B], {
      realHomeDir: REAL_HOME,
      unavailableIds: () => new Set(unavailable),
      routing: {
        get: (id) => routes.get(id),
        remember: (id, acct) => void routes.set(id, acct),
      },
      now: () => 0,
    });
  }

  const dirOf = (provider: ReturnType<typeof build>, sessionId: string, isResuming = false) =>
    provider.behavior.prompt!.buildCommand({
      cli: 'claude',
      autoApprove: false,
      model: '',
      sessionId,
      isResuming,
    }).env.CLAUDE_CONFIG_DIR;

  it('a fresh conversation avoids the limited account and the choice is recorded', () => {
    const routes = new Map<string, string>();
    const provider = build(['acct-a'], routes);
    expect(dirOf(provider, 'conv-x')).toBe(B.dir);
    expect(routes.get('conv-x')).toBe('acct-b');
  });

  it('resuming returns to the recorded account even after it becomes limited', () => {
    const routes = new Map<string, string>();
    // Fresh spawn while B is limited: lands on A and binds.
    const first = build(['acct-b'], routes);
    const chosen = dirOf(first, 'conv-y');
    expect(chosen).toBe(A.dir);

    // A is now the limited one. The resume must still go to A: its session is there.
    const later = build(['acct-a'], routes);
    expect(dirOf(later, 'conv-y', true)).toBe(A.dir);
  });

  it('survives a routing store and tracker that throw, since a spawn must not fail', () => {
    const provider = autoAccountProvider(claude, [A, B], {
      realHomeDir: REAL_HOME,
      unavailableIds: () => {
        throw new Error('tracker down');
      },
      routing: {
        get: () => {
          throw new Error('store down');
        },
        remember: () => {
          throw new Error('store down');
        },
      },
    });
    expect([A.dir, B.dir]).toContain(dirOf(provider, 'conv-z'));
  });

  it('routes plain hash when no tracker or store is supplied', () => {
    const bare = autoAccountProvider(claude, [A, B], { realHomeDir: REAL_HOME });
    const first = dirOf(bare, 'conv-w');
    expect(dirOf(bare, 'conv-w')).toBe(first);
    expect([A.dir, B.dir]).toContain(first);
  });
});
