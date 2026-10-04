import { Router } from 'express';
import { createHash, randomUUID } from 'crypto';
import { pool } from '../db';
import { authMiddleware } from '../auth';
import { isUuid, validateCreateShow, validateReserve } from '../validation';

export const showsRouter = Router();

// ---------------------------------------------------------------------------
// POST /shows  (admin) - create a show with every seat "available"
// ---------------------------------------------------------------------------
showsRouter.post('/shows', async (req, res) => {
  const parsed = validateCreateShow(req.body);
  if (!parsed.ok) {
    return res.status(400).json({ error: parsed.error });
  }
  const { name, seats, price_paise, per_user_limit } = parsed.value;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const showResult = await client.query(
      `INSERT INTO shows (name, price_paise, per_user_limit, total_seats) VALUES ($1, $2, $3, $4)
       RETURNING id, name, price_paise, per_user_limit, total_seats`,
      [name, price_paise, per_user_limit, seats.length]
    );
    const show = showResult.rows[0];

    await client.query(
      `INSERT INTO seats (show_id, seat_number, status)
       SELECT $1, unnest($2::text[]), 'available'`,
      [show.id, seats]
    );
    await client.query('COMMIT');

    res.status(201).json({
      id: show.id,
      name: show.name,
      price_paise: show.price_paise,
      per_user_limit: show.per_user_limit,
      total_seats: show.total_seats,
      seats: seats.map((s: string) => ({ seat_number: s, status: 'available' })),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// GET /shows/:id - current per-seat status + reconciliation counts
// ---------------------------------------------------------------------------
showsRouter.get('/shows/:id', async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) {
    return res.status(404).json({ error: 'show_not_found' });
  }

  const showResult = await pool.query(`SELECT * FROM shows WHERE id = $1`, [id]);
  if (showResult.rowCount === 0) {
    return res.status(404).json({ error: 'show_not_found' });
  }
  const show = showResult.rows[0];

  const seatsResult = await pool.query(
    `SELECT seat_number, status FROM seats WHERE show_id = $1 ORDER BY seat_number`,
    [id]
  );

  const counts = { available: 0, held: 0, confirmed: 0 };
  for (const row of seatsResult.rows) {
    counts[row.status as keyof typeof counts]++;
  }

  res.status(200).json({
    id: show.id,
    name: show.name,
    price_paise: show.price_paise,
    per_user_limit: show.per_user_limit,
    seats: seatsResult.rows,
    counts,
    total_seats: show.total_seats,
    invariant_holds: counts.available + counts.held + counts.confirmed === show.total_seats,
  });
});

// ---------------------------------------------------------------------------
// POST /shows/:id/reserve - the heart of the assignment
// ---------------------------------------------------------------------------
showsRouter.post('/shows/:id/reserve', authMiddleware, async (req, res) => {
  const showId = req.params.id as string;
  const userId = (req as any).userId as string;
  if (!isUuid(showId)) {
    return res.status(404).json({ error: 'show_not_found' });
  }
  const parsed = validateReserve(req.body, req.get('idempotency-key'));
  if (!parsed.ok) {
    return res.status(400).json({ error: parsed.error });
  }
  const { seats: requestedSeats, idempotencyKey } = parsed.value;

  // Shows are immutable once created, so this read can safely sit outside the transaction.
  const showRow = (await pool.query(`SELECT per_user_limit, price_paise FROM shows WHERE id = $1`, [showId])).rows[0];
  if (!showRow) {
    return res.status(404).json({ error: 'show_not_found' });
  }

  // Lock order: idempotency key -> seats (sorted) -> user_show_counts. Sorting means
  // two overlapping multi-seat requests take their shared seat locks in the same
  // order, so they can never deadlock waiting on each other.
  const sortedSeats = [...requestedSeats].sort();
  const requestHash = createHash('sha256')
    .update(JSON.stringify({ showId, seats: sortedSeats }))
    .digest('hex');
  const reservationId = randomUUID();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Idempotency: the key is claimed inside the reservation transaction and commits
    // together with its outcome (a reservation or a stored decline). A concurrent
    // request with the same key blocks on this INSERT until the first one commits,
    // then replays whatever it recorded.
    const claim = await client.query(
      `INSERT INTO idempotency_keys (user_id, idempotency_key, request_hash, reservation_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, idempotency_key) DO NOTHING
       RETURNING reservation_id`,
      [userId, idempotencyKey, requestHash, reservationId]
    );

    if (claim.rowCount === 0) {
      const existing = (await client.query(
        `SELECT k.request_hash, k.response_status, k.response_body,
                r.id, r.show_id, r.user_id, r.seats, r.amount_paise, r.status
         FROM idempotency_keys k LEFT JOIN reservations r ON r.id = k.reservation_id
         WHERE k.user_id = $1 AND k.idempotency_key = $2`,
        [userId, idempotencyKey]
      )).rows[0];
      await client.query('ROLLBACK');

      if (existing.request_hash !== requestHash) {
        return res.status(409).json({ error: 'idempotency_key_reused_with_different_body' });
      }
      res.setHeader('Idempotent-Replayed', 'true');
      if (existing.response_status !== null) {
        return res.status(existing.response_status).json(existing.response_body);
      }
      // 200, not 201: a replay must not look like a second successful booking.
      return res.status(200).json({
        reservation_id: existing.id,
        show_id: existing.show_id,
        user_id: existing.user_id,
        seats: existing.seats,
        amount_paise: existing.amount_paise,
        status: existing.status,
      });
    }

    // All-or-nothing: a decline rolls back to this savepoint, undoing every seat and
    // counter change from this attempt, and commits only the key with its outcome.
    await client.query('SAVEPOINT attempt');
    const decline = async (status: number, body: Record<string, unknown>) => {
      await client.query('ROLLBACK TO SAVEPOINT attempt');
      await client.query(
        `UPDATE idempotency_keys SET reservation_id = NULL, response_status = $3, response_body = $4
         WHERE user_id = $1 AND idempotency_key = $2`,
        [userId, idempotencyKey, status, body]
      );
      await client.query('COMMIT');
      res.status(status).json(body);
    };

    if (sortedSeats.length > showRow.per_user_limit) {
      await decline(409, { error: 'per_user_limit_exceeded' });
      return;
    }

    // THE atomic decision: claim each seat with a conditional UPDATE. Concurrent
    // UPDATEs on the same row are serialized by Postgres; once the winner commits,
    // every waiter re-checks status = 'available', matches nothing, and is declined.
    for (const seatNumber of sortedSeats) {
      const seatUpdate = await client.query(
        `UPDATE seats
         SET status = 'confirmed', reservation_id = $1
         WHERE show_id = $2 AND seat_number = $3 AND status = 'available'
         RETURNING seat_number`,
        [reservationId, showId, seatNumber]
      );
      if (seatUpdate.rowCount === 0) {
        const exists = await client.query(
          `SELECT 1 FROM seats WHERE show_id = $1 AND seat_number = $2`,
          [showId, seatNumber]
        );
        if (exists.rowCount === 0) {
          await decline(422, { error: 'unknown_seat', seat: seatNumber });
        } else {
          await decline(409, { error: 'seat_unavailable', seat: seatNumber });
        }
        return;
      }
    }

    // Per-user limit: a guarded upsert, so the check and the increment are one
    // atomic step and parallel requests from the same user serialize on this row.
    const limitUpdate = await client.query(
      `INSERT INTO user_show_counts (user_id, show_id, held_count)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, show_id) DO UPDATE
         SET held_count = user_show_counts.held_count + EXCLUDED.held_count
         WHERE user_show_counts.held_count + EXCLUDED.held_count <= $4
       RETURNING held_count`,
      [userId, showId, sortedSeats.length, showRow.per_user_limit]
    );
    if (limitUpdate.rowCount === 0) {
      await decline(409, { error: 'per_user_limit_exceeded' });
      return;
    }

    const amountPaise = showRow.price_paise * sortedSeats.length;
    await client.query(
      `INSERT INTO reservations (id, show_id, user_id, seats, amount_paise, status)
       VALUES ($1, $2, $3, $4, $5, 'confirmed')`,
      [reservationId, showId, userId, sortedSeats, amountPaise]
    );

    await client.query('COMMIT');

    res.status(201).json({
      reservation_id: reservationId,
      show_id: showId,
      user_id: userId,
      seats: sortedSeats,
      amount_paise: amountPaise,
      status: 'confirmed',
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// POST /reservations/:id/cancel - only the owner may cancel their own reservation
// ---------------------------------------------------------------------------
export const reservationsRouter = Router();

reservationsRouter.post('/reservations/:id/cancel', authMiddleware, async (req, res) => {
  const reservationId = req.params.id as string;
  const userId = (req as any).userId as string;
  if (!isUuid(reservationId)) {
    return res.status(404).json({ error: 'reservation_not_found_or_not_cancellable' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Ownership and status are checked in the UPDATE's WHERE clause itself - the
    // same atomic-guard principle as the seat claim. Two concurrent cancels of the
    // same reservation serialize on this row, and only the first one matches.
    const resUpdate = await client.query(
      `UPDATE reservations
       SET status = 'cancelled'
       WHERE id = $1 AND user_id = $2 AND status = 'confirmed'
       RETURNING show_id, seats`,
      [reservationId, userId]
    );

    if (resUpdate.rowCount === 0) {
      await client.query('ROLLBACK');
      // Doesn't exist, isn't yours, or already cancelled: one answer for all three,
      // so a caller can't probe which reservation ids belong to other users.
      return res.status(404).json({ error: 'reservation_not_found_or_not_cancellable' });
    }

    const { show_id, seats } = resUpdate.rows[0];

    // Lock order: reservation -> seats (stored sorted) -> user_show_counts, the same
    // order reserve uses, so a cancel and a reserve never wait on each other in a cycle.
    // Each release is guarded on reservation_id, so it only ever frees a seat that
    // still belongs to this reservation.
    for (const seatNumber of seats) {
      await client.query(
        `UPDATE seats SET status = 'available', reservation_id = NULL
         WHERE show_id = $1 AND seat_number = $2 AND reservation_id = $3`,
        [show_id, seatNumber, reservationId]
      );
    }

    await client.query(
      `UPDATE user_show_counts SET held_count = held_count - $3
       WHERE user_id = $1 AND show_id = $2`,
      [userId, show_id, seats.length]
    );

    await client.query('COMMIT');
    res.status(200).json({ reservation_id: reservationId, status: 'cancelled' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});
