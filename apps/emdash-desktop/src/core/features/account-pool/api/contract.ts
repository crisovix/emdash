import { defineContract, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';

/**
 * Account Pool usage and status, for the settings page.
 *
 * Read-only by design: the pool's account list is source-level configuration
 * (`packages/plugins/src/agents/account-pool/profiles.ts`), so there is nothing
 * here to mutate. This exists so the renderer can see which subscription is
 * being drained without dropping to `pnpm run pool:report`.
 */
export const accountPoolDomain = 'accountPool' as const;

const tokenUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationInputTokens: z.number(),
  cacheReadInputTokens: z.number(),
  thinkingTokens: z.number(),
  messages: z.number(),
});

const accountStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('ok') }),
  z.object({ state: z.literal('rate_limited'), message: z.string() }),
  z.object({ state: z.literal('needs_login'), message: z.string() }),
  z.object({ state: z.literal('org_blocked'), message: z.string() }),
]);

export const accountPoolEntrySchema = z.object({
  accountId: z.string(),
  provider: z.string(),
  scope: z.string(),
  label: z.string(),
  usage: tokenUsageSchema,
  byModel: z.array(tokenUsageSchema.extend({ model: z.string() })),
  status: accountStatusSchema,
  /** Set when the account has no measurable usage, with the reason. */
  notMeasurable: z.string().optional(),
  /** Conversations the auto router has bound to this account. */
  boundConversations: z.number(),
});

export const accountPoolReportSchema = z.object({
  generatedAt: z.number(),
  /** Window in days, or null for all recorded history. */
  windowDays: z.number().nullable(),
  accounts: z.array(accountPoolEntrySchema),
});

export type AccountPoolEntry = z.infer<typeof accountPoolEntrySchema>;
export type AccountPoolReport = z.infer<typeof accountPoolReportSchema>;

export const accountPoolContract = defineContract({
  report: procedure({
    input: z.object({ days: z.number().int().positive().optional() }),
    output: accountPoolReportSchema,
  }),
});

export type AccountPoolContract = typeof accountPoolContract;
