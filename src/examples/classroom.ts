import type { CalculationRequest } from '../types';

/**
 * Preset classroom-scale example used by the docs, the /examples endpoint
 * and the test-suite.
 *
 * Geometry: 9.0 m x 7.0 m x 3.2 m classroom, V = 201.6 m^3.
 *   floor   9.0 x 7.0            = 63.0 m^2  (wood floor on concrete)
 *   ceiling 9.0 x 7.0            = 63.0 m^2  (acoustic ceiling tiles)
 *   walls   2*(9.0+7.0) x 3.2    = 102.4 m^2 (painted plaster)
 * Total surface area S = 228.4 m^2.
 *
 * Expected mid-frequency Sabine T60 is in the 0.5-0.7 s range.
 */
export const CLASSROOM_EXAMPLE: CalculationRequest = {
  room: {
    name: 'classroom-example',
    volume: 201.6,
    surfaces: [
      {
        name: 'floor (wood on concrete)',
        area: 63.0,
        coefficients: { 125: 0.15, 250: 0.11, 500: 0.1, 1000: 0.07, 2000: 0.06, 4000: 0.07 },
      },
      {
        name: 'ceiling (acoustic tiles)',
        area: 63.0,
        coefficients: { 125: 0.35, 250: 0.5, 500: 0.65, 1000: 0.75, 2000: 0.8, 4000: 0.75 },
      },
      {
        name: 'walls (painted plaster)',
        area: 102.4,
        coefficients: { 125: 0.14, 250: 0.1, 500: 0.06, 1000: 0.05, 2000: 0.04, 4000: 0.03 },
      },
    ],
  },
  resonators: [],
};

/**
 * Example Helmholtz resonator bank tuned to the 500 Hz octave band:
 * 100 units, each with a 0.002 m^2 neck (about 5 cm diameter), 0.02 m neck
 * length and a 0.38 litre cavity. At the 20 °C reference temperature this
 * gives f0 ~= 500 Hz (L_eff ~= 0.0629 m).
 */
export const CLASSROOM_RESONATOR_EXAMPLE: CalculationRequest = {
  ...CLASSROOM_EXAMPLE,
  resonators: [
    {
      neckArea: 0.002,
      neckLength: 0.02,
      cavityVolume: 0.00038,
      count: 100,
    },
  ],
};
