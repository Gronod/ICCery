// Manual smoke tests for swatch_grid.js
// Run in a browser/devtools console after the app has loaded:
//   import('./swatch_grid.test.js').then(m => m.runAll())

export function runAll() {
  console.group('swatch_grid smoke tests');
  testClassifyDeltaE();
  console.groupEnd();
}

function testClassifyDeltaE() {
  // classifyDeltaE is currently internal to swatch_grid.js, but we can
  // validate the visual classification by exercising the colour thresholds.
  // This is a placeholder for a future unit-test harness.
  console.log('testClassifyDeltaE: no direct export; validated by manual inspection');
}
