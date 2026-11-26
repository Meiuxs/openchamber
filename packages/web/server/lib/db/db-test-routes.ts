import type { Application, Request, Response } from '../shared/http-contracts.js';
import express from 'express';

import { probeDbhubConnection, type DbProbeFields } from './dbhub-probe.js';

/**
 * POST /api/db/test — one-shot dbhub connection probe. The candidate fields
 * are read from the request body; nothing is persisted and no project
 * config is touched. The `x-opencode-directory` header convention is
 * accepted for future per-directory policy but the DSN is self-contained.
 */
export const registerDbTestRoutes = (app: Application): void => {
  app.post('/api/db/test', express.json({ limit: '8kb' }), (req: Request, res: Response) => {
    void (async () => {
      const body = (req.body ?? {}) as DbProbeFields;
      const result = await probeDbhubConnection(body);
      if (result.ok) {
        res.json({ ok: true, detail: result.detail });
      } else {
        res.status(400).json({ ok: false, error: result.error });
      }
    })();
  });
};
