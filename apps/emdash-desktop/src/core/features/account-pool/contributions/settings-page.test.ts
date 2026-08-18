import { describe, expect, it } from 'vitest';
import { searchSettings } from '@core/features/settings/browser/search/settings-search';
import { accountPoolSettingsPage } from './settings-page';

describe('account pool settings page', () => {
  it('is reachable by the terms someone would actually search for', () => {
    // The repo already tests that every page has at least one search entry; this
    // covers the keywords, which that test cannot see.
    for (const query of ['account pool', 'quota', 'rate limit', 'subscriptions', 'usage']) {
      const tabs = searchSettings(query).map((hit) => hit.tab);
      expect(tabs, `searching "${query}"`).toContain(accountPoolSettingsPage.id);
    }
  });
});
