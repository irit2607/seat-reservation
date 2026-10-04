# Design Write-up

## The atomic decision
Every correctness guarantee comes from one rule, applied three times: **never
read state and then decide. A single statement's `WHERE` clause is both the
check and the act.**

Claiming a seat (`src/routes/shows.ts`):
```sql
UPDATE seats SET status = 'confirmed', reservation_id = $1
WHERE show_id = $2 AND seat_number = $3 AND status = 'available'
RETURNING seat_number;
```
Postgres takes a row lock for an `UPDATE`, so concurrent updates of the same seat
run one at a time. When 500 requests hit A12 together, the first to lock the row
flips it to `confirmed`. Every other request waits for that transaction to
finish, re-checks `status = 'available'` against the committed row, matches
nothing and gets zero rows back, which becomes a `409 seat_unavailable`. There is
no window between "is it free?" and "take it" because they are the same statement.

The per-user limit uses the same idea as a guarded upsert:
```sql
INSERT INTO user_show_counts (user_id, show_id, held_count) VALUES ($1, $2, $3)
ON CONFLICT (user_id, show_id) DO UPDATE
  SET held_count = user_show_counts.held_count + EXCLUDED.held_count
  WHERE user_show_counts.held_count + EXCLUDED.held_count <= $4
RETURNING held_count;
```
A `SELECT COUNT(*)` then `INSERT` would let ten parallel requests from one user
all read "3, under the limit". Here they serialize on the user's counter row, and
the one that would exceed the limit gets zero rows back, which becomes
`409 per_user_limit_exceeded`.

**Partial requests are all-or-nothing.** If any seat in `["A12","A13"]` is
taken, the whole attempt rolls back, including seats already claimed earlier in
the same attempt. It holds under concurrency because it is one transaction:
nobody else can see a half-claimed request.

**Deadlock avoidance for multi-seat requests.** Seats are sorted before they are
claimed, so two overlapping requests (`[A1,A2]` and `[A2,A1]`) always lock `A1`
before `A2` and can't each hold one seat while waiting for the other. More
generally, every transaction takes locks in one global order:
- reserve: idempotency key → seats (sorted) → the user's counter row
- cancel: reservation row → its seats (stored sorted) → the user's counter row

Tested locally with 200 concurrent two-seat requests in opposite orders (one
`201`, no `5xx`), and with a cancel racing 100 opposite-order reserves of the
same two seats (no `5xx`).

## Idempotency
Keys live in the `idempotency_keys` table with primary key
`(user_id, idempotency_key)`, so keys are scoped per user and one user's key can
never return another user's reservation. The key is claimed as the **first
statement inside the reservation transaction**:
```sql
INSERT INTO idempotency_keys (user_id, idempotency_key, request_hash, reservation_id)
VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, idempotency_key) DO NOTHING
RETURNING reservation_id;
```
- **Exactly once:** the key row and the booking commit in the same transaction,
  so there is no state where one exists without the other. The `reservation_id`
  foreign key is `DEFERRABLE INITIALLY DEFERRED`, so the key can be inserted
  before the reservation row it points to.
- **Declines are recorded too.** The booking attempt runs behind
  `SAVEPOINT attempt`. A decline (seat taken, unknown seat, over the limit) rolls
  back to the savepoint, which undoes any seats claimed so far but keeps the key
  row, and then stores the decline's status and body on the key. A `CHECK`
  constraint makes every key hold exactly one outcome: a reservation or a stored
  decline.
- **Concurrent retries wait instead of failing.** A second request with the same
  key blocks on the primary-key entry until the first transaction commits, then
  reads and replays its outcome.
- **No stuck keys.** A crash, `404`, `503` or validation error before commit rolls
  everything back, so the key is free to be retried.

**Same key, different body.** The key stores a SHA-256 of the show id plus the
sorted seat list. On a conflict:
- Same hash: replay the original outcome with `Idempotent-Replayed: true`. A
  success replays as `200` with the reservation's current state; a decline
  replays as the same `409`/`422` body.
- Different hash: `409 idempotency_key_reused_with_different_body`, whether the
  original succeeded or was declined, so a declined key can't be reused for a
  different booking.

A success replays as `200`, not `201`, so when a hot seat's winner retries, the
seat never shows two "successful bookings". A client that wants to try again
after a decline uses a new key.

## Holds & expiry
Reservations **confirm immediately**. There is no separate hold step with an
expiry timer, and release is an explicit `POST /reservations/{id}/cancel`.

The brief allows either model. Immediate confirmation removes a whole class of
bugs: expiry sweeps racing new bookings, and an expiry resurrecting a seat that
has since been sold to someone else. The cost is that there is no "add to cart,
decide later" window. `held` exists in the schema and in every count, so the
invariant already covers it if a hold step is added later.

Cancel uses the same guarded-`WHERE` style:
- `UPDATE reservations ... WHERE id = $1 AND user_id = $2 AND status = 'confirmed'`
  means only the owner can cancel, and two concurrent cancels can't both succeed.
  Not found, not yours and already cancelled all return the same `404`, so callers
  can't probe other users' reservation ids.
- Each seat is released with `... WHERE reservation_id = <this reservation>`, so a
  cancel can only free seats that still belong to this reservation and can never
  release a seat that has since been confirmed to someone else.
- The user's counter is decremented in the same transaction, so their allowance
  comes back, and the released seat can be booked again straight away.

## Consistency vs. availability under a partition
There is a single Postgres instance and every decision is made inside it, so the
service chooses **consistency**. If the app can't reach the database, it refuses
rather than guessing:
- Requests that need the database get `503 database_unavailable`, never a
  booking that might be wrong.
- `/ready` returns `503` (its database check has a 2s deadline), so a load
  balancer stops routing traffic. `/health` stays `200` because the process is
  fine and restarting it wouldn't help.
- The seat gauges in `/metrics` disappear and `seat_metrics_up` drops to `0`,
  rather than serving stale numbers.

Tested locally by killing Postgres in the middle of a 20k burst. The process
stayed up, failed requests were all `503` (zero `500`), `/ready` recovered once the
database was back, nothing was double-sold, and the invariant held. Every pool
client has an `error` listener, because without one a server-side disconnect
crashes Node. On boot, migrations retry with backoff until the database is
reachable, and `/ready` stays `503` until they have been applied.

Going multi-region would mean choosing per show: a single home region that owns
the show's writes (other regions can't sell during a partition), or selling
everywhere and reconciling oversells afterwards. For seats, which are unique and
can't be un-sold gracefully, I would keep a single writer per show.

## Observability: what would page me at 2am
**Metrics** (`GET /metrics`, Prometheus format):
- `reservations_confirmed_total`, `reservations_cancelled_total` and
  `reservations_declined_total{reason}` (`seat_taken`, `per_user_limit`,
  `idempotent_replay`, `idempotency_key_reused`, `unknown_seat`), all labelled
  by `show_id`.
- `seats_available`, `seats_held`, `seats_confirmed`, `seats_total` per show.
  These are read from the database at scrape time (cached for 1s) rather than
  kept in memory, so they always match `GET /shows/{id}` and survive restarts.
- `http_requests_total{route,status}`, request latency, `db_pool_clients{state}`
  and Node process metrics.

The burst script checks that these reconcile with the API after every run: seat
gauges against the show's counts, `confirmed_total - cancelled_total` against
live reservations, and each decline reason against what it observed.

**Logs** are JSON (pino), one line per request:
`requestId, method, path, status, durationMs`. A caller's `X-Request-Id` is
reused, otherwise one is generated, and it is echoed in the response header, so
one request can be traced from client to log line.

**Pages:**
1. **The invariant breaks:** `seats_available + seats_held + seats_confirmed !=
   seats_total`. `seats_total` is stored at creation, not recounted, so a lost or
   extra seat row shows up here, as does `invariant_holds: false` on
   `GET /shows/{id}`. This means state is being corrupted. Alert on
   `seat_metrics_up == 0` alongside it, so a blind spot isn't mistaken for "no
   violations".
2. **Any `5xx` on `/reserve`.** Every domain outcome is a `4xx`, so a `5xx` means
   something is broken, not merely contested.
3. **`/ready` failing:** the database is unreachable and bookings are being
   refused.
4. **`db_pool_clients{state="waiting"}` staying high:** requests are queueing for
   database connections. Latency climbs next, and requests that wait longer than
   the 15s acquire timeout start getting `503`. This is the early warning for
   the capacity limit below.

Not a page: a spike in `reservations_declined_total{reason="seat_taken"}`. That
is what an on-sale looks like.

## Deployment and measured capacity
Deployed on Render's free tier: one Docker web service (0.1 CPU) and a free
Postgres 16 database, defined in `render.yaml`.

Live results against https://seat-reservation-y5uw.onrender.com:

| Run | Result |
|---|---|
| Full burst: 19,925 reserves, 300 in flight, five 500-user hot-seat storms | 21/21 checks, zero `5xx`, one winner per hot seat, 2,495 clean `409`s, invariant held in all 70 live samples, metrics reconciled. 48 req/s, p50 6.5s, p99 10.6s |
| 500 simultaneous requests for one seat | 1 × `201`, 499 × `409`, 11s |
| 1,000 simultaneous requests for one seat | 1 × `201`, 999 × `409`, 22.5s |

The same burst runs locally at about 2,200 req/s with p50 under 250ms.

**The free tier's limit is throughput, not correctness.** It processes about 45
reservations per second. During the full burst, all 20 database connections were
busy, 100–380 requests were queued waiting for one, and the process used slightly
more than its 0.1 CPU. My first live run fired 2,500 requests at the same instant
(five storms at once). Render's proxy answered 629 of them with its own non-JSON
`502` after about 20s of queueing. Those requests never reached the app: the
seat ledger and the per-reason decline counters both reconciled exactly with the
responses the app did send. The burst script now fires the storms one seat at a
time, and it reports any `5xx` as either from the app (JSON body) or from a
proxy in front of it.

So the guarantees hold at any load, but past roughly a thousand queued requests
on this instance, some requests are turned away with `5xx` before they get a
decision. The fixes, in order:
- a bigger instance (CPU-bound at 0.1 CPU)
- fewer database round trips per reservation (one statement claiming all seats,
  one stored procedure)
- shedding excess load early with `429 Retry-After` instead of letting it queue
  into a timeout

## AI usage

* **AI-assisted implementation:** Most of the code and tests were written with AI assistance (Claude in Cursor). I reviewed the implementation, validated it locally and with curl

* **My architecture & engineering decisions:** I owned the scope, system architecture, data model, concurrency strategy, API behavior, and key trade-offs — including all-or-nothing reservations, atomic seat claiming, idempotency, cancellation, immediate confirmation, metrics, burst testing, and deployment on Render.

* **Testing & hardening:** I used AI-assisted testing to identify and fix concurrency, idempotency, cancellation, validation, database-failure, and observability issues, and re-tested each fix. I also designed and validated the hot-seat concurrency tests to ensure exactly one winner per seat.

* **Production investigation:** I investigated the deployed service's `502` responses under 500–1,000 request bursts and determined they were caused by Render's free-tier proxy/capacity limits rather than application-level reservation failures. I documented the limitation instead of masking it.