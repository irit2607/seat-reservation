import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import { requestIdMiddleware, logger } from './logger';

const app = express();
// Request id first, so requests rejected by the JSON parser are still logged.
app.use(requestIdMiddleware);
app.use(express.json({ limit: '1mb' }));

// Liveness: is the process up at all? No dependency checks.
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.use((_req, res) => {
  res.status(404).json({ error: 'not_found' });
});

// Body-parser errors carry their own 4xx status (malformed JSON, oversized body).
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: err.type ?? 'bad_request' });
  }
  logger.error({ err, requestId: (req as any).requestId }, 'unhandled error');
  res.status(500).json({ error: 'internal_error' });
});

const port = process.env.PORT || 3000;
const server = app.listen(port, () => {
  logger.info({ port }, 'seat-reservation service listening');
});

// Render sends SIGTERM on every redeploy: stop accepting, let in-flight requests finish.
function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  setTimeout(() => process.exit(1), 10_000).unref();
  server.close(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
