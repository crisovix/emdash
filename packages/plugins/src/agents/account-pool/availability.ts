import type { AccountState, PoolAccountProfile } from '@emdash/core/primitives/account-pool/api';

/**
 * What the pool currently believes about each account's usability.
 *
 * Availability has to be readable synchronously, because the only place that
 * needs it — a plugin's `buildCommand` — is synchronous and cannot await a
 * filesystem walk. So this keeps a snapshot and refreshes it in the background:
 * a spawn reads what is known now and triggers the refresh that will inform the
 * next one.
 *
 * That makes the snapshot bounded-stale by design. The consequence is mild and
 * self-correcting: the task that first hits a spent subscription still fails,
 * and once that failure lands in the transcript every later task routes away for
 * the rest of the window. A rate limit lasts hours, so being seconds late to
 * notice costs at most a couple of spawns.
 *
 * Never throws. An unreadable account is treated as available, which is the
 * pre-failover behavior rather than an outage.
 */
export type AvailabilityTracker = {
  /**
   * Ids that should not receive new work, from the latest snapshot. Also
   * schedules a refresh when the snapshot has gone stale.
   */
  unavailableIds(now: number): ReadonlySet<string>;
  /** Await the in-flight or a fresh refresh. For tests and for a warm start. */
  refresh(now: number): Promise<void>;
  /** The last known state per account id, for reporting. */
  snapshot(): ReadonlyMap<string, AccountState>;
};

export type CreateAvailabilityTrackerOptions = {
  profiles: readonly PoolAccountProfile[];
  /** Reads one account's state. Injected so this stays testable and fs-free. */
  readState: (profile: PoolAccountProfile, now: number) => Promise<AccountState>;
  /** Minimum gap between refreshes. */
  refreshMs?: number;
};

/** States that mean "do not send new work here". */
function isUnavailable(state: AccountState): boolean {
  // needs_login and org_blocked are not quota problems, but an account in either
  // state cannot run anything, so new work should still go elsewhere.
  return state.state !== 'ok';
}

export function createAvailabilityTracker(
  options: CreateAvailabilityTrackerOptions
): AvailabilityTracker {
  const refreshMs = options.refreshMs ?? 60_000;
  const states = new Map<string, AccountState>();
  let lastRefreshAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | null = null;

  function startRefresh(now: number): Promise<void> {
    if (inFlight) return inFlight;
    lastRefreshAt = now;
    inFlight = (async () => {
      const results = await Promise.all(
        options.profiles.map(async (profile) => {
          try {
            return [profile.id, await options.readState(profile, now)] as const;
          } catch {
            // Unreadable means unknown, and unknown must not sideline an account.
            return [profile.id, { state: 'ok' } as AccountState] as const;
          }
        })
      );
      for (const [id, state] of results) states.set(id, state);
    })()
      .catch(() => {})
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return {
    unavailableIds(now) {
      if (now - lastRefreshAt >= refreshMs) void startRefresh(now);
      const unavailable = new Set<string>();
      for (const [id, state] of states) {
        if (isUnavailable(state)) unavailable.add(id);
      }
      return unavailable;
    },

    refresh(now) {
      lastRefreshAt = Number.NEGATIVE_INFINITY;
      return startRefresh(now);
    },

    snapshot() {
      return new Map(states);
    },
  };
}
