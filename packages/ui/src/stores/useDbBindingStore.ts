import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { bindingNameOf, bindingSlugOf } from '@/lib/db-bindings/dsn';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { createDeferredSafeJSONStorage } from '@/stores/utils/safeStorage';

/**
 * Which database binding a project prefers (shared through the project's
 * `.opencode/dbhub/primary.json`) and which one a session is pinned to. Values
 * are MCP entry names (`dbhub-orders`); the primary file stores the short alias.
 */
interface DbBindingState {
  primaryByDirectory: Record<string, string | null>;
  selectionBySession: Record<string, string | null>;
  announcedBySession: Record<string, string | null>;
  loadPrimary: (directory: string | null) => Promise<void>;
  setPrimary: (directory: string | null, entryName: string | null) => Promise<{ ok: boolean }>;
  setSelection: (sessionId: string, entryName: string | null) => void;
  markAnnounced: (sessionId: string, entryName: string | null) => void;
  forgetSession: (sessionId: string) => void;
}

const headersFor = (directory: string | null): Record<string, string> =>
  directory ? { 'x-opencode-directory': directory } : {};

export const useDbBindingStore = create<DbBindingState>()(
  persist(
    (set) => ({
      primaryByDirectory: {},
      selectionBySession: {},
      announcedBySession: {},

      loadPrimary: async (directory) => {
        if (!directory) return;
        try {
          const response = await runtimeFetch('/api/db/primary', { headers: headersFor(directory) });
          const payload = (await response.json().catch(() => null)) as { ok?: boolean; alias?: string | null } | null;
          const alias = response.ok && payload?.alias ? payload.alias : null;
          set((state) => ({
            primaryByDirectory: { ...state.primaryByDirectory, [directory]: alias ? bindingNameOf(alias) : null },
          }));
        } catch {
          set((state) => ({
            primaryByDirectory: { ...state.primaryByDirectory, [directory]: null },
          }));
        }
      },

      setPrimary: async (directory, entryName) => {
        if (!directory) return { ok: false };
        try {
          const response = await runtimeFetch('/api/db/primary', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', ...headersFor(directory) },
            body: JSON.stringify({ alias: entryName ? bindingSlugOf(entryName) : null }),
          });
          if (!response.ok) return { ok: false };
          set((state) => ({
            primaryByDirectory: { ...state.primaryByDirectory, [directory]: entryName },
          }));
          return { ok: true };
        } catch {
          return { ok: false };
        }
      },

      setSelection: (sessionId, entryName) => {
        set((state) => {
          const selectionBySession = { ...state.selectionBySession, [sessionId]: entryName };
          const announcedBySession = { ...state.announcedBySession };
          // A different pick has to be announced again.
          delete announcedBySession[sessionId];
          return { selectionBySession, announcedBySession };
        });
      },

      markAnnounced: (sessionId, entryName) => {
        set((state) => ({
          announcedBySession: { ...state.announcedBySession, [sessionId]: entryName },
        }));
      },

      forgetSession: (sessionId) => {
        set((state) => {
          const selectionBySession = { ...state.selectionBySession };
          const announcedBySession = { ...state.announcedBySession };
          delete selectionBySession[sessionId];
          delete announcedBySession[sessionId];
          return { selectionBySession, announcedBySession };
        });
      },
    }),
    {
      name: 'openchamber-db-bindings',
      storage: createDeferredSafeJSONStorage(),
      version: 1,
      partialize: (state) => ({
        primaryByDirectory: state.primaryByDirectory,
        selectionBySession: state.selectionBySession,
        announcedBySession: state.announcedBySession,
      }),
    },
  ),
);
