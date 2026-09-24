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

### Goal-driven inverse solver ([`src/prescription/solver.ts`](src/prescription/solver.ts))

The forward kernel only answers "given materials, what is the T60?". The
inverse solver answers the studio question "given target T60 values, what
must I add?". It is a pure search/conversion layer wrapped around the
**unmodified** forward modules:

- no physical constants or reverberation formulas are redeclared — every
  trial is scored by calling `computeAcoustics`;
- resonator geometry is inverted by bisecting the cavity volume against
  `buildResonator`, so the end correction, temperature-consistent speed of
  sound, tuning frequency and Lorentzian Q all keep their single source;
- the final prescription is independently verified by rebuilding the
  treated scheme and re-running the complete forward calculation — the
  returned `verification` block is that fresh result, not a promise.

Targets are sparse: any subset of the six octave bands may carry a target
T60 (seconds); unpinned bands impose no hard requirement. Added absorption
can only shorten T60, so a band whose baseline already lies at or below the
upper tolerance edge needs nothing (a target *longer* than the current T60
yields an empty prescription).

Two convertible prescription types:

1. **Surface** — raise the coefficient of named, existing candidate
   surfaces to one common feasible level per pinned band, via monotone
   bisection. The level is the smallest that enters the tolerance band and
   is physically capped at 1. If saturating every candidate at 1 still
   leaves a band over its upper edge, the band is reported unreachable
   (`surface-coefficient-ceiling`) with the best achievable T60.
2. **Resonator** — design one resonator unit per deficient band (neck
   geometry from a template, cavity tuned by the solver) and search the
   integer group counts. The forward model makes the effective Sabine /
   Eyring denominator **linear** in every count, with the Lorentzian tails
   forming a positive spillover matrix `G`:

   ```
   D_j(n) = D0_j + Σ_i n_i · G[i][j],
   L_j = KV / (T·(1+tol)) ≤ D_j ≤ KV / (T·(1−tol)) = U_j.
   ```

   Phase 1 raises counts until every lower denominator bound is met
   (groups for one band add positive tails to neighbouring bands — the
   coupling is included, not ignored); phase 2 removes units only while no
   band re-opens a lower-bound gap. Failure is reported honestly, with the
   physical reason: `resonator-group-cap`, `resonator-spillover` (a band
   cannot be relieved without re-opening another) or
   `resonator-quantization` (integer group granularity at tight
   tolerances). Counts are never negative and never exceed the configured
   cap.

`strategy` is `surface`, `resonator` (caller preference) or `auto`
(surface first; when its coefficient ceiling proves insufficient the
solver records the failed attempt and falls back to resonators).

Every solve, including unreachable ones, is persisted for the same audit
trail as ordinary calculations. The solver holds no module-level state, so
concurrent requests cannot share intermediate state.

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
| POST | `/api/v1/prescriptions` | goal-driven inverse solve, forward-verified and persisted |
| GET | `/api/v1/prescriptions` | list recent prescription solves (`?limit=`, ≤ 500) |
| GET | `/api/v1/prescriptions/:id` | fetch one prescription (404 with error body if unknown) |

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

### Prescription request (POST /api/v1/prescriptions)

```json
{
  "room": { "...same room schema as /calculations..." },
  "resonators": [],
  "targets": { "500": 0.6, "1000": 0.6 },
  "toleranceRatio": 0.05,
  "model": "sabine",
  "preferences": {
    "strategy": "auto",
    "candidateSurfaceNames": ["ceiling (hard plaster)", "walls (block + paint)"],
    "resonatorTemplate": { "neckArea": 0.002, "neckLength": 0.02, "temperatureC": 20 },
    "maxResonatorGroups": 2000
  }
}
```

Rules: `targets` maps any non-empty subset of octave bands to a **positive**
target T60 in seconds (missing bands are unpinned); `toleranceRatio` is the
half-width as a fraction of target, default 0.05, allowed
[0, 0.5]; `model` is `sabine` (default) or `eyring`; `strategy` is `surface`,
`resonator` or `auto` (default); `candidateSurfaceNames` must reference
surfaces that exist in the submitted room and is required for `surface` and
`auto`; `resonatorTemplate` (optional) fixes the neck geometry and
temperature while the solver tunes the cavity volume; `maxResonatorGroups`
(default 2000) is a positive integer cap per tuned band.

Responses:

- `201` with the prescription record: `status` (`already-compliant`,
  `solved`, `unreachable`), `strategyUsed`, `fallbackUsed`, per-target
  status (`within-tolerance`, `already-better-than-target`, `unreachable`,
  `over-treated`) and the additional absorption each target demands, the
  `prescription` (surface coefficient levels / resonator groups with a
  ready-to-submit resonator each), the complete `verification` forward
  run, `attempts` audit notes, and solver counters.
- `422 TARGET_UNREACHABLE` for a well-formed but physically impossible
  request: the body carries `unreachableDetails` (limitation + best
  achievable T60 per band) and the full persisted `record`.
- `400 VALIDATION_ERROR` with the same structured field/reason shape as
  `/calculations` (non-positive targets, out-of-range tolerance, unknown
  candidate surfaces, bad group caps, invalid template geometry, …).

## Modules

| Module | Responsibility |
| --- | --- |
| `src/constants.ts` | shared physical constants & conventions (single source) |
| `src/validation.ts` | material/geometry/resonator validation, structured errors |
| `src/acoustics.ts` | Sabine + Eyring kernel, dc / fs derivation |
| `src/helmholtz.ts` | resonator physics (L_eff, f0, Lorentzian band absorption) |
| `src/prescription/solver.ts` | goal-driven inverse search & prescription conversion (forward kernel reused unchanged) |
| `src/prescription/errors.ts` | unreachable-target error carrying the audited solve record |
| `src/persistence/` | repository ports + PostgreSQL 16 and in-memory adapters |
| `src/server.ts` / `src/routes.ts` | Fastify wiring |
| `src/examples/classroom.ts`, `src/examples/liveStudio.ts` | preset examples |

The calculation core is pure and stateless; each submission is persisted as
its own record (room row + calculation row in one transaction), so concurrent
room schemes never bleed into each other. The prescription solver is likewise
stateless — every solve builds its own room clones, resonator banks and search
counters, and each prescription is persisted in its own transaction.

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

The inverse-solver suite additionally locks:

- a live room pinned to a shorter mid-band target receives a surface or
  resonator prescription whose complete forward re-run lands the pinned
  band inside its tolerance band (Sabine and Eyring);
- a target at or above the current T60 returns an empty prescription — no
  absorption is invented;
- an impossibly short target is reported `unreachable` with the best
  achievable T60, never an out-of-range coefficient or a negative /
  over-cap group count;
- multi-band resonator prescriptions account for Lorentzian spillover so
  every pinned band is inside its band simultaneously;
- `auto` falls back to resonators only after the surface coefficient
  ceiling is proven insufficient, recording both attempts;
- the carried `verification` equals an independent `computeAcoustics`
  call on the treated scheme, and the submitted room is never mutated;
- non-positive targets, out-of-range tolerance, unknown / duplicate
  candidate surfaces, bad group caps and invalid resonator templates are
  rejected with structured field/reason errors;
- parallel solves stay isolated, each retrievable by its own id.

A PostgreSQL integration test runs when `TEST_DATABASE_URL` is set:

```bash
TEST_DATABASE_URL=postgres://acoustics:acoustics@localhost:5432/acoustics npm test
```
