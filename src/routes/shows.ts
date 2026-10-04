import { Router } from 'express';
import { randomUUID } from 'crypto';
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
  const parsed = validateReserve(req.body);
  if (!parsed.ok) {
    return res.status(400).json({ error: parsed.error });
  }

  // Shows are immutable once created, so this read can safely sit outside the transaction.
  const showRow = (await pool.query(`SELECT per_user_limit, price_paise FROM shows WHERE id = $1`, [showId])).rows[0];
  if (!showRow) {
    return res.status(404).json({ error: 'show_not_found' });
  }
  if (parsed.value.seats.length > showRow.per_user_limit) {
    return res.status(409).json({ error: 'per_user_limit_exceeded' });
  }

  // Lock order: seats (sorted) -> user_show_counts. Sorting means two overlapping
  // multi-seat requests take their shared seat locks in the same order, so they
  // can never deadlock waiting on each other.
  const sortedSeats = [...parsed.value.seats].sort();
  const reservationId = randomUUID();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // All-or-nothing: a decline rolls back every seat and counter change made so far.
    const decline = async (status: number, body: Record<string, unknown>) => {
      await client.query('ROLLBACK');
      res.status(status).json(body);
    };

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
