const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { readTextFile } = window.__TAURI__.fs;

let scene, camera, renderer, controls;
let currentProfileMesh, sRgbMesh;

export async function initGamutViewer() {
    const container = document.getElementById('gamutViewerContainer');
    if (!container) return;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a24);

    camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 1, 1000);
    camera.position.set(150, 100, 150);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    // Add CIELAB orientation helpers (Axes: X=a*, Y=L*, Z=b*)
    const axesHelper = new THREE.AxesHelper(80);
    scene.add(axesHelper);

    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(100, 200, 100);
    scene.add(dirLight);

    animate();
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

export async function loadGamutMesh(gamFilePath, color = 0x3b82f6, isWireframe = false) {
    try {
        const text = await readTextFile(gamFilePath);
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

        // Use Delaunator for 2D triangulation on a*, b* plane
        const delaunay = new Delaunator(coords);

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
        geometry.setIndex(Array.from(delaunay.triangles));
        geometry.computeVertexNormals();

        const material = new THREE.MeshLambertMaterial({
            color: color,
            wireframe: isWireframe,
            transparent: true,
            opacity: isWireframe ? 0.4 : 0.75,
            side: THREE.DoubleSide
        });

        const mesh = new THREE.Mesh(geometry, material);
        scene.add(mesh);
        return mesh;
    } catch (e) {
        console.error("Failed to load gamut mesh:", e);
        return null;
    }
}
