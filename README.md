# Room Acoustics Service

A room-acoustics calculation backend for building-acoustics tooling. It accepts
room geometry and octave-band material absorption data over HTTP, computes
per-band reverberation times with the **Sabine** and **Eyring** models plus
derived quantities (critical distance, Schroeder frequency), and can overlay
the effect of **Helmholtz resonator absorbers**. Every calculation is persisted
for an audit trail.

No web UI, no user accounts — just an HTTP API for acoustics tools.

## Stack

- Node.js 20 + TypeScript, Fastify 5 (web layer)
- PostgreSQL 16 (persistence)
- Vitest (automated tests)
- Docker + docker-compose (delivery)

## Physical conventions (fixed, single source of truth)

All constants live in [`src/constants.ts`](src/constants.ts) and are shared by
both reverberation models — they are never redeclared per model.

| Constant | Value | Note |
| --- | --- | --- |
| Reference temperature | 20 °C | c ≈ 343 m/s at this temperature |
| Speed of sound | `c(T) = 331.3·√(1 + T/273.15)` m/s | c(20 °C) = 343.2 m/s |
| Sabine coefficient | 0.161 s/m | consistent with c ≈ 343 m/s |
| Critical distance | `dc = 0.057·√(V/T60)` m | omnidirectional source (Q = 1) |
| Schroeder frequency | `fs = 2000·√(T60/V)` Hz | uses the T60 of the same calculation |
| Air attenuation `m` | per-band, Np/m | ISO 9613-1 at 20 °C / 70 % RH, dB/km ÷ 4343 |
| Octave bands | 125, 250, 500, 1000, 2000, 4000 Hz | pinned centre frequencies |
| Resonator end correction δ | 1.7 | `L_eff = L + δ·√(S_n/π)` |
| Resonator profile | Lorentzian, Q = 5 | half-width γ = f0/(2Q) |

Air attenuation `m` per band (Np/m): 125 Hz 9.44e-5, 250 Hz 2.39e-4,
500 Hz 4.51e-4, 1000 Hz 8.43e-4, 2000 Hz 2.22e-3, 4000 Hz 7.55e-3.

## Models

### Reverberation kernel ([`src/acoustics.ts`](src/acoustics.ts))

For each octave band:

- Surface absorption `A_surface = Σ Sᵢ·αᵢ`
- Air absorption `A_air = 4·m·V`
- Resonator absorption `A_res` (zero unless resonators are supplied)
- **Sabine**: `A = A_surface + A_air + A_res`, `T60,S = 0.161·V / A`
- **Eyring**: `ᾱ = A_surface / S` (surfaces only),
  `T60,E = 0.161·V / (−S·ln(1−ᾱ) + A_air + A_res)`

The minus sign in `−S·ln(1−ᾱ)` is load-bearing: `−ln(1−ᾱ)` is positive for
`0 < ᾱ < 1`. Flipping the sign makes the models diverge in opposite directions
for absorptive rooms; the test-suite locks the correct behaviour
(Eyring ≈ Sabine as `ᾱ → 0`, Eyring markedly shorter for high `ᾱ`).
The air term is shared by both models so they coincide at low absorption.

Derived quantities per band and per model use **that model's freshly computed
T60** — never a decoupled constant:

- `dc = 0.057·√(V/T60)`
- `fs = 2000·√(T60/V)`

### Helmholtz resonators ([`src/helmholtz.ts`](src/helmholtz.ts))

Given neck area `S_n`, neck length `L`, cavity volume `V_c` and temperature:

1. `c(T)` from the shared temperature convention (c, λ and f0 stay consistent)
2. `L_eff = L + 1.7·√(S_n/π)`
3. `f0 = (c/2π)·√(S_n / (V_c·L_eff))`
4. Peak absorption cross-section per unit `σ₀ = λ₀²/(2π)` with `λ₀ = c/f0`
5. Band contribution (Lorentzian, half-width `γ = f0/10`):
   `ΔA(f) = count·σ₀ / (1 + ((f − f0)/γ)²)`

`ΔA` is added to the band's total absorption and the **whole reverberation
calculation is re-run** — results are never produced by subtracting a delta
from an untreated curve.

Invalid geometry (negative neck length, non-positive neck area or cavity
volume, non-integer count) is rejected with structured reasons.

## API

Base URL: `http://localhost:3000`

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | liveness |
| GET | `/api/v1/constants` | the shared physical constants |
| GET | `/api/v1/examples/classroom` | preset classroom payload |
| GET | `/api/v1/examples/classroom-with-resonator` | same room + 500 Hz resonator bank |
| POST | `/api/v1/calculations` | validate, compute, persist; returns the record |
| GET | `/api/v1/calculations` | list recent records (`?limit=`, ≤ 500) |
| GET | `/api/v1/calculations/:id` | fetch one record (404 with error body if unknown) |

### Request body (POST /api/v1/calculations)

```json
{
  "room": {
    "name": "classroom-example",
    "volume": 201.6,
    "surfaces": [
      {
        "name": "ceiling (acoustic tiles)",
        "area": 63.0,
        "coefficients": { "125": 0.35, "250": 0.5, "500": 0.65, "1000": 0.75, "2000": 0.8, "4000": 0.75 }
      }
    ]
  },
  "resonators": [
    { "neckArea": 0.002, "neckLength": 0.02, "cavityVolume": 0.00038, "count": 100 }
  ]
}
```

Rules: `volume > 0`; at least one surface; every `area > 0`; every coefficient
present for all six pinned bands and within `[0, 1]`; `resonators` optional
(`neckArea > 0`, `neckLength ≥ 0`, `cavityVolume > 0`, `count` positive
integer, `temperatureC` optional, default 20 °C).

### Responses

- `201` with the calculation record: `id`, `createdAt`, echoed `request`, and
  `result` — per band: absorption breakdown (`surface` / `air` / `resonators`
  / `total`), mean absorption coefficient, and for each model `t60Seconds`,
  `criticalDistanceMeters`, `schroederFrequencyHz`. Non-finite degenerate
  values (e.g. zero absorption) are returned as `null`.
- `400` with a structured reason list, e.g.:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request failed validation.",
    "details": [
      { "field": "room.volume", "reason": "must be positive, got -5" },
      { "field": "room.surfaces[0].coefficients.500", "reason": "must be between 0 and 1 inclusive, got 1.3" }
    ]
  }
}
```

### Example

```bash
curl -s -X POST http://localhost:3000/api/v1/calculations \
  -H 'content-type: application/json' \
  -d @<(curl -s http://localhost:3000/api/v1/examples/classroom-with-resonator)
```

The preset classroom (9.0 × 7.0 × 3.2 m, V = 201.6 m³, S = 228.4 m²) yields
mid-frequency Sabine T60 of roughly 0.5–0.7 s; the example resonator bank is
tuned to f0 ≈ 500 Hz and pulls the 500 Hz band down while leaving neighbouring
bands almost unchanged.

## Modules

| Module | Responsibility |
| --- | --- |
| `src/constants.ts` | shared physical constants & conventions (single source) |
| `src/validation.ts` | material/geometry/resonator validation, structured errors |
| `src/acoustics.ts` | Sabine + Eyring kernel, dc / fs derivation |
| `src/helmholtz.ts` | resonator physics (L_eff, f0, Lorentzian band absorption) |
| `src/persistence/` | repository port + PostgreSQL 16 and in-memory adapters |
| `src/server.ts` / `src/routes.ts` | Fastify wiring |
| `src/examples/classroom.ts` | preset classroom example |

The calculation core is pure and stateless; each submission is persisted as
its own record (room row + calculation row in one transaction), so concurrent
room schemes never bleed into each other.

## Running with Docker

```bash
docker compose up --build
```

This starts PostgreSQL 16 (with a healthcheck and a persistent volume) and the
service on `http://localhost:3000`. The service applies its schema
(`src/persistence/schema.sql`, idempotent) at startup, retrying until the
database is ready.

## Running locally

```bash
npm install
npm run dev          # tsx watch, in-memory persistence unless DATABASE_URL is set
# or
npm run build && npm start
```

Configuration via environment: `HOST` (default `0.0.0.0`), `PORT` (default
`3000`), `DATABASE_URL` (e.g. `postgres://acoustics:acoustics@localhost:5432/acoustics`;
when unset the service warns and keeps records in memory only).

## Tests

```bash
npm test
```

The suite locks the required causal invariants:

- classroom example: mid-band Sabine T60 in the 0.1–2 s range, no negative T60 anywhere;
- increasing absorption ⇒ T60 decreases and critical distance increases in every band (both models);
- a 500 Hz resonator lowers the 500 Hz band T60, neighbours are affected ≥ 5× less;
- low `ᾱ` ⇒ Sabine ≈ Eyring; high `ᾱ` ⇒ Eyring markedly shorter (sign guard);
- resonator results are recomputed from the new total absorption (T60 = 0.161·V/A_total with A_total including ΔA);
- invalid geometry and out-of-range coefficients are rejected with structured reasons;
- concurrent submissions stay isolated and are individually retrievable.

A PostgreSQL integration test runs when `TEST_DATABASE_URL` is set:

```bash
TEST_DATABASE_URL=postgres://acoustics:acoustics@localhost:5432/acoustics npm test
```
