// Unit tests for calibration helpers (#224).
//   node src/js/calibration.test.js

if (typeof window === 'undefined') {
  globalThis.window = {
    __TAURI__: {
      core: { invoke: () => Promise.resolve() },
      event: { listen: () => Promise.resolve(() => {}) }
    },
    addEventListener: () => {},
    dispatchEvent: () => {},
    devicePixelRatio: 1
  };
  globalThis.document = {
    getElementById: () => null,
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: () => ({
      style: {},
      appendChild() {},
      addEventListener() {},
      textContent: '',
      className: '',
      setAttribute() {}
    })
  };
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {}
  };
}

const {
  makeCalibrationBasename,
  isCalibrationBasename,
  isCalibrationStale,
  totalAreaCoverage,
  classifyCalibrationStatus,
  downsampleCurve,
  buildCurvePolyline,
  getPrinttargCalibrationFields,
  CAL_PREFIX,
} = await import('./calibration.js');

let passed = 0;
let total = 0;

function assert(cond, name) {
  total += 1;
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    console.error(`  FAIL  ${name}`);
  }
}

export function runAll() {
  passed = 0;
  total = 0;
  console.log('calibration.test.js');

  assert(makeCalibrationBasename('photo') === 'CAL_photo', 'prefix profile basename');
  assert(makeCalibrationBasename('CAL_photo') === 'CAL_photo', 'do not double-prefix');
  assert(makeCalibrationBasename('') === 'CAL_printer', 'empty falls back to CAL_printer');
  assert(isCalibrationBasename('CAL_x') === true, 'detects CAL_ prefix');
  assert(isCalibrationBasename('photo') === false, 'profile basename is not cal');
  assert(CAL_PREFIX === 'CAL_', 'prefix constant');

  assert(isCalibrationStale(10, 30) === false, 'fresh cal is not stale');
  assert(isCalibrationStale(30, 30) === false, 'equal to threshold is not stale');
  assert(isCalibrationStale(31, 30) === true, 'older than threshold is stale');

  assert(totalAreaCoverage([]) === 0, 'empty TAC');
  assert(totalAreaCoverage([{ percent: 90 }, { percent: 80 }, { percent: 70 }, { percent: 60 }]) === 300, 'sum TAC');

  assert(classifyCalibrationStatus({}) === 'none', 'no path => none');
  assert(classifyCalibrationStatus({ calPath: '/a.cal', applyEnabled: true, ageDays: 2, staleDays: 30 }) === 'active', 'fresh active');
  assert(classifyCalibrationStatus({ calPath: '/a.cal', ageDays: 40, staleDays: 30 }) === 'stale', 'age stale');
  assert(
    classifyCalibrationStatus({
      calPath: '/a.cal',
      ageDays: 1,
      printerName: 'Epson',
      currentPrinter: 'Canon',
    }) === 'stale',
    'printer mismatch is stale'
  );

  const long = Array.from({ length: 256 }, (_, i) => [i / 255, i / 255]);
  const ds = downsampleCurve(long, 48);
  assert(ds.length === 48, 'downsample length');
  assert(ds[0][0] === 0, 'downsample starts at 0');
  assert(Math.abs(ds[ds.length - 1][0] - 1) < 1e-9, 'downsample ends at 1');

  const poly = buildCurvePolyline([[0, 0], [1, 1]], 100, 100, 10);
  assert(poly.startsWith('M'), 'polyline starts with move');
  assert(poly.includes('L'), 'polyline has line');

  const skipped = getPrinttargCalibrationFields('CAL_photo');
  assert(skipped.calibration_file == null, 'calibration charts do not apply -K to themselves');

  console.log(`\n${passed}/${total} passed`);
  if (passed !== total) process.exitCode = 1;
  return { passed, total };
}

runAll();
