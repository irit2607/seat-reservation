import { Pool, types } from 'pg';
import { logger } from './logger';

// pg returns BIGINT as a string by default; paise amounts stay far below 2^53.
types.setTypeParser(types.builtins.INT8, (value) => Number(value));

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX) || 20,
  // Bounds both opening a connection and waiting for a free one. Under a burst,
  // requests queue for a client, so this must be well above a typical wait.
  connectionTimeoutMillis: Number(process.env.DB_ACQUIRE_TIMEOUT_MS) || 15_000,
});

// pg emits 'error' when a client loses its connection; an 'error' event with no
// listener crashes the process. The pool only listens on idle clients, so a DB
// restart while requests hold checked-out clients would kill the server. The
// in-flight query still rejects, and the request is answered with a 503.
pool.on('error', (err) => {
  logger.error({ err }, 'idle postgres client error');
});
pool.on('connect', (client) => {
  client.on('error', (err) => {
    logger.warn({ err }, 'postgres client error');
  });
});

const READY_TIMEOUT_MS = 2000;

// Readiness has its own short deadline so an unreachable DB fails closed fast,
// independent of the longer pool acquire timeout.
export async function checkDbReachable(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), READY_TIMEOUT_MS);
  });
  const probe = pool.query('SELECT 1').then(() => true, () => false);
  try {
    return await Promise.race([probe, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

const DB_UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET',
  '08001', '08006', '57P01', '57P03',
]);

export function isDbUnavailable(err: unknown): boolean {
  const { code, message } = (err ?? {}) as { code?: string; message?: string };
  return (
    (code !== undefined && DB_UNAVAILABLE_CODES.has(code)) ||
    /timeout exceeded when trying to connect|Connection terminated|not queryable/i.test(message ?? '')
  );
}
