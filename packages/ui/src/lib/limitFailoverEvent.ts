import { z } from 'zod';

export const limitFailoverSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('account'),
    sessionId: z.string().min(1),
    providerId: z.string().min(1),
    fromAccount: z.string().nullable(),
    toAccount: z.string().min(1),
  }),
  z.object({
    kind: z.literal('model'),
    sessionId: z.string().min(1),
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    toProviderId: z.string().min(1),
    toModelId: z.string().min(1),
  }),
]);

export type LimitFailoverEvent = { type: 'limit-failover'; failover: z.infer<typeof limitFailoverSchema> };
