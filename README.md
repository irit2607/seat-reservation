# Seat Reservation Service

A JSON HTTP API for selling assigned seats that stays correct under heavy
concurrent load: no seat is ever double-sold, per-user limits hold, and retried
requests never book twice.

Node.js + TypeScript + Express + PostgreSQL, deployed on Render. No ORM: plain
`pg` queries, so the SQL that does the concurrency-safety work is visible.

## Running locally with Docker (easiest)
```bash
docker compose up --build
```
Starts Postgres and the app together. The app creates its tables on startup.

## Running locally without Docker
Requires Node.js 22+ and a running Postgres.
```bash
npm install
cp .env.example .env   # point DATABASE_URL at your Postgres
npm run dev            # restarts on every file save
```

Migrations in `migrations/` are applied automatically on startup (tracked in a
`schema_migrations` table). `/ready` returns `503` until they have been applied.

## Running the burst test
One command, against a local or deployed instance:
```bash
npm run burst -- http://localhost:3000
npm run burst -- https://your-app.onrender.com --requests 5000 --concurrency 200
```
Options: `--requests` (default `20000`), `--concurrency` in-flight requests
(default `500`), `--hot-seats` (default `5`), `--contenders` per hot seat
(default `500`).

Against a fresh show, it runs:
1. A hot-seat storm, with every contender for every hot seat firing at once.
2. A general stampede skewed to "good" seats. Every 10th request is fired
   together with a retry that uses the same key.
3. Idempotency checks: simultaneous identical requests, the same key with
   different seats, and reuse of a declined key.
4. A per-user limit check under parallel requests.
5. Identity checks: a spoofed body `user_id`, and one user cancelling another
   user's reservation.
6. Cancel, then rebook the released seat.

A sampler checks `available + held + confirmed == total_seats` throughout the
run. At the end, the final state is reconciled against every `201` the script
saw (no seat in two `201`s, no user over the limit) and `/metrics` is reconciled
against the API. It prints outcomes by status and by decline reason, plus
p50/p95/p99 latency, and **exits `1` if any check fails**.

Run it against a single instance that is already awake: the counter
reconciliation assumes one process that didn't restart mid-run.

## Deploying (Render)
`render.yaml` is a Render Blueprint for a free Docker web service plus a free
Postgres 16 database, with `DATABASE_URL` wired in automatically. In the Render
dashboard choose **New → Blueprint**, select this repo, and **Apply**. Every push
to `main` redeploys automatically.

Optional environment variables: `DB_POOL_MAX` (default `20`),
`DB_ACQUIRE_TIMEOUT_MS` (default `15000`), `LOG_LEVEL` (default `info`).

## API
Errors are always JSON: `{ "error": "<code or message>" }`. Domain declines are
`4xx`; `5xx` is reserved for genuine faults (`503` when the database is down).

### `POST /shows` (admin, no auth in this implementation)
```json
{ "name": "friday-night", "seats": ["A1","A2","A12"], "price_paise": 25000, "per_user_limit": 4 }
```
`per_user_limit` is optional (default `4`). Returns `201` with the show and every
seat `available`. `400` if `price_paise` is not a non-negative integer, seat
labels are blank or duplicated, or the body is malformed.

### `GET /shows/:id`
Returns `per_user_limit`, every seat's status, `counts: { available, held, confirmed }`,
`total_seats` (stored at creation) and `invariant_holds`
(`available + held + confirmed == total_seats`). `404` for an unknown show.

### `POST /shows/:id/reserve` (requires `Authorization: Bearer <user_id>`)
```json
{ "seats": ["A12"], "idempotency_key": "..." }
```
The key can also be sent as an `Idempotency-Key` header (if both are sent they
must match). Keys are scoped per user. Multi-seat requests are all-or-nothing.

Every outcome is stored against the key, declines included. A retry with the
same key and body gets the original outcome back, with an
`Idempotent-Replayed: true` header: a success replays as `200` (not `201`, so a
retry never looks like a second booking), a decline replays as the same
`409`/`422`. Clients that want to try again after a decline use a new key.

| Status | Meaning |
|---|---|
| `201` | Reserved. Body: `reservation_id, show_id, user_id, seats, amount_paise, status` |
| `200` | Replay of an earlier success with the same key |
| `409 seat_unavailable` | A requested seat is already taken |
| `409 per_user_limit_exceeded` | Would take the user over the show's limit |
| `409 idempotency_key_reused_with_different_body` | Same key, different show or seats (whether the first attempt succeeded or was declined) |
| `422 unknown_seat` | A requested seat label doesn't exist in this show |
| `400` | Invalid body (missing key, empty or duplicate seats, malformed JSON) |
| `401` | Missing bearer token |
| `404` | Unknown show |

### `POST /reservations/:id/cancel` (requires `Authorization: Bearer <user_id>`)
Only the reservation's owner can cancel it. Releases the seat(s) back to
`available` and frees the user's per-show allowance, so they can book again.
Returns `200 {"reservation_id": "...", "status": "cancelled"}`. `404` if the
reservation doesn't exist, isn't yours, or is already cancelled (one answer for
all three, so callers can't probe other users' reservation ids). Replaying the
original reserve request's idempotency key afterwards returns the reservation
with `status: "cancelled"`; it does not book again.

### `GET /health`
Liveness only: `200` while the process is running.

### `GET /ready`
Readiness: `503` until migrations are applied and whenever Postgres is not
reachable within 2s.

### `GET /metrics`
Prometheus format:
- `reservations_confirmed_total{show_id}`, `reservations_cancelled_total{show_id}`
- `reservations_declined_total{show_id,reason}` — `seat_taken`, `unknown_seat`,
  `per_user_limit`, `idempotent_replay`, `idempotency_key_reused`
- `seats_available`, `seats_held`, `seats_confirmed`, `seats_total` `{show_id}`.
  These are read from the database at scrape time (cached for 1s), so they
  match `GET /shows/:id` and survive restarts.
- `seat_metrics_up` — `0` when the database read behind the seat gauges fails.
  The rest of `/metrics` keeps serving, and the seat series are absent rather
  than stale.
- `http_requests_total{method,route,status}`, `http_request_duration_seconds`
- `db_pool_clients{state}` — `total`, `idle`, `waiting`
- Node.js process metrics (CPU, memory, event loop lag, GC)

Counters are per process and reset on restart, as Prometheus counters do.

Every response carries an `x-request-id` header. Send your own
`X-Request-Id` to have it echoed back and used in the logs.

## Notes on scope
- **Identity**: simplified to "the bearer token IS the user id" rather than a
  real JWT/session layer. The part that matters is that `user_id` never comes
  from the request body.
- **Holds**: reservations confirm immediately rather than using a separate
  hold-then-confirm step with expiry; seats are released by an explicit cancel.
  `held` exists in the schema and the counts so the invariant covers it, but
  nothing sets it.
