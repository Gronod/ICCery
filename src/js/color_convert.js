/**
 * Convert CIE L*a*b* to sRGB [0–255] clamped values.
 * Uses D50 illuminant reference white (standard for ICC profiles).
 * @param {number} L - Lightness [0, 100]
 * @param {number} a - Green-red axis [-128, 127]
 * @param {number} b - Blue-yellow axis [-128, 127]
 * @returns {number[]} [r, g, b] each in [0, 255]
 */
export function labToSrgb(L, a, b) {
  // D50 reference white
  const Xn = 0.9642;
  const Yn = 1.0;
  const Zn = 0.8249;

  // Lab → XYZ
  const fy = (L + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;

  const delta = 6 / 29;
  const delta3 = delta * delta * delta;

  const X = Xn * (fx > delta ? fx * fx * fx : (fx - 16 / 116) * 3 * delta * delta);
  const Y = Yn * (fy > delta ? fy * fy * fy : (fy - 16 / 116) * 3 * delta * delta);
  const Z = Zn * (fz > delta ? fz * fz * fz : (fz - 16 / 116) * 3 * delta * delta);

  // XYZ (D50) → linear sRGB via Bradford-adapted D50→D65 matrix
  // Combined D50-adapted XYZ to sRGB matrix
  const lr =  3.1338561 * X - 1.6168667 * Y - 0.4906146 * Z;
  const lg = -0.9787684 * X + 1.9161415 * Y + 0.0334540 * Z;
  const lb =  0.0719453 * X - 0.2289914 * Y + 1.4052427 * Z;

  // Linear sRGB → gamma-corrected sRGB
  function gammaCorrect(c) {
    return c <= 0.0031308
      ? 12.92 * c
      : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  }

  const r = Math.round(Math.max(0, Math.min(255, gammaCorrect(lr) * 255)));
  const g = Math.round(Math.max(0, Math.min(255, gammaCorrect(lg) * 255)));
  const bVal = Math.round(Math.max(0, Math.min(255, gammaCorrect(lb) * 255)));

  return [r, g, bVal];
}

/**
 * Convert device RGB percentages [0–100] to CSS rgb string.
 * @param {number[]} device - [R%, G%, B%] each in [0, 100]
 * @returns {string} CSS rgb() string
 */
export function deviceRgbToCss(device) {
  const r = Math.round((device[0] / 100) * 255);
  const g = Math.round((device[1] / 100) * 255);
  const b = Math.round((device[2] / 100) * 255);
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Convert Lab triplet to CSS rgb string.
 * @param {number[]} lab - [L, a, b]
 * @returns {string} CSS rgb() string
 */
export function labToCss(lab) {
  const [r, g, b] = labToSrgb(lab[0], lab[1], lab[2]);
  return `rgb(${r}, ${g}, ${b})`;
}

export function deviceCmykToCss(device) {
  const c = device[0] / 100, m = device[1] / 100, y = device[2] / 100, k = device[3] / 100;
  const r = Math.round(255 * (1 - c) * (1 - k));
  const g = Math.round(255 * (1 - m) * (1 - k));
  const b = Math.round(255 * (1 - y) * (1 - k));
  return `rgb(${r}, ${g}, ${b})`;
}
