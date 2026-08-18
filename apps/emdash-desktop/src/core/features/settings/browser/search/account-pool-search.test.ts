import { describe, expect, it } from 'vitest';
import { accountPoolSettingsPage } from '@core/features/account-pool/contributions/settings-page';
import { searchSettings } from './settings-search';

describe('account pool settings page', () => {
  it('is reachable by the terms someone would actually search for', () => {
    // settings-search.test.ts already asserts every page has an entry; that
    // cannot see whether the keywords match what a person would type.
    for (const query of ['account pool', 'quota', 'rate limit', 'subscriptions', 'usage']) {
      const tabs = searchSettings(query).map((hit) => hit.tab);
      expect(tabs, `searching "${query}"`).toContain(accountPoolSettingsPage.id);
    }
  });
});
