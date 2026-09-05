// Unit & console tests for profcheck.js parsing and breach alert logic.
// Can be run in browser devtools console:
//   import('./profcheck.test.js').then(m => m.runAll())
// Or in Node:
//   node src/js/profcheck.test.js

// Node environment polyfill for browser globals
if (typeof window === 'undefined') {
  globalThis.window = {
    __TAURI__: {
      core: { invoke: () => Promise.resolve() },
      event: { listen: () => Promise.resolve(() => {}) }
    },
    addEventListener: () => {},
    dispatchEvent: () => {}
  };
  globalThis.document = {
    getElementById: () => null,
    querySelectorAll: () => []
  };
}

const { parseProfcheckReport, checkBreachAlert } = await import('./profcheck.js');

export function runAll() {
  console.group('Profcheck Report Parser & Drift Tests');
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

  // 1. Real Argyll -u JSON payload
  const realUOutput = `
profcheck: Checking profile accuracy...
No of test patches = 52
{"event": "report", "peak_de2000": 2.41, "avg_de2000": 0.85, "rms": 1.02}
Profile check complete, errors(CIEDE2000): max. = 2.41, avg. = 0.85, RMS = 1.02
`;
  const res1 = parseProfcheckReport(realUOutput);
  assert(res1.avgDe, 0.85, 'real -u JSON avgDe');
  assert(res1.maxDe, 2.41, 'real -u JSON maxDe');
  assert(res1.rmsDe, 1.02, 'real -u JSON rmsDe');
  assert(res1.patchCount, 52, 'real -u patchCount');
  assert(res1.warnings.length, 0, 'real -u no warnings');

  // 2. Preference for *de2000 object when multiple JSON objects appear
  const multiJsonOutput = `
{"event": "report", "peak_de": 3.10, "avg_de": 1.20, "rms": 1.50}
{"event": "report", "peak_de2000": 2.15, "avg_de2000": 0.72, "rms": 0.95}
`;
  const res2 = parseProfcheckReport(multiJsonOutput);
  assert(res2.avgDe, 0.72, 'prefers *de2000 avg');
  assert(res2.maxDe, 2.15, 'prefers *de2000 peak');
  assert(res2.rmsDe, 0.95, 'prefers *de2000 rms');

  // 3. Standard text summary line without JSON
  const textSummaryOutput = `
Header information...
No of test patches = 120
Profile check complete, errors(CIEDE2000): max. = 1.95, avg. = 0.65, RMS = 0.88
Done.
`;
  const res3 = parseProfcheckReport(textSummaryOutput);
  assert(res3.avgDe, 0.65, 'text summary line avgDe');
  assert(res3.maxDe, 1.95, 'text summary line maxDe');
  assert(res3.rmsDe, 0.88, 'text summary line rmsDe');
  assert(res3.patchCount, 120, 'text summary patchCount');

  // 4. Legacy regex fallbacks
  const legacyOutput = `
Summary:
  avg. dE = 1.15
  max. dE = 3.42
  rms. dE = 1.65
`;
  const res4 = parseProfcheckReport(legacyOutput);
  assert(res4.avgDe, 1.15, 'legacy text avgDe');
  assert(res4.maxDe, 3.42, 'legacy text maxDe');
  assert(res4.rmsDe, 1.65, 'legacy text rmsDe');

  // 5. checkBreachAlert tests
  assert(checkBreachAlert([]), null, 'empty records returns null');
  assert(checkBreachAlert([{ avg_de: 4.0, timestamp: '2026-09-01T10:00:00Z' }]), null, 'single record returns null');

  // Two records in same minute >= 3.5 -> no alert
  const sameTimeRecords = [
    { avg_de: 3.8, timestamp: '2026-09-05T12:00:10Z' },
    { avg_de: 3.9, timestamp: '2026-09-05T12:00:45Z' },
  ];
  assert(checkBreachAlert(sameTimeRecords), null, 'two records in same minute do not fire alert');

  // Two records on distinct calendar dates >= 3.5 -> alert fires
  const distinctDateRecords = [
    { avg_de: 1.0, timestamp: '2026-08-15T10:00:00Z' },
    { avg_de: 3.6, timestamp: '2026-09-01T10:00:00Z' },
    { avg_de: 3.8, timestamp: '2026-09-05T10:00:00Z' },
  ];
  const alert = checkBreachAlert(distinctDateRecords);
  assert(typeof alert === 'string' && alert.includes('Re-profiling Recommended') && alert.includes('2 consecutive'), true, 'distinct dates breach alert fires');

  // Two records >= 1 hour apart on same day -> alert fires
  const hourApartRecords = [
    { avg_de: 3.7, timestamp: '2026-09-05T10:00:00Z' },
    { avg_de: 3.9, timestamp: '2026-09-05T12:30:00Z' },
  ];
  const alert2 = checkBreachAlert(hourApartRecords);
  assert(typeof alert2 === 'string' && alert2.includes('Re-profiling Recommended'), true, 'records >=1 hr apart breach alert fires');

  // Trailing record is good -> no alert
  const recoveredRecords = [
    { avg_de: 3.7, timestamp: '2026-09-01T10:00:00Z' },
    { avg_de: 3.9, timestamp: '2026-09-02T10:00:00Z' },
    { avg_de: 0.9, timestamp: '2026-09-03T10:00:00Z' },
  ];
  assert(checkBreachAlert(recoveredRecords), null, 'recovered profile returns null');

  console.log(`Profcheck tests complete: ${passed}/${total} passed`);
  console.groupEnd();
  return passed === total;
}

// Auto-run if executed directly in Node
if (typeof process !== 'undefined' && process.argv && process.argv[1] && process.argv[1].endsWith('profcheck.test.js')) {
  const ok = runAll();
  if (!ok) process.exit(1);
}
