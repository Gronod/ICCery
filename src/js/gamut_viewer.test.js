// Unit & console tests for gamut_viewer.js parsing.
// Can be run in browser devtools console:
//   import('./gamut_viewer.test.js').then(m => m.runAll())
// Or in Node:
//   node src/js/gamut_viewer.test.js

// Node environment polyfill for browser globals
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
    createElement: (tag) => {
      if (tag === 'canvas') {
        return { getContext: () => null };
      }
      return {
        style: {},
        appendChild() {},
        addEventListener() {},
        textContent: '',
        className: '',
        setAttribute() {}
      };
    }
  };
}

const {
  parseGamutFile,
  webglAvailable,
  isLikelyConstrainedGpu,
  ensureGamutViewer,
  isGamutViewerReady,
  WEBGL_UNAVAILABLE_MESSAGE,
  setGpuHints,
} = await import('./gamut_viewer.js');

let passed = 0;
let total = 0;

export function runAll() {
  console.group('Gamut Viewer Parser Tests');
  passed = 0;
  total = 0;
  testParseGamutBasic();
  testParseGamutDualTable();
  testParseGamutWithComments();
  testWebglAvailableFalseWithoutContext();
  testWebglAvailableTrueWithWebgl();
  testConstrainedGpuPrefersBackendArch();
  testConstrainedGpuIgnoresAppleSiliconUa();
  testConstrainedGpuIntelMac();
  testEnsureGamutViewerNoopsWithoutDom();
  testFallbackMessage();
  console.log(`\nResults: ${passed} / ${total} tests passed.`);
  console.groupEnd();

  if (passed !== total) {
    throw new Error(`Gamut viewer parser tests failed: ${total - passed} failure(s)`);
  }
}

function assertEqual(actual, expected, message) {
  total++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log('PASS:', message);
  } else {
    console.error('FAIL:', message, 'expected', expected, 'got', actual);
  }
  return ok;
}

function assert(ok, message) {
  total++;
  if (ok) {
    passed++;
    console.log('PASS:', message);
  } else {
    console.error('FAIL:', message);
  }
  return ok;
}

function testParseGamutBasic() {
  const text = `GAMUT file
BEGIN_DATA
0 50 0 0
1 100 0 0
2 0 -128 0
3 0 0 128
END_DATA
BEGIN_DATA
0 1 2
1 2 3
END_DATA`;
  const { vertices, faces, warnings } = parseGamutFile(text);
  assertEqual(vertices.length, 4, 'basic gamut vertex count');
  assertEqual(faces.length, 2, 'basic gamut face count');
  assertEqual(warnings.length, 0, 'basic gamut no warnings');
}

function testParseGamutDualTable() {
  const text = `GAMUT file
BEGIN_DATA
0 50 0 0
1 100 0 0
2 0 -128 0
3 0 0 128
END_DATA
BEGIN_DATA
0 1 2
END_DATA
BEGIN_DATA
1 2 3
END_DATA`;
  const { vertices, faces, warnings } = parseGamutFile(text);
  assertEqual(vertices.length, 4, 'dual-table gamut vertex count');
  assertEqual(faces.length, 2, 'dual-table gamut face count');
  assertEqual(warnings.length, 0, 'dual-table gamut no warnings');
}

function testParseGamutWithComments() {
  const text = `GAMUT file
# this is a comment
BEGIN_DATA
0 50 0 0
1 100 0 0
# inline comment
2 0 -128 0
3 0 0 128
END_DATA
BEGIN_DATA
0 1 2
1 2 3
END_DATA`;
  const { vertices, faces, warnings } = parseGamutFile(text);
  assertEqual(vertices.length, 4, 'commented gamut vertex count');
  assertEqual(faces.length, 2, 'commented gamut face count');
}

function testWebglAvailableFalseWithoutContext() {
  const doc = {
    createElement: () => ({ getContext: () => null })
  };
  assertEqual(webglAvailable(doc), false, 'webglAvailable is false when no context');
  assertEqual(webglAvailable(null), false, 'webglAvailable is false without document');
}

function testWebglAvailableTrueWithWebgl() {
  const doc = {
    createElement: () => ({
      getContext: (type) => (type === 'webgl' ? {} : null)
    })
  };
  assertEqual(webglAvailable(doc), true, 'webglAvailable is true with webgl context');
}

function testConstrainedGpuPrefersBackendArch() {
  setGpuHints({});
  assertEqual(
    isLikelyConstrainedGpu({ arch: 'aarch64', navigator: { platform: 'MacIntel', userAgent: 'Macintosh; Intel Mac OS X 12_7' } }),
    false,
    'Apple Silicon arch is not constrained even if platform is MacIntel'
  );
  assertEqual(
    isLikelyConstrainedGpu({ arch: 'x86_64', navigator: { platform: 'MacIntel' } }),
    true,
    'x86_64 arch is constrained'
  );
}

function testConstrainedGpuIgnoresAppleSiliconUa() {
  setGpuHints({});
  assertEqual(
    isLikelyConstrainedGpu({
      navigator: { platform: 'MacIntel', userAgent: 'Macintosh; ARM Mac OS X 14_0 Apple Silicon' }
    }),
    false,
    'ARM / Apple Silicon UA is not constrained'
  );
}

function testConstrainedGpuIntelMac() {
  setGpuHints({});
  assertEqual(
    isLikelyConstrainedGpu({
      macosMajor: 12,
      navigator: { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 12_7_6)' }
    }),
    true,
    'Monterey Intel UA is constrained'
  );
  assertEqual(
    isLikelyConstrainedGpu({
      arch: 'x86_64',
      macosMajor: 14,
      navigator: { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)' }
    }),
    true,
    'Intel arch stays constrained on Ventura+'
  );
}

function testEnsureGamutViewerNoopsWithoutDom() {
  ensureGamutViewer();
  assertEqual(isGamutViewerReady(), false, 'ensureGamutViewer does not create a renderer without Stage 5 DOM / THREE');
}

function testFallbackMessage() {
  assert(
    WEBGL_UNAVAILABLE_MESSAGE.includes('requires WebGL'),
    'fallback copy mentions WebGL'
  );
}

// Auto-run if executed in Node.js
if (typeof process !== 'undefined' && process.argv && process.argv[1]?.endsWith('gamut_viewer.test.js')) {
  runAll();
}