import { z } from 'zod';

const waitingSchema = z.object({
  sessionId: z.string().min(1),
  until: z.number(),
});

const accountSchema = z.object({
  key: z.string().min(1),
  label: z.string().nullable(),
  providerIds: z.array(z.string()),
  used: z.number(),
  limit: z.number(),
  remaining: z.number(),
  resetAt: z.number(),
  limitedUntil: z.number().nullable(),
  authoritative: z.boolean(),
  waiting: z.array(waitingSchema),
});

export const rateGateStatusSchema = z.object({
  enabled: z.boolean(),
  requests: z.number(),
  windowMinutes: z.number(),
  caps: z.object({
    requests: z.number().nullable(),
    windowMinutes: z.number().nullable(),
  }),
  accounts: z.array(accountSchema),
});

export type RateGateAccount = z.infer<typeof accountSchema>;
export type RateGateStatus = z.infer<typeof rateGateStatusSchema>;
