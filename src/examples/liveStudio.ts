import type { CalculationRequest } from '../types';

/**
 * Deliberately "live" recording-studio shell used by the inverse-solver
 * tests: 8.0 m x 6.0 m x 3.5 m, V = 168 m^3.
 *   floor    8.0 x 6.0          = 48 m^2  (sealed concrete)
 *   ceiling  8.0 x 6.0          = 48 m^2  (hard plaster)
 *   walls    2*(8.0+6.0) x 3.5  = 98 m^2  (block + paint)
 * The mid-frequency Sabine T60 is around 2.2 s — a room that clearly needs
 * treatment before it can meet a sub-second studio target.
 */
export const LIVE_STUDIO_EXAMPLE: CalculationRequest = {
  room: {
    name: 'live-studio-shell',
    volume: 168,
    surfaces: [
      {
        name: 'floor (sealed concrete)',
        area: 48,
        coefficients: { 125: 0.02, 250: 0.03, 500: 0.03, 1000: 0.04, 2000: 0.05, 4000: 0.06 },
      },
      {
        name: 'ceiling (hard plaster)',
        area: 48,
        coefficients: { 125: 0.08, 250: 0.06, 500: 0.05, 1000: 0.05, 2000: 0.06, 4000: 0.06 },
      },
      {
        name: 'walls (block + paint)',
        area: 98,
        coefficients: { 125: 0.1, 250: 0.07, 500: 0.05, 1000: 0.05, 2000: 0.06, 4000: 0.07 },
      },
    ],
  },
  resonators: [],
};
