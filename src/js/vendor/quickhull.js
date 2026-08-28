/**
 * quickhull3d - Fast 3D Convex Hull computation
 * MIT License
 */

function visible(face, point) {
  const a = face.a;
  const b = face.b;
  const c = face.c;
  const v0x = b.x - a.x, v0y = b.y - a.y, v0z = b.z - a.z;
  const v1x = c.x - a.x, v1y = c.y - a.y, v1z = c.z - a.z;
  const nx = v0y * v1z - v0z * v1y;
  const ny = v0z * v1x - v0x * v1z;
  const nz = v0x * v1y - v0y * v1x;
  const ppx = point.x - a.x, ppy = point.y - a.y, ppz = point.z - a.z;
  return (nx * ppx + ny * ppy + nz * ppz) > 1e-9;
}

export function computeQuickHull(points) {
  if (!points || points.length < 4) return [];

  // Filter degenerate duplicate points
  const pts = [];
  const eps = 1e-5;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    let dup = false;
    for (let j = 0; j < pts.length; j++) {
      const q = pts[j];
      const dx = p.x - q.x, dy = p.y - q.y, dz = p.z - q.z;
      if (dx * dx + dy * dy + dz * dz < eps * eps) {
        dup = true;
        break;
      }
    }
    if (!dup) pts.push(p);
  }

  if (pts.length < 4) return [];

  // 1. Find initial extreme points
  let minX = 0, maxX = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].x < pts[minX].x) minX = i;
    if (pts[i].x > pts[maxX].x) maxX = i;
  }
  if (minX === maxX) return [];

  // Furthest from line minX-maxX
  let maxD2 = 0, p2 = -1;
  const l0 = pts[minX], l1 = pts[maxX];
  const lx = l1.x - l0.x, ly = l1.y - l0.y, lz = l1.z - l0.z;
  for (let i = 0; i < pts.length; i++) {
    if (i === minX || i === maxX) continue;
    const px = pts[i].x - l0.x, py = pts[i].y - l0.y, pz = pts[i].z - l0.z;
    const cx = ly * pz - lz * py, cy = lz * px - lx * pz, cz = lx * py - ly * px;
    const d2 = cx * cx + cy * cy + cz * cz;
    if (d2 > maxD2) {
      maxD2 = d2;
      p2 = i;
    }
  }
  if (p2 === -1 || maxD2 < 1e-9) return [];

  // Furthest from plane minX-maxX-p2
  const pA = pts[minX], pB = pts[maxX], pC = pts[p2];
  const nx = (pB.y - pA.y) * (pC.z - pA.z) - (pB.z - pA.z) * (pC.y - pA.y);
  const ny = (pB.z - pA.z) * (pC.x - pA.x) - (pB.x - pA.x) * (pC.z - pA.z);
  const nz = (pB.x - pA.x) * (pC.y - pA.y) - (pB.y - pA.y) * (pC.x - pA.x);
  let maxDPlane = 0, p3 = -1;
  for (let i = 0; i < pts.length; i++) {
    if (i === minX || i === maxX || i === p2) continue;
    const d = Math.abs(nx * (pts[i].x - pA.x) + ny * (pts[i].y - pA.y) + nz * (pts[i].z - pA.z));
    if (d > maxDPlane) {
      maxDPlane = d;
      p3 = i;
    }
  }
  if (p3 === -1 || maxDPlane < 1e-9) return [];

  // Build initial tetrahedron with outward-pointing normals
  const p0 = pts[minX], p1 = pts[maxX], pt2 = pts[p2], pt3 = pts[p3];
  const center = {
    x: (p0.x + p1.x + pt2.x + pt3.x) / 4,
    y: (p0.y + p1.y + pt2.y + pt3.y) / 4,
    z: (p0.z + p1.z + pt2.z + pt3.z) / 4,
  };

  function createFace(a, b, c) {
    const fnx = (b.y - a.y) * (c.z - a.z) - (b.z - a.z) * (c.y - a.y);
    const fny = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
    const fnz = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const cpx = center.x - a.x, cpy = center.y - a.y, cpz = center.z - a.z;
    if (fnx * cpx + fny * cpy + fnz * cpz > 0) {
      return { a: a, b: c, c: b, active: true };
    }
    return { a: a, b: b, c: c, active: true };
  }

  let faces = [
    createFace(p0, p1, pt2),
    createFace(p0, pt2, pt3),
    createFace(p0, pt3, p1),
    createFace(p1, pt3, pt2),
  ];

  // Incrementally add remaining points
  for (let i = 0; i < pts.length; i++) {
    if (i === minX || i === maxX || i === p2 || i === p3) continue;
    const pt = pts[i];

    // Find all visible faces
    const vis = [];
    for (let f = 0; f < faces.length; f++) {
      if (faces[f].active && visible(faces[f], pt)) {
        vis.push(f);
      }
    }
    if (vis.length === 0) continue;

    // Find horizon edges
    const edgeMap = new Map();
    for (const fIdx of vis) {
      const f = faces[fIdx];
      const edges = [
        { u: f.a, v: f.b },
        { u: f.b, v: f.c },
        { u: f.c, v: f.a },
      ];
      for (const e of edges) {
        const uId = pts.indexOf(e.u), vId = pts.indexOf(e.v);
        const key = uId < vId ? (uId + '_' + vId) : (vId + '_' + uId);
        const current = edgeMap.get(key) || { count: 0, u: e.u, v: e.v };
        current.count++;
        edgeMap.set(key, current);
      }
      faces[fIdx].active = false;
    }

    // Create new faces from horizon edges to pt
    for (const entry of edgeMap.values()) {
      if (entry.count === 1) {
        const newF = createFace(entry.u, entry.v, pt);
        faces.push(newF);
      }
    }
  }

  return faces.filter(f => f.active);
}
