import { computeQuickHull } from "./vendor/quickhull.js";
import { labToSrgb } from "./color_convert.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

let scene, camera, renderer, labelRenderer, controls;
let currentProfileMesh = null;
let sRgbGroup = null;
let axisScaffoldGroup = null;

// ─────────────────────────────────────────────────────────────────────────────
// Public: initialise the gamut viewer
// ─────────────────────────────────────────────────────────────────────────────
export async function initGamutViewer() {
    try {
        const container = document.getElementById('gamutViewerContainer');
        if (!container || typeof THREE === 'undefined') return;

        // Clear any existing contents if re-initialised
        container.innerHTML = "";

        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x0e0e14);

        const width  = container.clientWidth  > 0 ? container.clientWidth  : 500;
        const height = container.clientHeight > 0 ? container.clientHeight : 400;

        // ── WebGL renderer ────────────────────────────────────────────────────
        camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 2000);
        camera.position.set(180, 120, 180);

        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setSize(width, height);
        renderer.setPixelRatio(window.devicePixelRatio || 1);
        renderer.domElement.style.touchAction = 'none';
        renderer.domElement.style.display = 'block';
        container.appendChild(renderer.domElement);

        // ── CSS2D label renderer ──────────────────────────────────────────────
        if (typeof THREE.CSS2DRenderer !== 'undefined') {
            labelRenderer = new THREE.CSS2DRenderer();
            labelRenderer.setSize(width, height);
            labelRenderer.domElement.style.position = 'absolute';
            labelRenderer.domElement.style.top  = '0';
            labelRenderer.domElement.style.left = '0';
            labelRenderer.domElement.style.pointerEvents = 'none';
            container.appendChild(labelRenderer.domElement);
        }

        // ── Orbit controls ────────────────────────────────────────────────────
        if (typeof THREE.OrbitControls !== 'undefined') {
            controls = new THREE.OrbitControls(camera, renderer.domElement);
            controls.enableDamping  = true;
            controls.dampingFactor  = 0.05;
            controls.target.set(0, 50, 0);   // orbit around the centre of L*=50
            controls.update();
            controls.touches = {
                ONE: THREE.TOUCH.ROTATE,
                TWO: THREE.TOUCH.DOLLY_PAN
            };
        }

        // ── Lighting ──────────────────────────────────────────────────────────
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.75);
        scene.add(ambientLight);
        const dirLight1 = new THREE.DirectionalLight(0xffffff, 0.8);
        dirLight1.position.set(150, 250, 150);
        scene.add(dirLight1);
        const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.35);
        dirLight2.position.set(-120, -80, -120);
        scene.add(dirLight2);

        // ── CIELAB axis scaffold + labels ─────────────────────────────────────
        buildAxisScaffold();

        // ── Resize handling ───────────────────────────────────────────────────
        const resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const w = entry.contentRect.width;
                const h = entry.contentRect.height;
                if (w > 0 && h > 0 && renderer && camera) {
                    camera.aspect = w / h;
                    camera.updateProjectionMatrix();
                    renderer.setSize(w, h);
                    if (labelRenderer) labelRenderer.setSize(w, h);
                }
            }
        });
        resizeObserver.observe(container);

        animate();

        // ── Wire toggle controls ──────────────────────────────────────────────
        _wireToggles();

        // ── Load bundled sRGB reference gamut ─────────────────────────────────
        loadSrgbReferenceGamut();

    } catch (err) {
        console.warn("Gamut viewer initialisation notice:", err);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Animation loop
// ─────────────────────────────────────────────────────────────────────────────
function animate() {
    requestAnimationFrame(animate);
    if (controls) controls.update();
    if (renderer && scene && camera) {
        renderer.render(scene, camera);
        if (labelRenderer) labelRenderer.render(scene, camera);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Build custom CIELAB axis scaffold (replaces THREE.AxesHelper)
// CIELAB mapping: X = a* (−128 → +128), Y = L* (0 → 100), Z = b* (−128 → +128)
// ─────────────────────────────────────────────────────────────────────────────
function buildAxisScaffold() {
    axisScaffoldGroup = new THREE.Group();

    const AXIS_MAT_L  = new THREE.LineBasicMaterial({ color: 0xcccccc, transparent: true, opacity: 0.7 });
    const AXIS_MAT_A  = new THREE.LineBasicMaterial({ color: 0x99bbcc, transparent: true, opacity: 0.7 });
    const AXIS_MAT_B  = new THREE.LineBasicMaterial({ color: 0x99bbcc, transparent: true, opacity: 0.7 });
    const TICK_MAT    = new THREE.LineBasicMaterial({ color: 0x556677, transparent: true, opacity: 0.8 });
    const BOX_MAT     = new THREE.LineBasicMaterial({ color: 0x232336, transparent: true, opacity: 0.9 });
    const GRID_MAT    = new THREE.LineBasicMaterial({ color: 0x1e1e2e });

    // ── Bounding box (full CIELAB domain: a*/b* ±128, L* 0→100) ──────────────
    const boxGeo = new THREE.BoxGeometry(256, 100, 256);
    const edgesGeo = new THREE.EdgesGeometry(boxGeo);
    const boxLines = new THREE.LineSegments(edgesGeo, BOX_MAT);
    boxLines.position.set(0, 50, 0);   // centre at a*=0, L*=50, b*=0
    axisScaffoldGroup.add(boxLines);

    // ── Ground plane grid at L*=0 (a*/b* plane) ──────────────────────────────
    const gridHelper = new THREE.GridHelper(256, 16, 0x1e1e2e, 0x1a1a28);
    gridHelper.position.y = 0;
    axisScaffoldGroup.add(gridHelper);

    // ── L* axis line (vertical, Y): 0 → 100 ──────────────────────────────────
    axisScaffoldGroup.add(_line([0, 0, 0], [0, 100, 0], AXIS_MAT_L));

    // ── a* axis line (X): −128 → +128 ────────────────────────────────────────
    axisScaffoldGroup.add(_line([-128, 0, 0], [128, 0, 0], AXIS_MAT_A));

    // ── b* axis line (Z): −128 → +128 ────────────────────────────────────────
    axisScaffoldGroup.add(_line([0, 0, -128], [0, 0, 128], AXIS_MAT_B));

    // ── Tick marks — L* axis (y direction) ───────────────────────────────────
    for (const v of [25, 50, 75, 100]) {
        axisScaffoldGroup.add(_line([-4, v, 0], [4, v, 0], TICK_MAT));
        axisScaffoldGroup.add(_line([0, v, -4], [0, v, 4], TICK_MAT));
    }

    // ── Tick marks — a* axis (x direction) ───────────────────────────────────
    for (const v of [-128, -64, 64, 128]) {
        axisScaffoldGroup.add(_line([v, -3, 0], [v, 3, 0], TICK_MAT));
    }

    // ── Tick marks — b* axis (z direction) ───────────────────────────────────
    for (const v of [-128, -64, 64, 128]) {
        axisScaffoldGroup.add(_line([0, -3, v], [0, 3, v], TICK_MAT));
    }

    scene.add(axisScaffoldGroup);

    // ── CSS2D axis labels ─────────────────────────────────────────────────────
    if (typeof THREE.CSS2DObject !== 'undefined') {
        const labels = [
            // Primary axis name labels
            { text: 'L*',              pos: [0,   110,  0  ], cls: 'gamut-axis-label gamut-axis-primary' },
            { text: '+a* (Red →)',      pos: [140,   0,  0  ], cls: 'gamut-axis-label gamut-axis-a-pos'   },
            { text: '← −a* (Green)',   pos: [-140,  0,  0  ], cls: 'gamut-axis-label gamut-axis-a-neg'   },
            { text: '+b* (Yellow →)',  pos: [0,     0,  140], cls: 'gamut-axis-label gamut-axis-b-pos'   },
            { text: '← −b* (Blue)',    pos: [0,     0, -140], cls: 'gamut-axis-label gamut-axis-b-neg'   },
            // Tick value labels on L* axis
            { text: '25',  pos: [10, 25, 0],  cls: 'gamut-axis-label gamut-tick-label' },
            { text: '50',  pos: [10, 50, 0],  cls: 'gamut-axis-label gamut-tick-label' },
            { text: '75',  pos: [10, 75, 0],  cls: 'gamut-axis-label gamut-tick-label' },
            { text: '100', pos: [10, 100, 0], cls: 'gamut-axis-label gamut-tick-label' },
        ];

        for (const { text, pos, cls } of labels) {
            const div = document.createElement('div');
            div.textContent = text;
            div.className = cls;
            const label = new THREE.CSS2DObject(div);
            label.position.set(...pos);
            axisScaffoldGroup.add(label);
        }
    }
}

// Helper: create a THREE.Line between two points
function _line(from, to, material) {
    const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(...from),
        new THREE.Vector3(...to)
    ]);
    return new THREE.Line(geo, material);
}

// ─────────────────────────────────────────────────────────────────────────────
/**
 * Parse an Argyll `.gam` text file into vertex and face arrays.
 * @param {string} text - Raw contents of the .gam file.
 * @returns {{ vertices: number[][], faces: number[][] }}
 */
// ─────────────────────────────────────────────────────────────────────────────
export function parseGamutFile(text) {
    const lines = text.split('\n');
    const vertices = [];
    const faces    = [];
    let dataStarted = false;
    let dataBlock   = 0;   // 1 = vertices section, 2 = faces section

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === 'BEGIN_DATA') { dataBlock++;  dataStarted = true;  continue; }
        if (trimmed === 'END_DATA')   {               dataStarted = false; continue; }
        if (!dataStarted) continue;

        const parts = trimmed.split(/\s+/).map(Number);
        if (dataBlock === 1 && parts.length >= 4) {
            vertices.push([parts[1], parts[2], parts[3]]);   // [L, a, b]
        } else if (dataBlock === 2 && parts.length >= 3) {
            faces.push([parts[0], parts[1], parts[2]]);
        }
    }

    return { vertices, faces };
}

// ─────────────────────────────────────────────────────────────────────────────
// Build a BufferGeometry from parsed gamut data
// Returns null if insufficient data.
// ─────────────────────────────────────────────────────────────────────────────
function _buildGeometry(vertices, faces) {
    if (vertices.length < 4) return null;

    const geometry = new THREE.BufferGeometry();

    if (faces.length > 0) {
        // Pre-triangulated mesh from .gam file
        const posArr = new Float32Array(vertices.length * 3);
        for (let i = 0; i < vertices.length; i++) {
            const [L, a, b] = vertices[i];
            posArr[i * 3]     = a;  // X = a*
            posArr[i * 3 + 1] = L;  // Y = L*
            posArr[i * 3 + 2] = b;  // Z = b*
        }
        const idxArr = new Uint32Array(faces.length * 3);
        for (let i = 0; i < faces.length; i++) {
            idxArr[i * 3]     = faces[i][0];
            idxArr[i * 3 + 1] = faces[i][1];
            idxArr[i * 3 + 2] = faces[i][2];
        }
        geometry.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
        geometry.setIndex(new THREE.BufferAttribute(idxArr, 1));
        geometry.computeVertexNormals();
    } else {
        // Fallback: convex hull from point cloud
        const pts = vertices.map(v => ({ x: v[1], y: v[0], z: v[2] }));
        const hullFaces = computeQuickHull(pts);
        if (!hullFaces || hullFaces.length === 0) return null;

        const vList = [];
        const idxList = [];
        const ptMap = new Map();
        for (const f of hullFaces) {
            for (const p of [f.a, f.b, f.c]) {
                const key = `${p.x}_${p.y}_${p.z}`;
                if (!ptMap.has(key)) { ptMap.set(key, vList.length / 3); vList.push(p.x, p.y, p.z); }
                idxList.push(ptMap.get(key));
            }
        }
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vList), 3));
        geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(idxList), 1));
        geometry.computeVertexNormals();

        // Re-extract vertices for colour calculation below
        const posAttr = geometry.getAttribute('position');
        vertices = [];
        for (let i = 0; i < posAttr.count; i++) {
            // Note: stored as (a, L, b) — convert back to [L, a, b]
            vertices.push([posAttr.getY(i), posAttr.getX(i), posAttr.getZ(i)]);
        }
    }

    return { geometry, vertices };
}

// ─────────────────────────────────────────────────────────────────────────────
// Render sRGB reference gamut as EdgesGeometry outline + faint solid fill
// Returned as a THREE.Group stored in sRgbGroup
// ─────────────────────────────────────────────────────────────────────────────
function _renderSrgbReference(text, previousGroup) {
    if (!scene) return null;

    if (previousGroup) {
        scene.remove(previousGroup);
        previousGroup.traverse(child => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
        });
    }

    const { vertices, faces } = parseGamutFile(text);
    const built = _buildGeometry(vertices, faces);
    if (!built) return null;

    const { geometry } = built;
    const group = new THREE.Group();

    // ── 1. Faint transparent solid fill ──────────────────────────────────────
    const solidMat = new THREE.MeshLambertMaterial({
        color: 0x8899bb,
        transparent: true,
        opacity: 0.07,
        side: THREE.DoubleSide,
        depthWrite: false
    });
    group.add(new THREE.Mesh(geometry, solidMat));

    // ── 2. Clean structural outline via EdgesGeometry (15° threshold) ─────────
    // This removes all co-planar internal triangle edges, leaving only the
    // structural contours of the gamut surface hull.
    const edgesGeo = new THREE.EdgesGeometry(geometry, 15);
    const edgesMat = new THREE.LineBasicMaterial({
        color: 0x6688aa,
        transparent: true,
        opacity: 0.55
    });
    group.add(new THREE.LineSegments(edgesGeo, edgesMat));

    scene.add(group);
    return group;
}

// ─────────────────────────────────────────────────────────────────────────────
// Render profile gamut with per-vertex true Lab→sRGB colour
// ─────────────────────────────────────────────────────────────────────────────
function _renderProfileGamut(text, previousMesh) {
    if (!scene) return null;

    if (previousMesh) {
        scene.remove(previousMesh);
        if (previousMesh.geometry) previousMesh.geometry.dispose();
        if (previousMesh.material) previousMesh.material.dispose();
    }

    const { vertices, faces } = parseGamutFile(text);
    const built = _buildGeometry(vertices, faces);
    if (!built) return null;

    const { geometry } = built;
    let verts = built.vertices;

    // ── Per-vertex colour: Lab → sRGB ─────────────────────────────────────────
    // geometry 'position' is laid out as [a, L, b] per vertex
    const posAttr = geometry.getAttribute('position');
    const colorArr = new Float32Array(posAttr.count * 3);
    for (let i = 0; i < posAttr.count; i++) {
        const a_star = posAttr.getX(i);
        const L_star = posAttr.getY(i);
        const b_star = posAttr.getZ(i);
        const [r, g, b] = labToSrgb(L_star, a_star, b_star);
        colorArr[i * 3]     = r / 255;
        colorArr[i * 3 + 1] = g / 255;
        colorArr[i * 3 + 2] = b / 255;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colorArr, 3));

    const material = new THREE.MeshLambertMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.88,
        side: THREE.DoubleSide
    });

    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);
    return mesh;
}

// ─────────────────────────────────────────────────────────────────────────────
// Camera & view controls
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Reset the camera to its default home position and orientation.
 * Also resets orbit controls target to the centre of the CIELAB volume.
 */
export function resetCamera() {
    if (!camera || !controls) return;
    camera.position.set(180, 120, 180);
    camera.lookAt(0, 50, 0);
    controls.target.set(0, 50, 0);
    controls.update();
}

/**
 * Set the opacity of the rendered profile gamut surface (0–1).
 * @param {number} opacity
 */
export function setProfileOpacity(opacity) {
    if (currentProfileMesh && currentProfileMesh.material) {
        currentProfileMesh.material.opacity = Math.max(0, Math.min(1, opacity));
        currentProfileMesh.material.transparent = opacity < 1;
        currentProfileMesh.material.needsUpdate = true;
    }
}

/**
 * Set the opacity of the sRGB reference wireframe and fill (0–1).
 * @param {number} opacity
 */
export function setSrgbReferenceOpacity(opacity) {
    if (sRgbGroup) {
        sRgbGroup.traverse((child) => {
            if (child.material) {
                child.material.opacity = child.material.opacity >= 0.5
                    ? Math.max(0.05, Math.min(1, opacity))
                    : Math.max(0.02, Math.min(0.2, opacity * 0.2));
            }
        });
    }
}

/**
 * Set the opacity of the CIELAB axis scaffold (0–1).
 * @param {number} opacity
 */
export function setAxisOpacity(opacity) {
    if (axisScaffoldGroup) {
        axisScaffoldGroup.traverse((child) => {
            if (child.material) {
                child.material.opacity = Math.max(0, Math.min(1, opacity));
            }
        });
    }
}

/**
 * Handle keyboard shortcuts for the gamut viewer.
 * @param {KeyboardEvent} e
 */
function _onKeyDown(e) {
    if (e.key === 'r' || e.key === 'R') {
        resetCamera();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
/**
 * Load and render the bundled sRGB reference gamut.
 * @returns {Promise<void>}
 */
// ─────────────────────────────────────────────────────────────────────────────
export async function loadSrgbReferenceGamut() {
    try {
        const response = await fetch('assets/sRGB.gam');
        if (response.ok) {
            const text = await response.text();
            sRgbGroup = _renderSrgbReference(text, sRgbGroup);
        }
    } catch (e) {
        console.warn("Could not load sRGB reference gamut:", e);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
/**
 * Load and render a profile gamut from a `.gam` file path.
 * @param {string} gamFilePath - Absolute path to the gamut file.
 * @returns {Promise<THREE.Mesh|null>}
 */
// ─────────────────────────────────────────────────────────────────────────────
export async function loadGamutMesh(gamFilePath) {
    try {
        const base64Data = await invoke('read_file_base64', { path: gamFilePath });
        const text = atob(base64Data);
        currentProfileMesh = _renderProfileGamut(text, currentProfileMesh);
        return currentProfileMesh;
    } catch (e) {
        console.error("Failed to load gamut mesh:", e);
        return null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Toggle functions (exported for external use; also wired internally)
// ─────────────────────────────────────────────────────────────────────────────
export function toggleSrgbReference(visible) {
    if (sRgbGroup) sRgbGroup.visible = visible;
}

export function toggleProfileGamut(visible) {
    if (currentProfileMesh) currentProfileMesh.visible = visible;
}

export function toggleAxes(visible) {
    if (axisScaffoldGroup) axisScaffoldGroup.visible = visible;
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire legend toggle checkboxes, opacity sliders, and reset button
// ─────────────────────────────────────────────────────────────────────────────
function _wireToggles() {
    const bindings = [
        ['chkProfileGamut',   toggleProfileGamut  ],
        ['chkSrgbReference',  toggleSrgbReference ],
        ['chkLabAxes',        toggleAxes          ],
    ];
    for (const [id, fn] of bindings) {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', (e) => fn(e.target.checked));
    }

    const resetBtn = document.getElementById('btnGamutResetCamera');
    if (resetBtn) resetBtn.addEventListener('click', resetCamera);

    const profileOpacity = document.getElementById('rngProfileOpacity');
    if (profileOpacity) {
        profileOpacity.addEventListener('input', (e) => setProfileOpacity(parseFloat(e.target.value)));
    }

    const srgbOpacity = document.getElementById('rngSrgbOpacity');
    if (srgbOpacity) {
        srgbOpacity.addEventListener('input', (e) => setSrgbReferenceOpacity(parseFloat(e.target.value)));
    }

    const axisOpacity = document.getElementById('rngAxisOpacity');
    if (axisOpacity) {
        axisOpacity.addEventListener('input', (e) => setAxisOpacity(parseFloat(e.target.value)));
    }

    // Only listen for 'R' reset when the viewer tab is active.
    const stage5 = document.getElementById('stage-5');
    if (stage5) {
        stage5.addEventListener('keydown', (e) => {
            if ((e.key === 'r' || e.key === 'R') && !stage5.classList.contains('hidden')) {
                resetCamera();
            }
        });
    }
}
