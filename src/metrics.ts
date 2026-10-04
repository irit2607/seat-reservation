import client from 'prom-client';
import { pool } from './db';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const reservationsConfirmed = new client.Counter({
  name: 'reservations_confirmed_total',
  help: 'Total number of confirmed reservations',
  labelNames: ['show_id'] as const,
  registers: [registry],
});

export const reservationsDeclined = new client.Counter({
  name: 'reservations_declined_total',
  help: 'Total number of declined reservation attempts',
  // seat_taken | unknown_seat | per_user_limit | idempotent_replay | idempotency_key_reused
  labelNames: ['show_id', 'reason'] as const,
  registers: [registry],
});

export const reservationsCancelled = new client.Counter({
  name: 'reservations_cancelled_total',
  help: 'Total number of cancelled reservations',
  labelNames: ['show_id'] as const,
  registers: [registry],
});

export const httpRequests = new client.Counter({
  name: 'http_requests_total',
  help: 'HTTP requests by route and status code',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency by route',
  labelNames: ['method', 'route'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

type SeatField = 'available' | 'held' | 'confirmed' | 'total';
type SeatCounts = { ok: boolean; byShow: Map<string, Record<SeatField, number>> };

// Seat gauges are read from the database at scrape time rather than tracked in
// memory, so they always match GET /shows/:id and survive restarts. The short
// cache lets all seat gauges share one query per scrape.
let seatCountsCache: { at: number; counts: Promise<SeatCounts> } | undefined;

function seatCounts(): Promise<SeatCounts> {
  if (!seatCountsCache || Date.now() - seatCountsCache.at > 1000) {
    const counts = pool
      .query(
        `SELECT sh.id AS show_id, sh.total_seats AS total,
                count(se.*) FILTER (WHERE se.status = 'available')::int AS available,
                count(se.*) FILTER (WHERE se.status = 'held')::int AS held,
                count(se.*) FILTER (WHERE se.status = 'confirmed')::int AS confirmed
         FROM shows sh LEFT JOIN seats se ON se.show_id = sh.id
         GROUP BY sh.id`
      )
      .then(({ rows }): SeatCounts => ({
        ok: true,
        byShow: new Map(rows.map(({ show_id, ...counts }) => [show_id, counts])),
      }))
      .catch((): SeatCounts => ({ ok: false, byShow: new Map() }));
    seatCountsCache = { at: Date.now(), counts };
  }
  return seatCountsCache.counts;
}

function seatGauge(field: SeatField, help: string) {
  return new client.Gauge({
    name: `seats_${field}`,
    help,
    labelNames: ['show_id'] as const,
    registers: [registry],
    async collect() {
      this.reset();
      for (const [showId, counts] of (await seatCounts()).byShow) {
        this.set({ show_id: showId }, counts[field]);
      }
    },
  });
}

seatGauge('available', 'Current number of available seats, per show (read from the database)');
seatGauge('held', 'Current number of held seats, per show (read from the database)');
seatGauge('confirmed', 'Current number of confirmed seats, per show (read from the database)');
seatGauge('total', 'Seats the show was created with; available + held + confirmed must equal this');

// Without this, a failed DB read would just make the seat series disappear.
new client.Gauge({
  name: 'seat_metrics_up',
  help: '1 if the last database read for seat gauges succeeded, 0 if it failed',
  registers: [registry],
  async collect() {
    this.set((await seatCounts()).ok ? 1 : 0);
  },
});

new client.Gauge({
  name: 'db_pool_clients',
  help: 'Postgres pool clients by state',
  labelNames: ['state'] as const,
  registers: [registry],
  collect() {
    this.set({ state: 'total' }, pool.totalCount);
    this.set({ state: 'idle' }, pool.idleCount);
    this.set({ state: 'waiting' }, pool.waitingCount);
  },
});
