//   node src/js/profile_install.test.js

if (typeof window === 'undefined') {
  globalThis.window = {
    __TAURI__: {
      core: { invoke: () => Promise.resolve({}) },
      event: { listen: () => Promise.resolve(() => {}) }
    },
    addEventListener: () => {},
    dispatchEvent: () => {}
  };
  globalThis.document = {
    getElementById: () => null,
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: () => ({ style: {}, appendChild() {}, addEventListener() {}, setAttribute() {} })
  };
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
}

const { calibrationInstallNote, setProfileInstallSource } = await import('./profile_install.js');

let passed = 0;
let total = 0;
function assert(cond, name) {
  total += 1;
  if (cond) { passed += 1; console.log(`  ok  ${name}`); }
  else console.error(`  FAIL  ${name}`);
}

export function runAll() {
  passed = 0; total = 0;
  console.log('profile_install.test.js');
  assert(typeof calibrationInstallNote === 'function', 'exports calibrationInstallNote');
  assert(calibrationInstallNote() === null, 'no note when calibration is inactive');
  assert(typeof setProfileInstallSource === 'function', 'exports setProfileInstallSource');
  setProfileInstallSource('/tmp/demo.icc', true);
  setProfileInstallSource(null, false);
  console.log(`\n${passed}/${total} passed`);
  if (passed !== total) process.exitCode = 1;
}

runAll();
