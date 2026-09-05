// Unit & console tests for chartread.js stdout classifier and state machine transitions.
// Can be run in browser devtools console:
//   import('./chartread.test.js').then(m => m.runAll())
// Or in Node:
//   node src/js/chartread.test.js

// Node environment polyfill for browser globals
if (typeof window === 'undefined') {
  globalThis.window = {
    __TAURI__: {
      core: { invoke: () => Promise.resolve() },
      event: {
        listen: () => Promise.resolve(() => {}),
        emit: () => Promise.resolve(),
      },
    },
    addEventListener: () => {},
    dispatchEvent: () => {},
  };
  globalThis.document = {
    getElementById: () => null,
    querySelectorAll: () => [],
    createElement: () => ({
      classList: { add: () => {}, remove: () => {} },
      style: {},
      appendChild: () => {},
    }),
  };
}

const { STATE, classifyChartreadLine } = await import('./chartread.js');

export function runAll() {
  console.group('Chartread Classifier & XY Table Tests');
  let passed = 0;
  let total = 0;

  function assert(actual, expected, message) {
    total++;
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) {
      console.log('PASS:', message);
      passed++;
    } else {
      console.error('FAIL:', message, '\nExpected:', expected, '\nGot:', actual);
    }
    return ok;
  }

  // 1. XY Sheet Placement prompts
  const place1 = classifyChartreadLine("Please place sheet 1 of 1 on the table", STATE.CALIBRATING);
  assert(place1.state, STATE.TABLE_PLACE_SHEET, 'sheet 1 of 1 state TABLE_PLACE_SHEET');
  assert(place1.matched, true, 'sheet 1 of 1 matched');
  assert(place1.meta?.sheet, 1, 'sheet 1 of 1 sheet number 1');
  assert(place1.meta?.totalSheets, 1, 'sheet 1 of 1 total sheets 1');

  const place2 = classifyChartreadLine("Please remove previous sheet and place sheet 2 of 2 on the table", STATE.READING);
  assert(place2.state, STATE.TABLE_PLACE_SHEET, 'sheet 2 of 2 state TABLE_PLACE_SHEET');
  assert(place2.meta?.sheet, 2, 'sheet 2 of 2 sheet number 2');
  assert(place2.meta?.totalSheets, 2, 'sheet 2 of 2 total sheets 2');

  const placeGeneric = classifyChartreadLine("place sheet on table", STATE.IDLE);
  assert(placeGeneric.state, STATE.TABLE_PLACE_SHEET, 'generic place sheet state TABLE_PLACE_SHEET');

  // 2. XY Fiducial patch alignment prompts
  const fid1 = classifyChartreadLine("locate patch A1 with the sight,", STATE.TABLE_PLACE_SHEET);
  assert(fid1.state, STATE.TABLE_ALIGN, 'locate patch A1 state TABLE_ALIGN');
  assert(fid1.matched, true, 'locate patch A1 matched');
  assert(fid1.meta?.patch, "A1", 'locate patch A1 meta patch');

  const fid2 = classifyChartreadLine("locate patch B24 with the sight", STATE.TABLE_ALIGN);
  assert(fid2.state, STATE.TABLE_ALIGN, 'locate patch B24 state TABLE_ALIGN');
  assert(fid2.meta?.patch, "B24", 'locate patch B24 meta patch');

  const fid3 = classifyChartreadLine("locate patch 1 with sight", STATE.TABLE_ALIGN);
  assert(fid3.state, STATE.TABLE_ALIGN, 'locate patch 1 state TABLE_ALIGN');
  assert(fid3.meta?.patch, "1", 'locate patch 1 meta patch');

  // 3. Two-line prompt sticky transitions
  // A continuation line arriving while in TABLE_PLACE_SHEET must remain in TABLE_PLACE_SHEET
  const contSheet1 = classifyChartreadLine("hit return to continue, Esc or 'q' to give up", STATE.TABLE_PLACE_SHEET);
  assert(contSheet1.state, STATE.TABLE_PLACE_SHEET, 'sheet continuation remains in TABLE_PLACE_SHEET');
  assert(contSheet1.meta?.isContinuation, true, 'sheet continuation flag set');

  const contSheet2 = classifyChartreadLine("then hit return to continue", STATE.TABLE_PLACE_SHEET);
  assert(contSheet2.state, STATE.TABLE_PLACE_SHEET, 'then hit return remains in TABLE_PLACE_SHEET');

  // A continuation line arriving while in TABLE_ALIGN must remain in TABLE_ALIGN
  const contAlign1 = classifyChartreadLine("then hit return to continue", STATE.TABLE_ALIGN);
  assert(contAlign1.state, STATE.TABLE_ALIGN, 'align continuation remains in TABLE_ALIGN');
  assert(contAlign1.meta?.isContinuation, true, 'align continuation flag set');

  const contAlign2 = classifyChartreadLine("hit return to continue, Esc or 'q' to give up", STATE.TABLE_ALIGN);
  assert(contAlign2.state, STATE.TABLE_ALIGN, 'align esc/q continuation remains in TABLE_ALIGN');

  // Continuation prompt in strip mode becomes generic PROMPT_CONTINUE
  const contStrip = classifyChartreadLine("hit return to continue", STATE.READING);
  assert(contStrip.state, STATE.PROMPT_CONTINUE, 'strip continue transitions to PROMPT_CONTINUE');

  // 4. Final sheet removal notice (Info-only, does not change state or trigger stdin prompt)
  const removeSheet = classifyChartreadLine("Please remove last sheet from table", STATE.READING);
  assert(removeSheet.state, STATE.READING, 'remove last sheet notice preserves currentState');
  assert(removeSheet.matched, true, 'remove last sheet notice is matched');
  assert(removeSheet.meta?.isRemoveSheetNotice, true, 'remove last sheet notice flag set');

  // 5. Sheet read OK notices
  const sheetOk = classifyChartreadLine("Sheet 1 of 1 read OK", STATE.READING);
  assert(sheetOk.matched, true, 'sheet read OK matched');
  assert(sheetOk.meta?.sheetOk, true, 'sheet read OK flag');
  assert(sheetOk.meta?.sheet, 1, 'sheet read OK sheet 1');
  assert(sheetOk.meta?.totalSheets, 1, 'sheet read OK totalSheets 1');

  // 6. Strip mode regressions
  const calib = classifyChartreadLine("Place instrument on calibration tile and hit [Space] to calibrate.", STATE.IDLE);
  assert(calib.state, STATE.CALIBRATING, 'strip calibration prompt transitions to CALIBRATING');

  const awaitStrip = classifyChartreadLine("Hit [Space] to read strip A (or 's' to skip).", STATE.CALIBRATING);
  assert(awaitStrip.state, STATE.AWAITING_STRIP, 'strip prompt transitions to AWAITING_STRIP');

  const readingStrip = classifyChartreadLine("Reading strip A...", STATE.AWAITING_STRIP);
  assert(readingStrip.state, STATE.READING, 'reading strip transitions to READING');

  const readingSheet = classifyChartreadLine("Reading sheet 1...", STATE.TABLE_ALIGN);
  assert(readingSheet.state, STATE.READING, 'reading sheet transitions to READING');

  const warning = classifyChartreadLine("Warning: unexpected response from instrument", STATE.READING);
  assert(warning.state, STATE.WARNING, 'unexpected response transitions to WARNING');

  const warnAnyway = classifyChartreadLine("Hit return to use it anyway", STATE.WARNING);
  assert(warnAnyway.state, STATE.WARNING, 'use it anyway stays in WARNING');

  const allStripsDone = classifyChartreadLine("All strips read. Hit 'd' when done", STATE.READING);
  assert(allStripsDone.state, STATE.ALL_STRIPS_READ, 'all strips read transitions to ALL_STRIPS_READ');

  const err = classifyChartreadLine("Fatal error: instrument communication failed", STATE.READING);
  assert(err.state, STATE.ERROR, 'instrument communication failed transitions to ERROR');

  const unrecognized = classifyChartreadLine("some debug log output [1234]", STATE.READING);
  assert(unrecognized.state, STATE.READING, 'unrecognized line preserves currentState');
  assert(unrecognized.matched, false, 'unrecognized line matched is false');

  console.log(`\nResults: ${passed} / ${total} tests passed.`);
  console.groupEnd();

  if (passed !== total) {
    throw new Error(`Chartread tests failed: ${total - passed} failure(s)`);
  }
}

// Auto-run if executed in Node.js
if (typeof process !== 'undefined' && process.argv && process.argv[1]?.endsWith('chartread.test.js')) {
  runAll();
}
