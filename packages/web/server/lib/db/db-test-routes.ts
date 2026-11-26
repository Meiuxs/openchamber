import type { Application, Request, Response } from '../shared/http-contracts.js';
import express from 'express';

import { probeDbhubConnection, type DbProbeFields } from './dbhub-probe.js';
import { removeBindingConfig, writeBindingConfig } from './binding-config.js';

const directoryOf = (req: Request): string => {
  const raw = req.get('x-opencode-directory');
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

/**
 * Database binding routes.
 *
 * POST /api/db/test     — one-shot dbhub probe against the candidate TOML.
 * POST /api/db/binding  — writes the TOML the binding's command will load and
 *                         answers with its absolute path.
 * DELETE /api/db/binding — removes it again (binding deleted or renamed).
 *
 * Nothing here is a general file-write API: the path is fixed to
 * `<project>/.opencode/dbhub/<slug>.toml` and the slug is validated.
 */
export const registerDbTestRoutes = (app: Application): void => {
  app.post('/api/db/test', express.json({ limit: '16kb' }), (req: Request, res: Response) => {
    void (async () => {
      try {
        const body = (req.body ?? {}) as DbProbeFields;
        const result = await probeDbhubConnection(body);
        if (result.ok) {
          res.json({ ok: true, detail: result.detail });
        } else {
          res.status(400).json({ ok: false, error: result.error });
        }
      } catch (error) {
        res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Connection test failed' });
      }
    })();
  });

  app.post('/api/db/binding', express.json({ limit: '16kb' }), (req: Request, res: Response) => {
    void (async () => {
      try {
        const body = (req.body ?? {}) as { alias?: unknown; toml?: unknown };
        const alias = typeof body.alias === 'string' ? body.alias.trim().toLowerCase() : '';
        const toml = typeof body.toml === 'string' ? body.toml : '';
        const result = await writeBindingConfig(directoryOf(req), alias, toml);
        if (!result.ok) {
          res.status(400).json(result);
          return;
        }
        res.json(result);
      } catch (error) {
        res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Could not write the binding config' });
      }
    })();
  });

  app.delete('/api/db/binding', (req: Request, res: Response) => {
    void (async () => {
      try {
        const alias = typeof req.query.alias === 'string' ? req.query.alias.trim().toLowerCase() : '';
        const removed = await removeBindingConfig(directoryOf(req), alias);
        res.json({ ok: true, removed });
      } catch (error) {
        res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Could not remove the binding config' });
      }
    })();
  });
};
