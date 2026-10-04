// Usage: node burst.js <BASE_URL> [--requests 20000] [--concurrency 500] [--hot-seats 5] [--contenders 500]
//
// Reproduces an on-sale stampede against a fresh show and checks the correctness bar:
//   1. hot-seat storm: many users fire at the same few seats simultaneously
//   2. general stampede, skewed to "good" seats, with concurrent same-key retries
//   3. idempotency: simultaneous replays, same key + different body, reused declined key
//   4. per-user limit under parallel requests
//   5. identity: spoofed body user_id, cancelling someone else's reservation
//   6. cancel + rebook
// A sampler checks available + held + confirmed == total_seats throughout, and the
// final state is reconciled against every 201 we saw and against /metrics.
// Prints the outcome distribution and exits 1 if any check fails.

const args = parseArgs(process.argv.slice(2));
const BASE_URL = (args._[0] || 'http://localhost:3000').replace(/\/$/, '');
const REQUESTS = Number(args.requests ?? 20000);
const CONCURRENCY = Number(args.concurrency ?? 500);
const HOT_SEATS = Number(args['hot-seats'] ?? 5);
const CONTENDERS = Number(args.contenders ?? 500);
const PER_USER_LIMIT = 4;
const LIMIT_TEST_USERS = 10;
// Idempotency keys and user ids are prefixed per run so re-runs never collide.
const RUN_ID = Date.now().toString(36);

// Maps the API's error codes to the reason labels on reservations_declined_total.
const METRIC_REASON = {
  seat_unavailable: 'seat_taken',
  unknown_seat: 'unknown_seat',
  per_user_limit_exceeded: 'per_user_limit',
  idempotency_key_reused_with_different_body: 'idempotency_key_reused',
  idempotent_replay: 'idempotent_replay',
};

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[++i];
    else out._.push(argv[i]);
  }
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const range = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

async function api(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const started = performance.now();
  try {
    const res = await fetch(BASE_URL + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, body: json, replayed: res.headers.get('idempotent-replayed') === 'true', ms: performance.now() - started };
  } catch (err) {
    return { status: 0, body: null, replayed: false, ms: performance.now() - started, error: err.cause?.code ?? err.name };
  }
}

// ---- outcome bookkeeping -------------------------------------------------------

const stats = { byStatus: {}, byOutcome: {}, latencies: [] };
const ledger = new Map(); // seat -> reservation_id, from every 201 we received
const userSeats = new Map(); // user -> seats currently confirmed to them
const doubleSold = [];
let activeReservations = 0;

function outcomeOf(r) {
  if (r.status === 0) return 'network_error';
  if (r.replayed) return 'idempotent_replay';
  if (r.status === 201) return 'confirmed';
  if (r.status >= 500) return 'server_error';
  return r.body?.error ?? `http_${r.status}`;
}

async function reserve(showId, user, seats, key) {
  const r = await api('POST', `/shows/${showId}/reserve`, { token: user, body: { seats, idempotency_key: key } });
  stats.byStatus[r.status] = (stats.byStatus[r.status] || 0) + 1;
  const outcome = outcomeOf(r);
  stats.byOutcome[outcome] = (stats.byOutcome[outcome] || 0) + 1;
  stats.latencies.push(r.ms);
  if (outcome === 'confirmed') {
    activeReservations++;
    for (const seat of r.body.seats) {
      if (ledger.has(seat)) doubleSold.push(seat);
      ledger.set(seat, r.body.reservation_id);
    }
    userSeats.set(user, (userSeats.get(user) || 0) + r.body.seats.length);
  }
  return r;
}

async function cancel(reservationId, user) {
  const r = await api('POST', `/reservations/${reservationId}/cancel`, { token: user });
  if (r.status === 200) {
    activeReservations--;
    for (const [seat, id] of ledger) {
      if (id === reservationId) {
        ledger.delete(seat);
        userSeats.set(user, userSeats.get(user) - 1);
      }
    }
  }
  return r;
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function runPool(tasks, limit) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) await tasks[next++]();
  }));
}

const invariantHolds = (show) => show.counts.available + show.counts.held + show.counts.confirmed === show.total_seats;

function startSampler(showId) {
  const samples = { total: 0, violations: 0 };
  let running = true;
  const loop = (async () => {
    while (running) {
      const r = await api('GET', `/shows/${showId}`);
      if (r.status === 200) {
        samples.total++;
        if (!invariantHolds(r.body)) samples.violations++;
      }
      await sleep(250);
    }
  })();
  return { samples, stop: async () => { running = false; await loop; } };
}

function percentile(sorted, p) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0;
}

function metricValue(text, name, labels) {
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${name}{`)) continue;
    const [series, value] = line.split(' ');
    if (Object.entries(labels).every(([k, v]) => series.includes(`${k}="${v}"`))) return Number(value);
  }
  return 0;
}

// ---- the run -------------------------------------------------------------------

async function main() {
  console.log(`Target: ${BASE_URL}  requests≈${REQUESTS}  concurrency=${CONCURRENCY}  hot seats=${HOT_SEATS}x${CONTENDERS}\n`);
  const health = await api('GET', '/ready');
  if (health.status !== 200) {
    console.error(`Service not ready: /ready returned ${health.status || health.error}`);
    process.exit(1);
  }

  const hotSeats = range('H', HOT_SEATS);
  const generalSeats = range('G', Math.max(200, Math.round(REQUESTS / 10)));
  const limitSeats = range('L', LIMIT_TEST_USERS * 10);
  const seats = [...hotSeats, ...generalSeats, 'I1', 'I2', 'I3', ...limitSeats, 'C1', 'C2', 'S1'];
  const created = await api('POST', '/shows', {
    body: { name: `burst-${RUN_ID}`, seats, price_paise: 25000, per_user_limit: PER_USER_LIMIT },
  });
  if (created.status !== 201) {
    console.error(`Failed to create show: ${created.status} ${JSON.stringify(created.body)}`);
    process.exit(1);
  }
  const showId = created.body.id;
  console.log(`Show ${showId}: ${seats.length} seats, per_user_limit=${PER_USER_LIMIT}\n`);

  const sampler = startSampler(showId);
  const t0 = performance.now();

  // 1. Hot-seat storm: every contender for every hot seat fires at once.
  console.log(`--- 1. Hot-seat storm: ${CONTENDERS} users x ${HOT_SEATS} seats, all simultaneous`);
  const storm = await Promise.all(hotSeats.flatMap((seat) =>
    Array.from({ length: CONTENDERS }, (_, i) =>
      reserve(showId, `${RUN_ID}-hot-${seat}-${i}`, [seat], `${RUN_ID}-hot-${seat}-${i}`).then((r) => ({ seat, r })))
  ));
  const winners = hotSeats.map((seat) => storm.filter((x) => x.seat === seat && x.r.status === 201).length);
  const stormLosers = storm.filter((x) => x.r.status !== 201);
  check('exactly one 201 per hot seat', winners.every((w) => w === 1), `winners per seat: ${winners.join(',')}`);
  check('every hot-seat loser got a clean 409 seat_unavailable',
    stormLosers.every((x) => x.r.status === 409 && x.r.body?.error === 'seat_unavailable'),
    `${stormLosers.length} losers`);

  // 2. General stampede, skewed to the first 10% of seats; every 10th task fires an
  //    original request and its retry (same user, seats and key) at the same moment.
  const generalRequests = Math.max(0, REQUESTS - HOT_SEATS * CONTENDERS - 200);
  const users = Math.max(50, Math.floor(generalRequests / 4));
  const good = Math.max(2, Math.floor(generalSeats.length / 10));
  console.log(`--- 2. General stampede: ~${generalRequests} requests from ${users} users, ${CONCURRENCY} in flight`);
  const pairs = [];
  const tasks = [];
  for (let i = 0, planned = 0; planned < generalRequests; i++) {
    const start = Math.random() < 0.8
      ? Math.floor(Math.random() * (good - 1))
      : Math.floor(Math.random() * (generalSeats.length - 1));
    const wanted = Math.random() < 0.25 ? [generalSeats[start], generalSeats[start + 1]] : [generalSeats[start]];
    const user = `${RUN_ID}-u-${Math.floor(Math.random() * users)}`;
    const key = `${RUN_ID}-g-${i}`;
    planned += i % 10 === 9 ? 2 : 1;
    if (i % 10 === 9) {
      tasks.push(async () => {
        const both = await Promise.all([reserve(showId, user, wanted, key), reserve(showId, user, wanted, key)]);
        pairs.push(both);
      });
    } else {
      tasks.push(() => reserve(showId, user, wanted, key));
    }
  }
  await runPool(tasks, CONCURRENCY);
  const pairProblems = pairs.filter(([a, b]) => {
    const fresh = [a, b].filter((r) => !r.replayed);
    if (fresh.length !== 1) return true;
    const [original] = fresh;
    const replay = a === original ? b : a;
    if (original.status === 201) return replay.status !== 200 || replay.body?.reservation_id !== original.body.reservation_id;
    return replay.status !== original.status || replay.body?.error !== original.body?.error;
  });
  check('simultaneous same-key retries: one fresh outcome, the twin replays it exactly',
    pairProblems.length === 0, `${pairs.length} pairs, ${pairProblems.length} problems`);

  // 3. Idempotency edge cases.
  console.log('--- 3. Idempotency');
  const idemUser = `${RUN_ID}-idem`;
  const twenty = await Promise.all(Array.from({ length: 20 }, () => reserve(showId, idemUser, ['I1'], `${RUN_ID}-k1`)));
  const ids = new Set(twenty.map((r) => r.body?.reservation_id));
  check('20 simultaneous identical requests -> one 201, nineteen 200 replays, one reservation_id',
    twenty.filter((r) => r.status === 201).length === 1 && twenty.filter((r) => r.status === 200 && r.replayed).length === 19 && ids.size === 1,
    JSON.stringify(Object.fromEntries(Object.entries(twenty.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {})))));
  const diffBody = await reserve(showId, idemUser, ['I2'], `${RUN_ID}-k1`);
  check('same key + different seats -> 409', diffBody.status === 409 && diffBody.body?.error === 'idempotency_key_reused_with_different_body', `got ${diffBody.status}`);
  const declinedFirst = await reserve(showId, `${RUN_ID}-idem2`, ['I1'], `${RUN_ID}-k2`);
  const declinedReuse = await reserve(showId, `${RUN_ID}-idem2`, ['I3'], `${RUN_ID}-k2`);
  check('a declined key reused with different seats -> 409, nothing booked',
    declinedFirst.status === 409 && declinedReuse.status === 409 && declinedReuse.body?.error === 'idempotency_key_reused_with_different_body',
    `first ${declinedFirst.status}, reuse ${declinedReuse.status}`);

  // 4. Per-user limit: each user fires 10 parallel single-seat requests.
  console.log(`--- 4. Per-user limit: ${LIMIT_TEST_USERS} users x 10 parallel requests, limit ${PER_USER_LIMIT}`);
  const limitResults = await Promise.all(Array.from({ length: LIMIT_TEST_USERS }, (_, u) =>
    Promise.all(limitSeats.slice(u * 10, u * 10 + 10).map((seat) =>
      reserve(showId, `${RUN_ID}-limit-${u}`, [seat], `${RUN_ID}-limit-${u}-${seat}`)))
  ));
  const perUser = limitResults.map((rs) => rs.filter((r) => r.status === 201).length);
  check(`each user ends with at most ${PER_USER_LIMIT} seats`, perUser.every((n) => n <= PER_USER_LIMIT), `confirmed per user: ${perUser.join(',')}`);
  check('the rest are clean 409 per_user_limit_exceeded',
    limitResults.flat().filter((r) => r.status !== 201).every((r) => r.status === 409 && r.body?.error === 'per_user_limit_exceeded'));

  // 5. Identity comes from the token, never the body.
  console.log('--- 5. Identity');
  const realUser = `${RUN_ID}-real`;
  const spoofRes = await api('POST', `/shows/${showId}/reserve`, {
    token: realUser,
    body: { seats: ['S1'], idempotency_key: `${RUN_ID}-spoof`, user_id: `${RUN_ID}-victim` },
  });
  if (spoofRes.status === 201) {
    activeReservations++;
    ledger.set('S1', spoofRes.body.reservation_id);
    userSeats.set(realUser, 1);
    stats.byStatus[201] = (stats.byStatus[201] || 0) + 1;
    stats.byOutcome.confirmed = (stats.byOutcome.confirmed || 0) + 1;
  }
  check('spoofed body user_id is ignored', spoofRes.status === 201 && spoofRes.body.user_id === realUser, `user_id=${spoofRes.body?.user_id}`);
  const foreignCancel = await cancel(spoofRes.body?.reservation_id, `${RUN_ID}-victim`);
  check("another user cannot cancel someone else's reservation", foreignCancel.status === 404, `got ${foreignCancel.status}`);

  // 6. Cancel and rebook.
  console.log('--- 6. Cancel + rebook');
  const owner = `${RUN_ID}-owner`;
  const booked = await reserve(showId, owner, ['C1', 'C2'], `${RUN_ID}-c1`);
  const cancelled = await cancel(booked.body?.reservation_id, owner);
  const cancelledAgain = await cancel(booked.body?.reservation_id, owner);
  const rebooked = await reserve(showId, `${RUN_ID}-rebook`, ['C1'], `${RUN_ID}-c2`);
  check('owner cancel 200, repeat cancel 404, released seat re-bookable',
    booked.status === 201 && cancelled.status === 200 && cancelledAgain.status === 404 && rebooked.status === 201,
    `${booked.status}/${cancelled.status}/${cancelledAgain.status}/${rebooked.status}`);

  await sampler.stop();
  const elapsed = (performance.now() - t0) / 1000;

  // ---- final reconciliation ----------------------------------------------------
  console.log('\n--- Final reconciliation');
  const final = (await api('GET', `/shows/${showId}`)).body;
  const { available, held, confirmed } = final.counts;
  console.log(`  available=${available} held=${held} confirmed=${confirmed} total_seats=${final.total_seats}`);
  check('available + held + confirmed == total_seats', invariantHolds(final));
  check('invariant held in every live sample during the burst', sampler.samples.violations === 0,
    `${sampler.samples.total} samples, ${sampler.samples.violations} violations`);
  check('no seat appeared in two 201s', doubleSold.length === 0, doubleSold.length ? `double-sold: ${doubleSold.slice(0, 5).join(',')}` : undefined);
  check('confirmed seats in the API == seats from our 201s (minus cancels)', confirmed === ledger.size, `API ${confirmed}, ours ${ledger.size}`);
  const overLimit = [...userSeats.values()].filter((n) => n > PER_USER_LIMIT).length;
  check(`no user holds more than ${PER_USER_LIMIT} seats`, overLimit === 0, `${userSeats.size} users with seats`);
  const serverErrors = Object.entries(stats.byStatus).filter(([s]) => Number(s) >= 500).reduce((n, [, c]) => n + c, 0);
  check('zero 5xx', serverErrors === 0, `${serverErrors} server errors`);
  check('zero network errors / timeouts', !stats.byOutcome.network_error, `${stats.byOutcome.network_error || 0}`);

  console.log('\n--- Metrics reconciliation (assumes a single instance that did not restart mid-run)');
  await sleep(1100); // seat gauges are cached for 1s
  const metricsRes = await fetch(`${BASE_URL}/metrics`).then((r) => r.text()).catch(() => '');
  const m = (name, labels = {}) => metricValue(metricsRes, name, { show_id: showId, ...labels });
  check('seats_available / seats_confirmed / seats_total match the API',
    m('seats_available') === available && m('seats_confirmed') === confirmed && m('seats_total') === final.total_seats,
    `metrics ${m('seats_available')}/${m('seats_confirmed')}/${m('seats_total')}`);
  const netConfirmed = m('reservations_confirmed_total') - m('reservations_cancelled_total');
  check('reservations_confirmed_total - reservations_cancelled_total == active reservations', netConfirmed === activeReservations,
    `metrics ${netConfirmed}, ours ${activeReservations}`);
  const reasonMismatches = Object.entries(METRIC_REASON)
    .map(([code, reason]) => [reason, stats.byOutcome[code] || 0, m('reservations_declined_total', { reason })])
    .filter(([, ours, theirs]) => ours !== theirs);
  check('reservations_declined_total{reason} matches the declines we observed', reasonMismatches.length === 0,
    reasonMismatches.map(([r, o, t]) => `${r}: ours ${o} vs metrics ${t}`).join('; ') || undefined);

  // ---- summary -----------------------------------------------------------------
  const sorted = [...stats.latencies].sort((a, b) => a - b);
  const total = stats.latencies.length;
  console.log('\n=== Outcome distribution (reserve requests) ===');
  console.log(`  total ${total} in ${elapsed.toFixed(1)}s (${(total / elapsed).toFixed(0)} req/s)`);
  console.log(`  by HTTP status: ${JSON.stringify(stats.byStatus)}`);
  console.log(`  by outcome:     ${JSON.stringify(stats.byOutcome)}`);
  console.log(`  latency ms:     p50 ${percentile(sorted, 50).toFixed(0)}  p95 ${percentile(sorted, 95).toFixed(0)}  p99 ${percentile(sorted, 99).toFixed(0)}  max ${(sorted.at(-1) ?? 0).toFixed(0)}`);

  const failed = checks.filter((c) => !c.ok);
  console.log(`\nRESULT: ${failed.length === 0 ? 'PASS' : 'FAIL'} (${checks.length - failed.length}/${checks.length} checks passed)`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Burst script failed:', err);
  process.exit(1);
});
