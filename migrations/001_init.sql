CREATE TABLE shows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  price_paise BIGINT NOT NULL CHECK (price_paise >= 0),
  per_user_limit INT NOT NULL DEFAULT 4 CHECK (per_user_limit >= 1),
  -- Fixed at creation, so reconciliation compares live counts against a stored
  -- number rather than against the rows it just counted.
  total_seats INT NOT NULL CHECK (total_seats > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per seat. A seat is claimed by a conditional UPDATE on its row, so the
-- row lock is what serializes concurrent buyers of the same seat.
CREATE TABLE seats (
  show_id UUID NOT NULL REFERENCES shows(id),
  seat_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'held', 'confirmed')),
  reservation_id UUID,
  PRIMARY KEY (show_id, seat_number)
);

CREATE TABLE reservations (
  id UUID PRIMARY KEY,
  show_id UUID NOT NULL REFERENCES shows(id),
  user_id TEXT NOT NULL,
  seats TEXT[] NOT NULL,
  amount_paise BIGINT NOT NULL CHECK (amount_paise >= 0),
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seats each user currently holds per show. The per-user limit is enforced by a
-- guarded upsert on this row, so parallel requests from one user serialize here.
CREATE TABLE user_show_counts (
  user_id TEXT NOT NULL,
  show_id UUID NOT NULL REFERENCES shows(id),
  held_count INT NOT NULL DEFAULT 0 CHECK (held_count >= 0),
  PRIMARY KEY (user_id, show_id)
);
