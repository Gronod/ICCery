import { computeQuickHull } from "./vendor/quickhull.js";
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

export function parseGamutFile(text) {
    const lines = text.split('\n');
    const vertices = [];   // [[L, a, b], ...]
    const faces = [];      // [[v0, v1, v2], ...]
    let dataStarted = false;
    let dataBlock = 0;     // 0 = not in data, 1 = vertices, 2 = faces
    let fieldCount = 0;
    
    for (const line of lines) {
        const trimmed = line.trim();
        
        if (trimmed.startsWith('NUMBER_OF_FIELDS')) {
            fieldCount = parseInt(trimmed.split(/\s+/)[1], 10);
        }
        if (trimmed === 'BEGIN_DATA') {
            dataBlock++;
            dataStarted = true;
            continue;
        }
        if (trimmed === 'END_DATA') {
            dataStarted = false;
            continue;
        }
        
        if (dataStarted) {
            const parts = trimmed.split(/\s+/).map(Number);
            if (dataBlock === 1 && parts.length >= 4) {
                // Vertex: VERTEX_NO LAB_L LAB_A LAB_B
                vertices.push([parts[1], parts[2], parts[3]]);  // [L, a, b]
            } else if (dataBlock === 2 && parts.length >= 3) {
                // Face: VERTEX_0 VERTEX_1 VERTEX_2
                faces.push([parts[0], parts[1], parts[2]]);
            }
        }
    }
    
    return { vertices, faces };
}

export function renderGamutFromText(text, color, isWireframe, previousMesh) {
    if (!scene) return null;

    if (previousMesh) {
        scene.remove(previousMesh);
        if (previousMesh.geometry) previousMesh.geometry.dispose();
        if (previousMesh.material) previousMesh.material.dispose();
    }

    const { vertices, faces } = parseGamutFile(text);
    if (vertices.length < 4) return null;

    let geometry = new THREE.BufferGeometry();

    if (faces.length > 0) {
        // We have a pre-triangulated mesh
        const positionArray = new Float32Array(vertices.length * 3);
        for (let i = 0; i < vertices.length; i++) {
            const [L, a, b] = vertices[i];
            positionArray[i * 3]     = a; // x = a*
            positionArray[i * 3 + 1] = L; // y = L*
            positionArray[i * 3 + 2] = b; // z = b*
        }
        
        const indexArray = new Uint32Array(faces.length * 3);
        for (let i = 0; i < faces.length; i++) {
            indexArray[i * 3]     = faces[i][0];
            indexArray[i * 3 + 1] = faces[i][1];
            indexArray[i * 3 + 2] = faces[i][2];
        }

        geometry.setAttribute('position', new THREE.BufferAttribute(positionArray, 3));
        geometry.setIndex(new THREE.BufferAttribute(indexArray, 1));
        geometry.computeVertexNormals();
    } else {
        // Fallback to point cloud hull if no faces are present
        const pts = vertices.map(v => ({ x: v[1], y: v[0], z: v[2] })); // { x: a, y: L, z: b }
        const hullFaces = computeQuickHull(pts);
        if (!hullFaces || hullFaces.length === 0) return null;

        const verticesList = [];
        const indices = [];
        const ptMap = new Map();

        for (const f of hullFaces) {
            for (const p of [f.a, f.b, f.c]) {
                const key = `${p.x}_${p.y}_${p.z}`;
                if (!ptMap.has(key)) {
                    ptMap.set(key, verticesList.length / 3);
                    verticesList.push(p.x, p.y, p.z);
                }
                indices.push(ptMap.get(key));
            }
        }

        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verticesList), 3));
        geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
        geometry.computeVertexNormals();
    }

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
