# Seat Reservation Service

A JSON HTTP API for selling assigned seats that stays correct under heavy
concurrent load: no seat is ever double-sold, per-user limits hold, and retried
requests never book twice.

Node.js + TypeScript + Express, deployed on Render.

## Running locally
Requires Node.js 22+.
```bash
npm install
cp .env.example .env
npm run dev          # restarts on every file save
```
Then:
```bash
curl http://localhost:3000/health     # {"status":"ok"}
```

Production-style run (compile TypeScript to `dist/`, then run the compiled JS):
```bash
npm run build
npm start
```

## Running with Docker
```bash
docker build -t seat-reservation .
docker run --rm -p 3000:3000 seat-reservation
```

## Deploying (Render)
`render.yaml` is a Render Blueprint. In the Render dashboard choose
**New → Blueprint**, select this repo, and **Apply**. Render builds the
`Dockerfile`, starts the container, and checks `/health`. Every push to `main`
redeploys automatically.

## API
Errors are always JSON: `{ "error": "<code>" }`.

### `GET /health`
Liveness only: `200 {"status":"ok"}` while the process is running.

Every response carries an `x-request-id` header. Send your own
`X-Request-Id` to have it echoed back and used in the logs.
