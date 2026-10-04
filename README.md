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
{ "seats": ["A12"] }
```
Multi-seat requests are all-or-nothing.

| Status | Meaning |
|---|---|
| `201` | Reserved. Body: `reservation_id, show_id, user_id, seats, amount_paise, status` |
| `409 seat_unavailable` | A requested seat is already taken |
| `409 per_user_limit_exceeded` | Would take the user over the show's limit |
| `422 unknown_seat` | A requested seat label doesn't exist in this show |
| `400` | Invalid body (empty or duplicate seats, malformed JSON) |
| `401` | Missing bearer token |
| `404` | Unknown show |

### `GET /health`
Liveness only: `200` while the process is running.

### `GET /ready`
Readiness: `503` until migrations are applied and whenever Postgres is not
reachable within 2s.

Every response carries an `x-request-id` header. Send your own
`X-Request-Id` to have it echoed back and used in the logs.

## Notes on scope
- **Identity**: simplified to "the bearer token IS the user id" rather than a
  real JWT/session layer. The part that matters is that `user_id` never comes
  from the request body.
- **Holds**: reservations confirm immediately rather than using a separate
  hold-then-confirm step. `held` exists in the schema and the counts so the
  invariant covers it, but nothing sets it.
