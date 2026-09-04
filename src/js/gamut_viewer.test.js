// Manual / browser-console tests for gamut_viewer.js and profcheck.js parsing.
// Run in a browser/devtools console after the app has loaded:
//   import('./gamut_viewer.test.js').then(m => m.runAll())

import { parseGamutFile } from './gamut_viewer.js';

export function runAll() {
  console.group('gamut/profcheck parser tests');
  testParseGamutBasic();
  testParseGamutDualTable();
  testParseGamutWithComments();
  console.groupEnd();
}

function assertEqual(actual, expected, message) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log('PASS:', message);
  } else {
    console.error('FAIL:', message, 'expected', expected, 'got', actual);
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
