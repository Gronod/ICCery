const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

let scene, camera, renderer, controls;
let currentProfileMesh = null;
let sRgbMesh = null;

export async function initGamutViewer() {
    try {
        const container = document.getElementById('gamutViewerContainer');
        if (!container || typeof THREE === 'undefined') return;

        // Clear any existing contents if re-initialized
        container.innerHTML = "";

        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x111116);

        const width = container.clientWidth > 0 ? container.clientWidth : 500;
        const height = container.clientHeight > 0 ? container.clientHeight : 360;

        camera = new THREE.PerspectiveCamera(45, width / height, 1, 1000);
        camera.position.set(150, 110, 150);

        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setSize(width, height);
        renderer.setPixelRatio(window.devicePixelRatio || 1);
        renderer.domElement.style.touchAction = 'none';
        container.appendChild(renderer.domElement);

        if (typeof THREE.OrbitControls !== 'undefined') {
            controls = new THREE.OrbitControls(camera, renderer.domElement);
            controls.enableDamping = true;
            controls.dampingFactor = 0.05;
            controls.touches = {
                ONE: THREE.TOUCH.ROTATE,
                TWO: THREE.TOUCH.DOLLY_PAN
            };
        }

        // Add CIELAB orientation helpers (Axes: X=a*, Y=L*, Z=b*)
        const axesHelper = new THREE.AxesHelper(100);
        scene.add(axesHelper);

        // Add grid helper at L*=0 plane
        const gridHelper = new THREE.GridHelper(200, 20, 0x444455, 0x222233);
        gridHelper.position.y = 0;
        scene.add(gridHelper);

        // Lights
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
        scene.add(ambientLight);
        const dirLight1 = new THREE.DirectionalLight(0xffffff, 0.8);
        dirLight1.position.set(100, 200, 100);
        scene.add(dirLight1);
        const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.4);
        dirLight2.position.set(-100, -100, -100);
        scene.add(dirLight2);

        // Handle viewport resize dynamically (e.g., when switching to Stage 5 tab)
        const resizeObserver = new ResizeObserver((entries) => {
            for (let entry of entries) {
                const w = entry.contentRect.width;
                const h = entry.contentRect.height;
                if (w > 0 && h > 0 && renderer && camera) {
                    camera.aspect = w / h;
                    camera.updateProjectionMatrix();
                    renderer.setSize(w, h);
                }
            }
        });
        resizeObserver.observe(container);

        animate();

        // Load bundled sRGB reference gamut wireframe on startup
        loadSrgbReferenceGamut();
    } catch (err) {
        console.warn("Gamut viewer initialization notice:", err);
    }
}

function animate() {
    requestAnimationFrame(animate);
    if (controls) controls.update();
    if (renderer && scene && camera) renderer.render(scene, camera);
}

export function parseCGATS(text) {
    const lines = text.split('\n');
    let dataStarted = false;
    const points = [];

    for (const line of lines) {
        if (line.startsWith('BEGIN_DATA')) {
            dataStarted = true;
            continue;
        }
        if (line.startsWith('END_DATA')) break;

        if (dataStarted) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 4) {
                const L = parseFloat(parts[1]);
                const a = parseFloat(parts[2]);
                const b = parseFloat(parts[3]);
                if (!isNaN(L) && !isNaN(a) && !isNaN(b)) {
                    points.push({ L, a, b });
                }
            }
        }
    }
    return points;
}

/**
 * 3D Convex Hull (QuickHull in 3D) for CIELAB point clouds.
 * Input: points array of { L, a, b }
 * Output: { vertices: Float32Array, indices: Uint32Array } or null
 */
export function compute3DConvexHull(pts) {
    if (!pts || pts.length < 4) return null;

    // Filter duplicate / nearly coincident points
    const points = [];
    const eps = 1e-5;
    for (const p of pts) {
        const x = p.a;     // X = a*
        const y = p.L;     // Y = L*
        const z = p.b;     // Z = b*
        let duplicate = false;
        for (const existing of points) {
            const dx = existing.x - x;
            const dy = existing.y - y;
            const dz = existing.z - z;
            if (dx * dx + dy * dy + dz * dz < eps * eps) {
                duplicate = true;
                break;
            }
        }
        if (!duplicate) {
            points.push({ x, y, z, id: points.length });
        }
    }

    if (points.length < 4) return null;

    // Vector operations helpers
    function sub(v1, v2) { return { x: v1.x - v2.x, y: v1.y - v2.y, z: v1.z - v2.z }; }
    function cross(v1, v2) {
        return {
            x: v1.y * v2.z - v1.z * v2.y,
            y: v1.z * v2.x - v1.x * v2.z,
            z: v1.x * v2.y - v1.y * v2.x
        };
    }
    function dot(v1, v2) { return v1.x * v2.x + v1.y * v2.y + v1.z * v2.z; }
    function lengthSq(v) { return v.x * v.x + v.y * v.y + v.z * v.z; }
    function normalize(v) {
        const len = Math.sqrt(lengthSq(v));
        return len > 0 ? { x: v.x / len, y: v.y / len, z: v.z / len } : { x: 0, y: 0, z: 0 };
    }

    // Step 1: Find extreme points to construct initial simplex (tetrahedron)
    let minX = 0, maxX = 0, minY = 0, maxY = 0, minZ = 0, maxZ = 0;
    for (let i = 1; i < points.length; i++) {
        if (points[i].x < points[minX].x) minX = i;
        if (points[i].x > points[maxX].x) maxX = i;
        if (points[i].y < points[minY].y) minY = i;
        if (points[i].y > points[maxY].y) maxY = i;
        if (points[i].z < points[minZ].z) minZ = i;
        if (points[i].z > points[maxZ].z) maxZ = i;
    }

    let p1 = minX, p2 = maxX;
    let maxDistSq = lengthSq(sub(points[p1], points[p2]));
    const extremes = [minX, maxX, minY, maxY, minZ, maxZ];
    for (let i = 0; i < extremes.length; i++) {
        for (let j = i + 1; j < extremes.length; j++) {
            const d = lengthSq(sub(points[extremes[i]], points[extremes[j]]));
            if (d > maxDistSq) {
                maxDistSq = d;
                p1 = extremes[i];
                p2 = extremes[j];
            }
        }
    }

    // Third point: furthest from line p1-p2
    const v12 = sub(points[p2], points[p1]);
    let p3 = -1;
    let maxLineDistSq = 0;
    for (let i = 0; i < points.length; i++) {
        if (i === p1 || i === p2) continue;
        const v1i = sub(points[i], points[p1]);
        const cr = cross(v12, v1i);
        const distSq = lengthSq(cr) / (lengthSq(v12) || 1);
        if (distSq > maxLineDistSq) {
            maxLineDistSq = distSq;
            p3 = i;
        }
    }
    if (p3 === -1 || maxLineDistSq < eps * eps) return null;

    // Fourth point: furthest from plane p1-p2-p3
    const planeNorm = normalize(cross(sub(points[p2], points[p1]), sub(points[p3], points[p1])));
    let p4 = -1;
    let maxPlaneDist = 0;
    for (let i = 0; i < points.length; i++) {
        if (i === p1 || i === p2 || i === p3) continue;
        const dist = Math.abs(dot(planeNorm, sub(points[i], points[p1])));
        if (dist > maxPlaneDist) {
            maxPlaneDist = dist;
            p4 = i;
        }
    }
    if (p4 === -1 || maxPlaneDist < eps) return null;

    // Helper to create a face with outward-pointing normal
    function makeFace(a, b, c, insidePt) {
        let norm = cross(sub(points[b], points[a]), sub(points[c], points[a]));
        norm = normalize(norm);
        if (dot(norm, sub(points[insidePt], points[a])) > 0) {
            // Invert orientation
            const tmp = b; b = c; c = tmp;
            norm = { x: -norm.x, y: -norm.y, z: -norm.z };
        }
        return {
            a, b, c,
            normal: norm,
            offset: -dot(norm, points[a]),
            points: [],
            active: true
        };
    }

    function distToPlane(face, pt) {
        return dot(face.normal, pt) + face.offset;
    }

    // Initial 4 faces of tetrahedron
    let faces = [
        makeFace(p1, p2, p3, p4),
        makeFace(p1, p4, p2, p3),
        makeFace(p2, p4, p3, p1),
        makeFace(p3, p4, p1, p2)
    ];

    // Assign remaining points to faces
    const unassigned = [];
    for (let i = 0; i < points.length; i++) {
        if (i === p1 || i === p2 || i === p3 || i === p4) continue;
        const pt = points[i];
        let maxDist = 1e-6;
        let bestFace = -1;
        for (let f = 0; f < faces.length; f++) {
            const dist = distToPlane(faces[f], pt);
            if (dist > maxDist) {
                maxDist = dist;
                bestFace = f;
            }
        }
        if (bestFace !== -1) {
            faces[bestFace].points.push(i);
        }
    }

    // QuickHull loop
    while (true) {
        let targetFace = -1;
        for (let f = 0; f < faces.length; f++) {
            if (faces[f].active && faces[f].points.length > 0) {
                targetFace = f;
                break;
            }
        }
        if (targetFace === -1) break;

        const face = faces[targetFace];
        // Pick furthest point
        let furthestPtIdx = face.points[0];
        let maxD = distToPlane(face, points[furthestPtIdx]);
        for (let i = 1; i < face.points.length; i++) {
            const d = distToPlane(face, points[face.points[i]]);
            if (d > maxD) {
                maxD = d;
                furthestPtIdx = face.points[i];
            }
        }
        const eyePt = points[furthestPtIdx];

        // Find all visible faces from eyePt
        const visible = [];
        for (let f = 0; f < faces.length; f++) {
            if (faces[f].active && distToPlane(faces[f], eyePt) > 1e-6) {
                visible.push(f);
            }
        }

        // Find horizon edges (edges of visible faces that are shared with a non-visible face)
        const edgeCount = new Map();
        for (const fIdx of visible) {
            const f = faces[fIdx];
            const edges = [
                [f.a, f.b],
                [f.b, f.c],
                [f.c, f.a]
            ];
            for (const [u, v] of edges) {
                const key = `${Math.min(u, v)}_${Math.max(u, v)}`;
                const current = edgeCount.get(key) || { count: 0, u, v, origU: u, origV: v };
                current.count++;
                edgeCount.set(key, current);
            }
        }

        const horizonEdges = [];
        for (const [key, val] of edgeCount.entries()) {
            if (val.count === 1) {
                // Find orientation from visible face
                horizonEdges.push({ u: val.origU, v: val.origV });
            }
        }

        // Collect all orphaned points from visible faces to reassign
        const orphanPoints = [];
        for (const fIdx of visible) {
            faces[fIdx].active = false;
            for (const pIdx of faces[fIdx].points) {
                if (pIdx !== furthestPtIdx) orphanPoints.push(pIdx);
            }
        }

        // Create new faces from horizon edges to eyePt
        const newFaces = [];
        // Center point of tetrahedron for orientation check
        const centerPt = {
            x: (points[p1].x + points[p2].x + points[p3].x + points[p4].x) / 4,
            y: (points[p1].y + points[p2].y + points[p3].y + points[p4].y) / 4,
            z: (points[p1].z + points[p2].z + points[p3].z + points[p4].z) / 4
        };

        for (const edge of horizonEdges) {
            const newF = makeFace(edge.u, edge.v, furthestPtIdx, centerPt);
            newFaces.push(newF);
        }

        // Distribute orphaned points to new faces
        for (const pIdx of orphanPoints) {
            const pt = points[pIdx];
            let maxDist = 1e-6;
            let bestF = null;
            for (const nF of newFaces) {
                const dist = distToPlane(nF, pt);
                if (dist > maxDist) {
                    maxDist = dist;
                    bestF = nF;
                }
            }
            if (bestF) {
                bestF.points.push(pIdx);
            }
        }

        for (const nF of newFaces) {
            faces.push(nF);
        }
    }

    // Build geometry buffers from active faces
    const activeFaces = faces.filter(f => f.active);
    const indices = [];
    const usedPoints = new Map();
    const verticesList = [];

    for (const f of activeFaces) {
        for (const pIdx of [f.a, f.b, f.c]) {
            if (!usedPoints.has(pIdx)) {
                usedPoints.set(pIdx, verticesList.length / 3);
                verticesList.push(points[pIdx].x, points[pIdx].y, points[pIdx].z);
            }
            indices.push(usedPoints.get(pIdx));
        }
    }

    return {
        vertices: new Float32Array(verticesList),
        indices: new Uint32Array(indices)
    };
}

export function renderGamutFromText(text, color, isWireframe, previousMesh) {
    if (!scene) return null;

    if (previousMesh) {
        scene.remove(previousMesh);
        if (previousMesh.geometry) previousMesh.geometry.dispose();
        if (previousMesh.material) previousMesh.material.dispose();
    }

    const points = parseCGATS(text);
    if (points.length < 4) return null;

    const hull = compute3DConvexHull(points);
    if (!hull) return null;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(hull.vertices, 3));
    geometry.setIndex(Array.from(hull.indices));
    geometry.computeVertexNormals();

    const material = new THREE.MeshLambertMaterial({
        color: color,
        wireframe: isWireframe,
        transparent: true,
        opacity: isWireframe ? 0.35 : 0.75,
        side: THREE.DoubleSide
    });

    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);
    return mesh;
}

export async function loadSrgbReferenceGamut() {
    try {
        const response = await fetch('assets/sRGB.gam');
        if (response.ok) {
            const text = await response.text();
            sRgbMesh = renderGamutFromText(text, 0x94a3b8, true, sRgbMesh);
        }
    } catch (e) {
        console.warn("Could not load sRGB reference gamut:", e);
    }
}

export async function loadGamutMesh(gamFilePath, color = 0x3b82f6, isWireframe = false) {
    try {
        const base64Data = await invoke('read_file_base64', { path: gamFilePath });
        const text = atob(base64Data);
        currentProfileMesh = renderGamutFromText(text, color, isWireframe, currentProfileMesh);
        return currentProfileMesh;
    } catch (e) {
        console.error("Failed to load gamut mesh:", e);
        return null;
    }
}
