# Room Acoustics Service

A room-acoustics calculation backend for building-acoustics tooling. It accepts
room geometry and octave-band material absorption data over HTTP, computes
per-band reverberation times with the **Sabine** and **Eyring** models plus
derived quantities (critical distance, Schroeder frequency), and can overlay
the effect of **Helmholtz resonator absorbers**. Every calculation is persisted
for an audit trail.

On top of the forward kernel it also offers **goal-driven inverse solving**
(`POST /api/v1/prescriptions`): hand in a room plus per-octave-band *target*
reverberation times (only the bands you care about need pinning) and get back a
buildable absorption prescription — either surface-coefficient levelling on
candidate surfaces or tuned Helmholtz resonator banks — together with the
forward re-check proving the prescribed room meets every pinned band within a
configurable tolerance. No parallel physics: the solver is a search/conversion
layer around the unchanged forward kernel.

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

## Goal-driven absorption prescriptions ([`src/prescription/`](src/prescription/))

The inverse solver answers the question "what do I have to add to this room so
that the pinned bands meet their targets?". It contains **no physical formulas
of its own**: it reuses `computeAcoustics`, `buildResonator` and the constants
in `src/constants.ts`, inverting the kernel's analytic relations only to
propose treatment, and always verifying every proposal by re-running the
complete forward calculation.

### Request (`POST /api/v1/prescriptions`)

```json
{
  "room": { "...same room schema as /calculations..." },
  "resonators": [ "...optional baseline resonators already installed..." ],
  "model": "sabine",
  "strategy": "auto",
  "toleranceRatio": 0.05,
  "targets": {
    "500": { "t60Seconds": 0.6 },
    "1000": { "t60Seconds": 0.6, "toleranceRatio": 0.02 }
  },
  "candidateSurfaces": ["ceiling", "walls"],
  "resonatorUnit": { "neckArea": 0.002, "neckLength": 0.02 },
  "maxResonatorGroupsPerBand": 2000
}
```

- `targets` is **sparse**: omit a band to leave it unpinned; at least one band
  must be pinned. Each entry pins `t60Seconds` and may override the request
  `toleranceRatio` for that band.
- The tolerance band is `target·(1±toleranceRatio)` (default 0.05, allowed
  range 0.001–0.5).
- `strategy`: `surface` (raise candidate-surface coefficients), `resonator`
  (deploy tuned banks), or `auto` (try surfaces, fall back to resonators).
- `candidateSurfaces` names surfaces that really exist in the submitted room.
- `resonatorUnit` is the per-group template: `neckArea`/`neckLength` required;
  `cavityVolume` optional — when omitted it is derived from the shared
  Helmholtz conventions so each bank's f0 lands on its pinned band centre. A
  supplied cavity must tune inside the pinned band's octave. `count` is never
  accepted on a template: the solver decides the number of groups.
- `model` selects which kernel (`sabine` default) the targets and verification
  are evaluated against.

### How the inverse solve works

1. The forward kernel establishes the baseline per-band T60 and absorption
   breakdown. Bands already inside their tolerance band require **no**
   treatment (empty prescription); a band already shorter than the lower edge
   is immediately reported unreachable — absorption cannot lengthen a room.
2. **Surface path** — per band, invert the kernel to get the surface
   absorption needed at the target centre (or the upper edge when the centre
   is out of reach). The candidate surfaces are then *water-filled* to a
   single uniform coefficient τ (closed-form piecewise-linear inversion,
   surfaces already above τ untouched). If even τ = 1 on every candidate
   misses the upper edge, the band is physically unreachable by surfaces.
3. **Resonator path** — one bank per pinned band; its Lorentzian profile (from
   `buildResonator`, Q and end correction from the shared constants) is the
   spillover coupling. A greedy integer search adds one group at a time, each
   candidate increment evaluated through the **full forward kernel**, and an
   increment is rejected if it pushes *any* pinned band below its lower
   tolerance edge — the guard that stops neighbouring bands being robbed.
   Per-bank "safe capacity" (binary-searched against the lower edges) plus the
   configurable group cap prove when no integer vector can succeed.
4. The chosen treatment is applied to the original room and the **unchanged
   forward kernel is re-run**. `status` is `solved` only when every pinned
   band's achieved T60 lies inside its tolerance band. Otherwise the status is
   `unreachable` and the response carries `unreachable.reason` plus the best
   achievable configuration and its per-band verification — never a fabricated
   coefficient > 1 or negative group count.

### Result

`status` is one of `not-needed` (empty prescription), `solved` or
`unreachable`. The payload includes the `baseline` forward result, the
`surface` and/or `resonators` prescription (surfaces are complete six-band
materials ready to feed straight back into `/calculations`; resonator banks
are full resonator inputs with the solved `count`), the authoritative
`verification` forward result, and per-band `bandVerification` rows
(target, tolerance edges, baseline T60, achieved T60, withinTolerance).

Prescription validation rejects, with the same structured per-field error
body as `/calculations`: non-positive targets, out-of-range tolerances
(request-level and per-band), unknown octave bands, no pinned bands, candidate
surfaces missing from the room, strategy/parameter mismatches, malformed
resonator templates (including a fixed cavity that does not tune to the
pinned band), and group caps that are not positive integers within the hard
bound.

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
| POST | `/api/v1/prescriptions` | goal-driven inverse solve, verified, persisted |
| GET | `/api/v1/prescriptions` | list recent prescriptions (`?limit=`, ≤ 500) |
| GET | `/api/v1/prescriptions/:id` | fetch one prescription (404 if unknown) |

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
| `src/prescription/types.ts` | inverse-solve request/result types & boundary values |
| `src/prescription/validation.ts` | target/tolerance/surface/template validation |
| `src/prescription/solver.ts` | surface water-fill + coupled resonator integer search |
| `src/prescription/` (memory/postgres/repository) | prescription persistence, decoupled from calculations |
| `src/server.ts` / `src/routes.ts` | Fastify wiring |
| `src/examples/classroom.ts` | preset classroom example |

The calculation core and the inverse solver are both pure and stateless; each
submission is persisted as its own record (room row + calculation row in one
transaction), so concurrent room schemes never bleed into each other.

## Running with Docker

```bash
docker compose up --build
```

This starts PostgreSQL 16 (with a healthcheck and a persistent volume) and the
service on `http://localhost:3000`. The service applies its schemas
(`src/persistence/schema.sql` and
`src/prescription/prescription-schema.sql`, both idempotent) at startup,
retrying until the database is ready.

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

The prescription suite additionally locks the inverse-solve causality:

- a reverberant room pinned to a much shorter mid-band target gets a
  prescription whose forward re-check lands inside the tolerance band
  (independently re-fed through `computeAcoustics`), with no coefficient > 1;
- a target the baseline already meets yields `not-needed` and an empty
  prescription, never added treatment;
- a target longer than the baseline but not containing it is `unreachable`;
- a target beyond the physical limit (candidate coefficients saturated at 1,
  or the resonator group cap reached) is reported `unreachable` with the best
  achievable configuration and per-band verification — never a coefficient
  > 1 or a negative group count;
- coupled resonator targets (e.g. 500 and 1000 Hz pinned together) are met
  simultaneously after the solver accounts for Lorentzian spillover;
- non-positive targets, out-of-range tolerances, unknown bands, missing
  candidate surfaces, malformed templates and bad group caps are all rejected
  with the same structured per-field errors;
- parallel prescriptions keep distinct, retrievable, internally consistent
  records.

A PostgreSQL integration test runs when `TEST_DATABASE_URL` is set:

```bash
TEST_DATABASE_URL=postgres://acoustics:acoustics@localhost:5432/acoustics npm test
```
