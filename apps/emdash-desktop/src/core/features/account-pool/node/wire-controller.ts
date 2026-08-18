import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { readPoolReport, type AccountReport } from '@emdash/core/primitives/account-pool/node';
import { defaultRoutingStorePath, poolAccountProfiles } from '@emdash/plugins/agents/account-pool';
import { createController, type Controller } from '@emdash/wire/rpc';
import { accountPoolContract, type AccountPoolEntry } from '../api/contract';

/**
 * Serves the pool's usage and status to the settings page.
 *
 * Reads the accounts' own transcripts rather than any API, because a Claude
 * subscription reports its spend nowhere else. That read walks every transcript,
 * so this is a request/response procedure the page fetches on demand, not a live
 * model that would re-walk on every change.
 */
export function createAccountPoolWireController(
  options: { homeDir?: string; now?: () => number } = {}
): Controller {
  const homeDir = options.homeDir ?? os.homedir();
  const now = options.now ?? (() => Date.now());

  return createController(accountPoolContract, {
    report: async (input) => {
      const at = now();
      const since = input.days === undefined ? undefined : at - input.days * 86_400_000;
      const [reports, bindings] = await Promise.all([
        readPoolReport(poolAccountProfiles(homeDir), {
          now: at,
          ...(since !== undefined ? { since } : {}),
        }),
        readBindingCounts(homeDir),
      ]);

      return {
        generatedAt: at,
        windowDays: input.days ?? null,
        accounts: reports.map((report) => toEntry(report, bindings)),
      };
    },
  });
}

function toEntry(report: AccountReport, bindings: Map<string, number>): AccountPoolEntry {
  const { profile, usage, status } = report;
  return {
    accountId: profile.id,
    provider: profile.provider,
    scope: profile.scope,
    label: profile.label,
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      thinkingTokens: usage.thinkingTokens,
      messages: usage.messages,
    },
    byModel: Object.entries(usage.byModel).map(([model, perModel]) => ({ model, ...perModel })),
    status:
      status.state === 'ok'
        ? { state: 'ok' }
        : { state: status.state, message: status.failure.message },
    ...(report.unreadable !== undefined ? { notMeasurable: report.unreadable } : {}),
    boundConversations: bindings.get(profile.id) ?? 0,
  };
}

/** How many conversations the auto router has bound to each account. */
async function readBindingCounts(homeDir: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  try {
    const raw = await readFile(defaultRoutingStorePath(homeDir), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    const routes = (parsed as { routes?: Record<string, unknown> }).routes ?? {};
    for (const accountId of Object.values(routes)) {
      if (typeof accountId !== 'string') continue;
      counts.set(accountId, (counts.get(accountId) ?? 0) + 1);
    }
  } catch {
    // No routing file means the auto router has not run yet, not an error.
  }
  return counts;
}
