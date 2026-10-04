import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import { requestIdMiddleware, logger } from './logger';
import { checkDbReachable, isDbUnavailable, pool } from './db';
import { runMigrations } from './migrate';
import { showsRouter } from './routes/shows';

let schemaReady = false;

const app = express();
// Request id first, so requests rejected by the JSON parser are still logged.
app.use(requestIdMiddleware);
app.use(express.json({ limit: '1mb' }));

// Liveness: is the process up at all? No dependency checks.
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Readiness: can this instance actually serve traffic?
// Fails closed (503) if the DB is unreachable — do not claim ready if we can't talk to Postgres.
app.get('/ready', async (_req, res) => {
  if (!schemaReady) {
    return res.status(503).json({ status: 'not_ready', schema: 'pending' });
  }
  const dbOk = await checkDbReachable();
  if (!dbOk) {
    return res.status(503).json({ status: 'not_ready', db: 'unreachable' });
  }
  res.status(200).json({ status: 'ready', db: 'ok' });
});

app.use(showsRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'not_found' });
});

// Body-parser errors carry their own 4xx status (malformed JSON, oversized body).
// A DB outage is reported as 503 rather than a generic 500.
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: err.type ?? 'bad_request' });
  }
  const requestId = (req as any).requestId;
  if (isDbUnavailable(err)) {
    logger.warn({ err, requestId }, 'database unavailable');
    return res.status(503).json({ error: 'database_unavailable' });
  }
  logger.error({ err, requestId }, 'unhandled error');
  res.status(500).json({ error: 'internal_error' });
});

const port = process.env.PORT || 3000;
const server = app.listen(port, () => {
  logger.info({ port }, 'seat-reservation service listening');
});

// Listen first so /health answers during a cold start, then keep retrying
// migrations until the DB is reachable; /ready stays 503 until they succeed.
async function migrateWithRetry() {
  for (let attempt = 1; ; attempt++) {
    try {
      await runMigrations();
      schemaReady = true;
      logger.info('schema ready');
      return;
    } catch (err) {
      const delayMs = Math.min(30_000, 1000 * 2 ** attempt);
      logger.error({ err, attempt, delayMs }, 'migrations failed, retrying');
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
migrateWithRetry();

// Render sends SIGTERM on every redeploy: stop accepting, drain in-flight, close the pool.
function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  setTimeout(() => process.exit(1), 10_000).unref();
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
