import { z } from 'zod';

import { parseMetadata } from '@/lib/metadataParse';
import type { Metadata } from '@/lib/opencode/model';

const ephemeralGenerationSchema = z.object({
  openchamber: z.object({ kind: z.literal('ephemeral-generation') }),
});

export const isEphemeralGenerationMetadata = (metadata: Metadata | null | undefined): boolean => (
  parseMetadata(ephemeralGenerationSchema, metadata ?? undefined).success
);

export const isEphemeralGenerationSession = (session: { metadata?: Metadata } | null | undefined): boolean => (
  isEphemeralGenerationMetadata(session?.metadata)
);
