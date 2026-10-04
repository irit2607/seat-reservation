type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SEATS_PER_SHOW = 10_000;
const MAX_SEAT_LABEL_LENGTH = 32;
const MAX_NAME_LENGTH = 200;
// Keeps price * seats far below Number.MAX_SAFE_INTEGER.
const MAX_PRICE_PAISE = 1_000_000_000_000;
const MAX_PER_USER_LIMIT = 100;
const DEFAULT_PER_USER_LIMIT = 4;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function isObject(body: unknown): body is Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body);
}

function validateSeatList(seats: unknown, max: number): Result<string[]> {
  if (!Array.isArray(seats) || seats.length === 0 || seats.length > max) {
    return { ok: false, error: `seats must be a non-empty array of at most ${max} labels` };
  }
  for (const seat of seats) {
    if (typeof seat !== 'string' || seat.length === 0 || seat.length > MAX_SEAT_LABEL_LENGTH || seat.trim() !== seat) {
      return { ok: false, error: `each seat must be a non-blank string of at most ${MAX_SEAT_LABEL_LENGTH} chars` };
    }
  }
  if (new Set(seats).size !== seats.length) {
    return { ok: false, error: 'seats must not contain duplicates' };
  }
  return { ok: true, value: seats };
}

export interface CreateShowInput {
  name: string;
  seats: string[];
  price_paise: number;
  per_user_limit: number;
}

export function validateCreateShow(body: unknown): Result<CreateShowInput> {
  if (!isObject(body)) return { ok: false, error: 'body must be a JSON object' };
  const { name, seats, price_paise, per_user_limit = DEFAULT_PER_USER_LIMIT } = body;

  if (typeof name !== 'string' || name.trim() === '' || name.length > MAX_NAME_LENGTH) {
    return { ok: false, error: 'name must be a non-empty string' };
  }
  const seatList = validateSeatList(seats, MAX_SEATS_PER_SHOW);
  if (!seatList.ok) return seatList;
  if (!Number.isSafeInteger(price_paise) || (price_paise as number) < 0 || (price_paise as number) > MAX_PRICE_PAISE) {
    return { ok: false, error: 'price_paise must be a non-negative integer (paise)' };
  }
  if (!Number.isSafeInteger(per_user_limit) || (per_user_limit as number) < 1 || (per_user_limit as number) > MAX_PER_USER_LIMIT) {
    return { ok: false, error: `per_user_limit must be an integer between 1 and ${MAX_PER_USER_LIMIT}` };
  }
  return {
    ok: true,
    value: { name, seats: seatList.value, price_paise: price_paise as number, per_user_limit: per_user_limit as number },
  };
}

export interface ReserveInput {
  seats: string[];
}

export function validateReserve(body: unknown): Result<ReserveInput> {
  if (!isObject(body)) return { ok: false, error: 'body must be a JSON object' };
  const seatList = validateSeatList(body.seats, MAX_PER_USER_LIMIT);
  if (!seatList.ok) return seatList;
  return { ok: true, value: { seats: seatList.value } };
}
