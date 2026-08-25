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
        container.appendChild(renderer.domElement);

        if (typeof THREE.OrbitControls !== 'undefined') {
            controls = new THREE.OrbitControls(camera, renderer.domElement);
            controls.enableDamping = true;
            controls.dampingFactor = 0.05;
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

function parseCGATS(text) {
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

function renderGamutFromText(text, color, isWireframe, previousMesh) {
    if (!scene) return null;

    if (previousMesh) {
        scene.remove(previousMesh);
        if (previousMesh.geometry) previousMesh.geometry.dispose();
        if (previousMesh.material) previousMesh.material.dispose();
    }

    const points = parseCGATS(text);
    if (points.length < 3) return null;

    const coords = [];
    const vertices = new Float32Array(points.length * 3);

    points.forEach((pt, i) => {
        coords.push(pt.a, pt.b);
        vertices[i * 3] = pt.a;     // X = a*
        vertices[i * 3 + 1] = pt.L; // Y = L*
        vertices[i * 3 + 2] = pt.b; // Z = b*
    });

    if (typeof Delaunator === 'undefined') return null;
    const delaunay = new Delaunator(coords);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geometry.setIndex(Array.from(delaunay.triangles));
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
