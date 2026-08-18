import type { ContractClient } from '@emdash/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { accountPoolContract, accountPoolDomain } from './contract';

export type AccountPoolClient = ContractClient<typeof accountPoolContract>;

export function getAccountPoolClient(): Promise<AccountPoolClient> {
  return domainClient<AccountPoolClient>(accountPoolDomain, accountPoolContract);
}
