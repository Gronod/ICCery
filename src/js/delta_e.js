/**
 * Compute CIEDE2000 colour difference (ΔE₀₀) between two L*a*b* values.
 * Standard parametric factors: kL=1, kC=1, kH=1.
 *
 * Reference: Sharma, Wu, Dalal (2005) "The CIEDE2000 Color-Difference Formula"
 *
 * @param {number[]} lab1 - [L1, a1, b1]
 * @param {number[]} lab2 - [L2, a2, b2]
 * @returns {number} ΔE₀₀ value
 */
export function computeDeltaE00(lab1, lab2) {
  const [L1, a1, b1] = lab1;
  const [L2, a2, b2] = lab2;

  const kL = 1, kC = 1, kH = 1;

  const C1ab = Math.sqrt(a1 * a1 + b1 * b1);
  const C2ab = Math.sqrt(a2 * a2 + b2 * b2);
  const Cab_avg = (C1ab + C2ab) / 2;

  const Cab_avg7 = Math.pow(Cab_avg, 7);
  const G = 0.5 * (1 - Math.sqrt(Cab_avg7 / (Cab_avg7 + Math.pow(25, 7))));

  const a1p = a1 * (1 + G);
  const a2p = a2 * (1 + G);

  const C1p = Math.sqrt(a1p * a1p + b1 * b1);
  const C2p = Math.sqrt(a2p * a2p + b2 * b2);

  let h1p = Math.atan2(b1, a1p) * (180 / Math.PI);
  if (h1p < 0) h1p += 360;
  let h2p = Math.atan2(b2, a2p) * (180 / Math.PI);
  if (h2p < 0) h2p += 360;

  const dLp = L2 - L1;
  const dCp = C2p - C1p;

  let dhp;
  if (C1p * C2p === 0) {
    dhp = 0;
  } else if (Math.abs(h2p - h1p) <= 180) {
    dhp = h2p - h1p;
  } else if (h2p - h1p > 180) {
    dhp = h2p - h1p - 360;
  } else {
    dhp = h2p - h1p + 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * Math.PI / 180) / 2);

  const Lp_avg = (L1 + L2) / 2;
  const Cp_avg = (C1p + C2p) / 2;

  let hp_avg;
  if (C1p * C2p === 0) {
    hp_avg = h1p + h2p;
  } else if (Math.abs(h1p - h2p) <= 180) {
    hp_avg = (h1p + h2p) / 2;
  } else if (h1p + h2p < 360) {
    hp_avg = (h1p + h2p + 360) / 2;
  } else {
    hp_avg = (h1p + h2p - 360) / 2;
  }

  const T = 1
    - 0.17 * Math.cos((hp_avg - 30) * Math.PI / 180)
    + 0.24 * Math.cos(2 * hp_avg * Math.PI / 180)
    + 0.32 * Math.cos((3 * hp_avg + 6) * Math.PI / 180)
    - 0.20 * Math.cos((4 * hp_avg - 63) * Math.PI / 180);

  const SL = 1 + (0.015 * Math.pow(Lp_avg - 50, 2)) / Math.sqrt(20 + Math.pow(Lp_avg - 50, 2));
  const SC = 1 + 0.045 * Cp_avg;
  const SH = 1 + 0.015 * Cp_avg * T;

  const Cp_avg7 = Math.pow(Cp_avg, 7);
  const RT_term = -2 * Math.sqrt(Cp_avg7 / (Cp_avg7 + Math.pow(25, 7)))
    * Math.sin(60 * Math.exp(-Math.pow((hp_avg - 275) / 25, 2)) * Math.PI / 180);

  const dE = Math.sqrt(
    Math.pow(dLp / (kL * SL), 2) +
    Math.pow(dCp / (kC * SC), 2) +
    Math.pow(dHp / (kH * SH), 2) +
    RT_term * (dCp / (kC * SC)) * (dHp / (kH * SH))
  );

  return dE;
}
