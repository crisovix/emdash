import { AccountPoolView } from '@core/features/account-pool/browser/components/AccountPoolView';
import type { SettingsPageTab } from '@core/features/settings/contributions/views';
import {
  defineSettingsPageContribution,
  type SettingsPageContribution,
} from '@core/primitives/settings/api/page-contribution';

export const accountPoolSettingsPage = defineSettingsPageContribution({
  id: 'account-pool',
  label: 'Account Pool',
  icon: 'gauge',
  component: AccountPoolView,
} satisfies SettingsPageContribution<SettingsPageTab>);
