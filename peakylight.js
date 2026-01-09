// --- Basic Setup ---
const canvas = document.getElementById('webgl-canvas');
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;

const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.1;
controls.rotateSpeed = 0.5;
controls.maxDistance = 100;
controls.maxPolarAngle = Math.PI / 2 - 0.05; // Prevent camera from going below the horizon

// --- State Management ---
let currentLocation = { lat: -37.755, lon: 145.697 };
let selectedDate = new Date();
let currentSunTimes = {};
let selectedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
let lastTerrainLocation = { lat: null, lon: null }; // Keep for terrain-specific logic
let mapZoom = 13; // Default to Medium detail
let terrainHeightData = {};
let animationConfig = {
    type: 'sunrise', // 'sunrise' or 'sunset'
    day: 1,
    frameCounter: 0,
    framesPerDay: 5 // Speed of animation
};
const mapLayerConfigs = {
    'opentopo': {
        name: 'OpenTopoMap',
        leafletUrl: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
        leafletAttribution: 'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, <a href="http://viewfinderpanoramas.org">SRTM</a> | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)',
        threeUrl: (z, x, y) => `https://a.tile.opentopomap.org/${z}/${x}/${y}.png`
    },
    'osm': {
        name: 'OpenStreetMap',
        leafletUrl: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        leafletAttribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        threeUrl: (z, x, y) => `https://a.tile.openstreetmap.org/${z}/${x}/${y}.png`
    },
    'satellite': {
        name: 'World Imagery',
        leafletUrl: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        leafletAttribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
        threeUrl: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`
    }
};
let topoTimesCache = {
    lat: null,
    lon: null,
    year: null,
    data: {} // dayOfYear -> { topoSunrise, topoSunset }
};
let currentMapLayer = 'opentopo';
let isYearAnimating = false;
const cloudCoverInMemoryCache = {}; // In-memory cache for synchronous access

function getStateFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const lat = parseFloat(params.get('lat'));
    const lon = parseFloat(params.get('lon'));
    const tz = params.get('tz');
    const layer = params.get('layer');
    const zoom = parseInt(params.get('zoom'));

    const time = parseInt(params.get('time'));
    if (!isNaN(time)) {
        // Set the date from the URL parameter if it exists
        selectedDate = new Date(time);
    }

    if (!isNaN(lat) && !isNaN(lon)) {
        currentLocation = { lat, lon };
    }

    if (tz) {
        // Validate timezone. First try against the supported list, then fallback.
        try {
            const supportedTimezones = Intl.supportedValuesOf('timeZone');
            if (supportedTimezones.includes(tz)) {
                selectedTimezone = tz;
            } else {
                console.warn(`Unsupported timezone in URL: '${tz}'. Falling back to default.`);
            }
        } catch (e) {
            try {
                new Intl.DateTimeFormat(undefined, { timeZone: tz });
                selectedTimezone = tz;
            } catch (e2) {
                console.warn(`Invalid timezone in URL: '${tz}'. Falling back to default.`);
            }
        }
    }

    if (layer && mapLayerConfigs[layer]) {
        currentMapLayer = layer;
        document.getElementById('map-layer-picker').value = layer;
    }

    if (!isNaN(zoom) && zoom >= 12 && zoom <= 15) {
        mapZoom = zoom;
        document.getElementById('terrain-detail-picker').value = zoom;
    }

}

function updateUrlWithState() {
    const { lat, lon } = currentLocation;
    const url = new URL(window.location);
    url.searchParams.set('lat', lat.toFixed(4));
    url.searchParams.set('lon', lon.toFixed(4));
    url.searchParams.set('tz', selectedTimezone);
    url.searchParams.set('time', selectedDate.getTime());
    url.searchParams.set('layer', currentMapLayer);
    url.searchParams.set('zoom', mapZoom);
    history.pushState({}, '', url);
}

const TILE_BASE_ZOOM = 12;
const TILE_BASE_SIZE = 20;

function getTileWorldSizeForZoom(zoom) {
    return TILE_BASE_SIZE / Math.pow(2, zoom - TILE_BASE_ZOOM);
}

function getGridRadiusForZoom(zoom) {
    switch(zoom) {
        case 12: return 2; // 5x5 grid
        case 13: return 3; // 7x7 grid
        case 14: return 4; // 9x9 grid
        case 15: return 5; // 11x11 grid
        default: return 2;
    }
}

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}
const debouncedUpdateUrl = debounce(updateUrlWithState, 500);

// --- 3D Scene Setup ---
let terrainGrid, sunLight, locationMarker, sunRayLine, sunArcMesh;
let cloudMesh, cloudMaterial; // Cloud visualization
const raycaster = new THREE.Raycaster();
const textureLoader = new THREE.TextureLoader();
textureLoader.crossOrigin = 'anonymous';

const cloudVertexShader = `
varying vec3 vWorldPosition;
varying vec3 vLocalPosition;
void main() {
    vLocalPosition = position;
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;

const cloudFragmentShader = `
precision highp float;

uniform float uTime;
uniform float uCloudCover; // 0.0 to 1.0
uniform vec3 uSunPosition;
uniform vec3 uCloudColor;
uniform vec3 uBoxMin;
uniform vec3 uBoxMax;

varying vec3 vWorldPosition;
varying vec3 vLocalPosition;

// --- Noise Functions ---
// 3D Value Noise
float hash(float n) { return fract(sin(n) * 753.5453123); }
float noise(vec3 x) {
    vec3 p = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    float n = p.x + p.y * 157.0 + 113.0 * p.z;
    return mix(mix(mix(hash(n + 0.0), hash(n + 1.0), f.x),
                   mix(hash(n + 157.0), hash(n + 158.0), f.x), f.y),
               mix(mix(hash(n + 113.0), hash(n + 114.0), f.x),
                   mix(hash(n + 270.0), hash(n + 271.0), f.x), f.y), f.z);
}

// FBM
float fbm(vec3 p) {
    float f = 0.0;
    float w = 0.5;
    for (int i = 0; i < 4; i++) { 
        f += w * noise(p);
        p *= 2.02;
        w *= 0.5;
    }
    return f;
}

// --- Raymarching ---
vec2 rayBoxDst(vec3 boundsMin, vec3 boundsMax, vec3 rayOrigin, vec3 invRayDir) {
    vec3 t0 = (boundsMin - rayOrigin) * invRayDir;
    vec3 t1 = (boundsMax - rayOrigin) * invRayDir;
    vec3 tmin = min(t0, t1);
    vec3 tmax = max(t0, t1);
    float dstA = max(max(tmin.x, tmin.y), tmin.z);
    float dstB = min(min(tmax.x, tmax.y), tmax.z);
    float dstToBox = max(0.0, dstA);
    float dstInsideBox = max(0.0, dstB - dstToBox);
    return vec2(dstToBox, dstInsideBox);
}

void main() {
    vec3 ro = cameraPosition;
    vec3 rd = normalize(vWorldPosition - ro);

    // Calculate intersection with the cloud box
    // Use a slightly smaller box for the volume than the mesh to avoid z-fighting at faces if camera is close
    vec3 boundsMin = uBoxMin; 
    vec3 boundsMax = uBoxMax;
    
    vec3 invRayDir = 1.0 / rd;
    vec2 intersection = rayBoxDst(boundsMin, boundsMax, ro, invRayDir);
    float dstToBox = intersection.x;
    float dstInsideBox = intersection.y;

    if (dstInsideBox <= 0.0) discard;

    // Raymarch
    float stepSize = 0.8; // Larger steps for performance
    int numSteps = int(dstInsideBox / stepSize);
    if (numSteps > 64) numSteps = 64; // Cap steps
    
    // Jitter start position to reduce banding
    float jitter = hash(dot(gl_FragCoord.xy, vec2(12.9898,78.233))) * stepSize;
    vec3 currentPos = ro + rd * (dstToBox + jitter);
    
    float density = 0.0;
    float lightEnergy = 0.0;
    float transmission = 1.0;
    
    vec3 sunDir = normalize(uSunPosition);
    float cloudCoverThreshold = 1.1 - uCloudCover; // Map 0..1 to 1.1..0.1

    for (int i = 0; i < 64; i++) {
        if (i >= numSteps) break;
        if (transmission < 0.01) break;

        // Sampling
        // Scale p for noise frequency. Move with time.
        vec3 p = currentPos * 0.15;
        p.x += uTime * 0.05;
        p.z += uTime * 0.02;
        
        float densitySample = fbm(p);
        
        // Shape density: flatter at bottom/top
        // Normalize height in box 0..1
        float h = (currentPos.y - boundsMin.y) / (boundsMax.y - boundsMin.y);
        densitySample *= smoothstep(0.0, 0.2, h) * smoothstep(1.0, 0.8, h);
        
        // Threshold
        float d = max(0.0, densitySample - cloudCoverThreshold);
        
        if (d > 0.0) {
            d *= 1.5; // Density multiplier
            density += d * stepSize;
            
            // Simple lighting: directional derivative or just density check towards sun?
            // Expensive to march towards sun. Use simple gradient approx.
            float lightTransmittance = exp(-d * 2.0);
            float luminance = 0.1 + lightTransmittance * 0.9; // Darker where dense
            
            // Accumulate
            float absorbed = (1.0 - transmission) * d; // Beer's law approx
            float tr = exp(-d * stepSize);
            
            // Integrate
            lightEnergy += d * stepSize * transmission * luminance;
            transmission *= tr;
        }

        currentPos += rd * stepSize;
    }

    if (lightEnergy <= 0.0) discard;

    vec3 cloudColor = mix(vec3(0.8, 0.85, 0.9), vec3(1.0, 1.0, 1.0), lightEnergy);
    float finalAlpha = 1.0 - transmission;
    
    // Fade out based on distance to hide hard clipping
    // finalAlpha *= smoothstep(0.0, 10.0, dstInsideBox); 

    gl_FragColor = vec4(cloudColor, finalAlpha);
}
`;

function createCloudLayer() {
    // Remove old cloud mesh if it exists
    if (cloudMesh) {
        scene.remove(cloudMesh);
        if (cloudMesh.geometry) cloudMesh.geometry.dispose();
        if (cloudMesh.material) cloudMesh.material.dispose();
    }

    const boxSize = 250;
    const boxHeight = 15;
    const geometry = new THREE.BoxGeometry(boxSize, boxHeight, boxSize);
    
    // Bounds in World Space
    const centerY = 15;
    const min = new THREE.Vector3(-boxSize/2, centerY - boxHeight/2, -boxSize/2);
    const max = new THREE.Vector3(boxSize/2, centerY + boxHeight/2, boxSize/2);

    cloudMaterial = new THREE.ShaderMaterial({
        vertexShader: cloudVertexShader,
        fragmentShader: cloudFragmentShader,
        uniforms: {
            uTime: { value: 0 },
            uCloudCover: { value: 0.5 },
            uSunPosition: { value: new THREE.Vector3(0, 1, 0) },
            uCloudColor: { value: new THREE.Color(0xffffff) },
            uBoxMin: { value: min },
            uBoxMax: { value: max }
        },
        transparent: true,
        side: THREE.BackSide, // Render back faces so we can see "into" the volume from outside
        depthWrite: false
    });

    cloudMesh = new THREE.Mesh(geometry, cloudMaterial);
    cloudMesh.position.set(0, centerY, 0); 
    scene.add(cloudMesh);
}

function createSkirtedPlaneGeometry(width, height, widthSegments, heightSegments, skirtDepth) {
    const geometry = new THREE.BufferGeometry();

    const gridX = Math.floor(widthSegments);
    const gridY = Math.floor(heightSegments);
    const gridX1 = gridX + 1;
    const gridY1 = gridY + 1;
    const segment_width = width / gridX;
    const segment_height = height / gridY;

    // --- Data Arrays ---
    const vertices = [];
    const uvs = [];
    const indices = [];
    
    // --- Generate Top Surface ---
    for (let iy = 0; iy < gridY1; iy++) {
        const y = iy * segment_height - height / 2;
        for (let ix = 0; ix < gridX1; ix++) {
            const x = ix * segment_width - width / 2;
            vertices.push(x, -y, 0); // In XY plane, will be rotated to XZ
            uvs.push(ix / gridX, 1 - (iy / gridY));
        }
    }

    for (let iy = 0; iy < gridY; iy++) {
        for (let ix = 0; ix < gridX; ix++) {
            const a = ix + gridX1 * iy;
            const b = ix + gridX1 * (iy + 1);
            const c = (ix + 1) + gridX1 * (iy + 1);
            const d = (ix + 1) + gridX1 * iy;
            indices.push(a, b, d);
            indices.push(b, c, d);
        }
    }

    const topVerticesCount = vertices.length / 3;
    const skirtVertices = [];
    const skirtUvs = [];
    const skirtIndices = [];
    const edgeToSkirtIndexMap = new Map(); // Maps original top vertex index to its new skirt vertex index (absolute)

    function getOrCreateSkirtVertex(originalIndex) {
        if (edgeToSkirtIndexMap.has(originalIndex)) {
            return edgeToSkirtIndexMap.get(originalIndex);
        }
        const newSkirtIndex = topVerticesCount + skirtVertices.length / 3;
        
        skirtVertices.push(vertices[originalIndex * 3], vertices[originalIndex * 3 + 1], -skirtDepth);
        skirtUvs.push(uvs[originalIndex * 2], uvs[originalIndex * 2 + 1]);

        edgeToSkirtIndexMap.set(originalIndex, newSkirtIndex);
        return newSkirtIndex;
    }

    // Create skirt faces (quads) for each edge segment, with correct winding for outward-facing normals
    const addSkirtQuad = (v1, v2) => {
        const s1 = getOrCreateSkirtVertex(v1);
        const s2 = getOrCreateSkirtVertex(v2);
        skirtIndices.push(v1, v2, s2);
        skirtIndices.push(s2, s1, v1);
    };

    for (let ix = 0; ix < gridX; ix++) addSkirtQuad(ix, ix + 1); // Top edge (CW)
    for (let ix = 0; ix < gridX; ix++) addSkirtQuad(ix + 1 + gridX1 * gridY, ix + gridX1 * gridY); // Bottom edge (CCW, so flip)
    for (let iy = 0; iy < gridY; iy++) addSkirtQuad(gridX1 * (iy + 1), gridX1 * iy); // Left edge (CCW, so flip)
    for (let iy = 0; iy < gridY; iy++) addSkirtQuad(gridX + gridX1 * iy, gridX + gridX1 * (iy + 1)); // Right edge (CW)

    // --- Finalize Geometry ---
    geometry.setIndex(indices.concat(skirtIndices));
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices.concat(skirtVertices)), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs.concat(skirtUvs)), 2));
    
    const edgeToSkirtRelativeIndexMap = new Map();
    for(const [edgeIndex, skirtAbsoluteIndex] of edgeToSkirtIndexMap.entries()) {
        edgeToSkirtRelativeIndexMap.set(edgeIndex, skirtAbsoluteIndex - topVerticesCount);
    }
    geometry.userData = { edgeToSkirtMap: edgeToSkirtRelativeIndexMap, skirtDepth, topVerticesCount };

    return geometry;
}

function setupScene() {
    terrainGrid = new THREE.Group();
    scene.add(terrainGrid);

    const MAX_GRID_RADIUS = 5; // Corresponds to 11x11 grid for Ultra detail

    for (let i = -MAX_GRID_RADIUS; i <= MAX_GRID_RADIUS; i++) {
        for (let j = -MAX_GRID_RADIUS; j <= MAX_GRID_RADIUS; j++) {
            const skirtDepth = 1; // A reasonable depth for skirts to hide seams.
            const terrainGeometry = createSkirtedPlaneGeometry(TILE_BASE_SIZE, TILE_BASE_SIZE, 255, 255, skirtDepth);
            const terrainMaterial = new THREE.MeshStandardMaterial({ color: 0xcccccc, side: THREE.FrontSide });
            const terrainMesh = new THREE.Mesh(terrainGeometry, terrainMaterial);
            terrainMesh.rotation.x = -Math.PI / 2;
            terrainMesh.receiveShadow = true;
            terrainMesh.position.set(j * TILE_BASE_SIZE, 0, i * TILE_BASE_SIZE); // Position is relative to the grid group
            terrainMesh.visible = false; // Initially hide all tiles
            terrainMesh.name = `tile_${i}_${j}`;
            terrainGrid.add(terrainMesh);
        }
    }

    const markerGeometry = new THREE.SphereGeometry(0.1, 32, 16);
    const markerMaterial = new THREE.MeshStandardMaterial({ color: 0xff0000, emissive: 0x330000 });
    locationMarker = new THREE.Mesh(markerGeometry, markerMaterial);
    scene.add(locationMarker);

    const sunRayMaterial = new THREE.LineBasicMaterial({ color: 0xffff00 });
    const sunRayGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    sunRayLine = new THREE.Line(sunRayGeometry, sunRayMaterial);
    scene.add(sunRayLine);

    const ambientLight = new THREE.AmbientLight(0x404040, 0.8);
    scene.add(ambientLight);

    sunLight = new THREE.DirectionalLight(0xffffff, 1.5);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.width = 2048;
    sunLight.shadow.mapSize.height = 2048;
    sunLight.shadow.camera.near = 0.5;
    sunLight.shadow.camera.far = 50;
    sunLight.shadow.camera.left = -15;
    sunLight.shadow.camera.right = 15;
    sunLight.shadow.camera.top = 15;
    sunLight.shadow.camera.bottom = -15;
    scene.add(sunLight);
    scene.add(sunLight.target);

    createCloudLayer();

    camera.position.set(0, 8, 15);
    controls.update();
}

async function updateTerrain() {
    // Check if location has changed enough to warrant a reload.
    if (lastTerrainLocation.lat !== null &&
        Math.abs(currentLocation.lat - lastTerrainLocation.lat) < 0.0001 &&
        Math.abs(currentLocation.lon - lastTerrainLocation.lon) < 0.0001) {
        
        // Location hasn't changed significantly. This path is taken for updates that only
        // change the time (e.g., clicking a time-jump icon in the report).
        // We still need to update the sun and calculated times.
        updateSunPosition();
        await calculateTopoTimes(); // It's async, so await it.
        return;
    }

    const loader = document.getElementById('loader');
    const loaderText = document.getElementById('loader-text');
    const progressBar = document.getElementById('progress-bar');

    loaderText.textContent = 'Calculating view...';
    progressBar.style.width = '0%';
    loader.style.display = 'block';
    scene.background = new THREE.Color(0xFFFDE7); // Match page background
    
    const tileWorldSize = getTileWorldSizeForZoom(mapZoom);
    const preciseTileCoords = dataManager.lonLatToTileCoords(currentLocation.lon, currentLocation.lat, mapZoom);
    const centralTileCoords = { x: Math.floor(preciseTileCoords.x), y: Math.floor(preciseTileCoords.y), z: mapZoom };

    const offsetX = preciseTileCoords.x - centralTileCoords.x;
    const offsetY = preciseTileCoords.y - centralTileCoords.y;

    const meshShiftX = (offsetX - 0.5) * tileWorldSize;
    const meshShiftZ = (offsetY - 0.5) * tileWorldSize;

    terrainGrid.position.x = -meshShiftX;
    terrainGrid.position.z = -meshShiftZ;

    const gridRadius = getGridRadiusForZoom(mapZoom);
    let loadedCount = 0;
    const totalTiles = Math.pow(gridRadius * 2 + 1, 2);
    const promises = [];
    const scaleFactor = tileWorldSize / TILE_BASE_SIZE;

    // Hide all tiles before showing/updating the relevant ones
    terrainGrid.children.forEach(tile => tile.visible = false);

    for (let i = -gridRadius; i <= gridRadius; i++) {
        for (let j = -gridRadius; j <= gridRadius; j++) {
            const tileX = centralTileCoords.x + j;
            const tileY = centralTileCoords.y + i;
            const heightmapUrl = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${centralTileCoords.z}/${tileX}/${tileY}.png`;
            const satelliteUrl = mapLayerConfigs[currentMapLayer].threeUrl(centralTileCoords.z, tileX, tileY);
            const terrainMesh = terrainGrid.getObjectByName(`tile_${i}_${j}`);
            if (terrainMesh) {
                terrainMesh.scale.set(scaleFactor, scaleFactor, 1);
                terrainMesh.position.set(j * tileWorldSize, 0, i * tileWorldSize);
                terrainMesh.visible = true;
                const promise = updateTile(terrainMesh, satelliteUrl, heightmapUrl).then(() => {
                    loadedCount++;
                    progressBar.style.width = `${(loadedCount / totalTiles) * 100}%`;
                });
                promises.push(promise);
            }
        }
    }

    try {
        await Promise.all(promises);

        synchronizeTileBoundaries(gridRadius);

        const centralMesh = terrainGrid.getObjectByName('tile_0_0');
        const centerIndex = Math.floor(offsetY * 255) * 256 + Math.floor(offsetX * 255);
        const centralHeight = centralMesh.geometry.attributes.position.getZ(centerIndex);
        locationMarker.position.y = centralHeight + 0.01;

        // Update last known location after successful terrain update
        lastTerrainLocation = { lat: currentLocation.lat, lon: currentLocation.lon };

        updateSunPosition();
        await calculateTopoTimes();
    } catch (error) {
        console.error("Failed to load terrain data:", error);
        // alert("Could not load terrain data for this location."); // Alerts block automated tests.
    } finally {
        loader.style.display = 'none';
    }
}

async function updateTile(terrainMesh, satelliteUrl, heightmapUrl) {
    const tileData = await dataManager.getTileData(satelliteUrl, heightmapUrl);

    terrainMesh.material.map = tileData.satelliteTexture;
    terrainMesh.material.needsUpdate = true;

    const geometry = terrainMesh.geometry;
    const vertices = geometry.attributes.position;
    const { topVerticesCount, edgeToSkirtMap, skirtDepth } = geometry.userData;

    for (let i = 0; i < topVerticesCount; i++) {
        vertices.setZ(i, tileData.heights[i]);
    }

    // Update skirt vertices heights to match their corresponding edge vertex
    if (edgeToSkirtMap && skirtDepth !== undefined) {
        for (const [edgeIndex, skirtRelativeIndex] of edgeToSkirtMap.entries()) {
            const edgeHeight = vertices.getZ(edgeIndex);
            vertices.setZ(topVerticesCount + skirtRelativeIndex, edgeHeight - skirtDepth);
        }
    }

    vertices.needsUpdate = true;
    geometry.computeVertexNormals();

    terrainHeightData[terrainMesh.name] = {
        heights: tileData.heights,
        width: tileData.width,
        height: tileData.height
    };
}

// --- Sun Position and Ray Calculation ---
function getSunPosition(date, radius = 20) {
    const sunPos = SunCalc.getPosition(date, currentLocation.lat, currentLocation.lon);
    const sunY = radius * Math.sin(sunPos.altitude);
    const sunR = radius * Math.cos(sunPos.altitude);
    const sunX = sunR * Math.sin(sunPos.azimuth + Math.PI);
    const sunZ = sunR * Math.cos(sunPos.azimuth + Math.PI);
    return new THREE.Vector3(sunX, sunY, sunZ);
}

function getTerrainHeightAt(worldX, worldZ) {
    const gridLocalX = worldX - terrainGrid.position.x;
    const gridLocalZ = worldZ - terrainGrid.position.z;

    const tileWorldSize = getTileWorldSizeForZoom(mapZoom);
    const gridRadius = getGridRadiusForZoom(mapZoom);
    const tile_j = Math.round(gridLocalX / tileWorldSize);
    const tile_i = Math.round(gridLocalZ / tileWorldSize);

    if (tile_i < -gridRadius || tile_i > gridRadius || tile_j < -gridRadius || tile_j > gridRadius) {
        return -Infinity;
    }

    const tileName = `tile_${tile_i}_${tile_j}`;
    const tileData = terrainHeightData[tileName];
    if (!tileData) return 0;

    const tileLocalX = gridLocalX - tile_j * tileWorldSize;
    const tileLocalZ = gridLocalZ - tile_i * tileWorldSize;

    const gridX = (tileLocalX + tileWorldSize / 2) / tileWorldSize * (tileData.width - 1);
    const gridZ = (tileLocalZ + tileWorldSize / 2) / tileWorldSize * (tileData.height - 1);

    const x1 = Math.floor(gridX);
    const z1 = Math.floor(gridZ);
    const x2 = Math.ceil(gridX);
    const z2 = Math.ceil(gridZ);

    if (x1 < 0 || x2 >= tileData.width || z1 < 0 || z2 >= tileData.height) {
        return 0;
    }
    
    const h11 = tileData.heights[z1 * tileData.width + x1];
    const h12 = tileData.heights[z2 * tileData.width + x1];
    const h21 = tileData.heights[z1 * tileData.width + x2];
    const h22 = tileData.heights[z2 * tileData.width + x2];

    if (h11 === undefined || h12 === undefined || h21 === undefined || h22 === undefined) return 0;

    const tx = gridX - x1;
    const tz = gridZ - z1;

    const h_z1 = h11 * (1 - tz) + h12 * tz;
    const h_z2 = h21 * (1 - tz) + h22 * tz;

    return h_z1 * (1 - tx) + h_z2 * tx;
}

function isLocationSunlit(date) {
    if (Object.keys(terrainHeightData).length === 0) return { isLit: true, intersectionPoint: null };

    const sunPosition = getSunPosition(date, 10);
    const targetPosition = locationMarker.position;

    if (sunPosition.y < targetPosition.y - 5) {
         const sunp = SunCalc.getPosition(date, currentLocation.lat, currentLocation.lon);
         if (sunp.altitude < 0) return { isLit: false, intersectionPoint: null };
    }

    const rayDirection = targetPosition.clone().sub(sunPosition);
    const rayLength = rayDirection.length();
    rayDirection.normalize();

    const stepSize = 2.0;
    const numSteps = Math.floor(rayLength / stepSize);

    for (let i = 1; i < numSteps; i++) {
        const currentPos = sunPosition.clone().add(rayDirection.clone().multiplyScalar(i * stepSize));
        const terrainHeight = getTerrainHeightAt(currentPos.x, currentPos.z);

        if (currentPos.y < terrainHeight) {
            const prevPos = sunPosition.clone().add(rayDirection.clone().multiplyScalar((i - 1) * stepSize));
            for (let j = 0.1; j <= 1.0; j += 0.2) {
                const finePos = prevPos.clone().lerp(currentPos, j);
                if (finePos.y < getTerrainHeightAt(finePos.x, finePos.z)) {
                    finePos.y = getTerrainHeightAt(finePos.x, finePos.z);
                    return { isLit: false, intersectionPoint: finePos };
                }
            }
        }
    }

    return { isLit: true, intersectionPoint: null };
}

function updateSunPosition() {
    const sunPosition = getSunPosition(selectedDate, 10);
    sunLight.position.copy(sunPosition);
    sunLight.target.position.set(0, 0, 0);
    
    const linePositions = sunRayLine.geometry.attributes.position;
    linePositions.setXYZ(0, sunPosition.x, sunPosition.y, sunPosition.z);
    
    const sunlitResult = isLocationSunlit(selectedDate);

    if (sunlitResult.isLit) {
        linePositions.setXYZ(1, locationMarker.position.x, locationMarker.position.y, locationMarker.position.z);
    } else {
        if (sunlitResult.intersectionPoint) {
            linePositions.setXYZ(1, sunlitResult.intersectionPoint.x, sunlitResult.intersectionPoint.y, sunlitResult.intersectionPoint.z);
        } else {
            // Sun is below horizon, so we don't draw the line to the marker.
            // Instead, just show a short stub of the ray from the sun's position.
            const rayStub = sunPosition.clone().add(new THREE.Vector3(0, -1, 0)); // Point it down
            linePositions.setXYZ(1, rayStub.x, rayStub.y, rayStub.z);
        }
    }
    linePositions.needsUpdate = true;
    
    const sunY = sunPosition.y;
    if (sunY < -2) {
        sunLight.intensity = 0.1;
        sunRayLine.visible = false;
        scene.background = new THREE.Color(0x050515);
    } else {
        sunRayLine.visible = true;
        if (sunY < 2) {
            sunLight.intensity = 1.2;
            sunLight.color.setHSL(0.1, 1, 0.6);
            scene.background = new THREE.Color(0xffa500).lerp(new THREE.Color(0x00008b), sunY / 4);
        } else {
            sunLight.intensity = 1.5;
            sunLight.color.setHSL(0.1, 1, 0.95);
            scene.background = new THREE.Color(0x87ceeb);
        }
    }
}

function updateSunArc(astronomicalTimes, topoSunrise, topoSunset) {
    if (sunArcMesh) {
        scene.remove(sunArcMesh);
        sunArcMesh.geometry.dispose();
        sunArcMesh.material.dispose();
    }

    const sunriseTime = astronomicalTimes.sunrise.getTime();
    const sunsetTime = astronomicalTimes.sunset.getTime();
    const totalDaylight = sunsetTime - sunriseTime;

    if (totalDaylight <= 0) return;

    const pathPoints = [];
    const segments = 60;
    for (let i = 0; i <= segments; i++) {
        const percentOfDay = i / segments;
        const time = new Date(sunriseTime + totalDaylight * percentOfDay);
        pathPoints.push(getSunPosition(time, 10)); // Arc radius of 10
    }

    const curve = new THREE.CatmullRomCurve3(pathPoints);
    const tubeGeometry = new THREE.TubeGeometry(curve, 64, 0.4, 8, false);
    
    const colors = [];
    const gray = new THREE.Color(0x808080);
    const yellow = new THREE.Color(0xFFFF00);
    const topoSunrisePercent = (topoSunrise.getTime() - sunriseTime) / totalDaylight;
    const topoSunsetPercent = (topoSunset.getTime() - sunriseTime) / totalDaylight;
    const uvs = tubeGeometry.attributes.uv.array;

    for (let i = 0; i < tubeGeometry.attributes.position.count; i++) {
        const u = uvs[i * 2];
        const color = (u >= topoSunrisePercent && u <= topoSunsetPercent) ? yellow : gray;
        colors.push(color.r, color.g, color.b);
    }

    tubeGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const material = new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.5
    });

    sunArcMesh = new THREE.Mesh(tubeGeometry, material);
    scene.add(sunArcMesh);
}

async function findTopoTime(startTime, endTime, findFirstLight) {
    let low = startTime.getTime();
    let high = endTime.getTime();
    let bestTime = findFirstLight ? high : low;

    for (let i = 0; i < 15; i++) { // 15 iterations for high precision
        const mid = low + (high - low) / 2;
        const { isLit } = isLocationSunlit(new Date(mid));

        if (findFirstLight) {
            if (isLit) {
                bestTime = mid;
                high = mid;
            } else {
                low = mid;
            }
        } else { // findLastLight
            if (isLit) {
                bestTime = mid;
                low = mid;
            } else {
                high = mid;
            }
        }
    }
    return new Date(bestTime);
}

// --- Helper function to format time without timezone conversion ---
function formatTime(date, timeZone) {
    if (!date || isNaN(date)) return "N/A";
    try {
        return new Intl.DateTimeFormat('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            timeZone: timeZone,
            hourCycle: 'h23'
        }).format(date);
    } catch (e) {
        console.error(`Invalid timezone: ${timeZone}`, e);
        // Fallback to browser's local time if timezone is invalid
        const hours = date.getHours().toString().padStart(2, '0');
        const minutes = date.getMinutes().toString().padStart(2, '0');
        return `${hours}:${minutes}`;
    }
}

function getPartsInTimezone(date, timeZone) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    });
    const parts = formatter.formatToParts(date);
    const map = parts.reduce((acc, part) => {
        if (part.type !== 'literal') {
            acc[part.type] = part.value;
        }
        return acc;
    }, {});
    return {
        year: parseInt(map.year), month: parseInt(map.month), day: parseInt(map.day),
        hour: parseInt(map.hour === '24' ? '0' : map.hour), minute: parseInt(map.minute), second: parseInt(map.second)
    };
}

function getDayOfYear(date, timeZone) {
    const parts = getPartsInTimezone(date, timeZone);
    const start = new Date(Date.UTC(parts.year, 0, 1));
    const current = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    return Math.ceil((current - start) / (1000 * 60 * 60 * 24)) + 1;
}

async function calculateTopoTimes() {
    document.getElementById('topo-sunrise-time').textContent = "Calculating...";
    document.getElementById('topo-sunset-time').textContent = "Calculating...";
    document.getElementById('jump-to-topo-sunrise').style.visibility = 'hidden';
    document.getElementById('jump-to-topo-sunset').style.visibility = 'hidden';
    document.getElementById('sunrise-loss').textContent = "Calculating...";
    document.getElementById('sunset-loss').textContent = "Calculating...";
    document.getElementById('total-daylight-loss').textContent = "Calculating...";
    
    
    const times = SunCalc.getTimes(selectedDate, currentLocation.lat, currentLocation.lon);
    const topoSunrise = await findTopoTime(times.sunrise, times.solarNoon, true);
    const topoSunset = await findTopoTime(times.solarNoon, times.sunset, false);

    currentSunTimes.topoSunrise = topoSunrise;
    currentSunTimes.topoSunset = topoSunset;

    const sunriseLossMs = (topoSunrise && times.sunrise && !isNaN(topoSunrise) && !isNaN(times.sunrise)) ? topoSunrise.getTime() - times.sunrise.getTime() : 0;
    const sunsetLossMs = (topoSunset && times.sunset && !isNaN(topoSunset) && !isNaN(times.sunset)) ? times.sunset.getTime() - topoSunset.getTime() : 0;
    const totalLossMs = Math.max(0, sunriseLossMs) + Math.max(0, sunsetLossMs);

    const astroTotalMs = (times.sunset && times.sunrise) ? times.sunset.getTime() - times.sunrise.getTime() : 0;
    const topoTotalMs = (topoSunset && topoSunrise) ? topoSunset.getTime() - topoSunrise.getTime() : 0;

    document.getElementById('topo-sunrise-time').textContent = formatTime(topoSunrise, selectedTimezone);
    document.getElementById('topo-sunset-time').textContent = formatTime(topoSunset, selectedTimezone);
    document.getElementById('jump-to-topo-sunrise').style.visibility = 'visible';
    document.getElementById('jump-to-topo-sunset').style.visibility = 'visible';

    document.getElementById('sunrise-loss').textContent = formatDuration(sunriseLossMs);
    document.getElementById('sunset-loss').textContent = formatDuration(sunsetLossMs);
    document.getElementById('total-daylight-loss').textContent = formatDuration(totalLossMs);
    document.getElementById('astro-total-daylight').textContent = formatDuration(astroTotalMs);
    document.getElementById('topo-total-daylight').textContent = formatDuration(topoTotalMs);

    // Trigger update for solar estimate if cloud cover is already there
    updateSceneCloudCover();

    updateSunArc(times, topoSunrise, topoSunset);
    updateDaylightDiagram(times, topoSunrise, topoSunset);
}
function updateDaylightTooltip(astronomicalTimes, topoSunrise, topoSunset) {
    const tooltip = document.getElementById('daylight-tooltip');
    if (!tooltip) return;

    const astroSunrise = astronomicalTimes.sunrise;
    const astroSunset = astronomicalTimes.sunset;

    const tooltipContent = `
        Astro Rise: ${formatTime(astroSunrise, selectedTimezone)}<br>
        Topo Rise: ${formatTime(topoSunrise, selectedTimezone)}<br>
        Topo Set: ${formatTime(topoSunset, selectedTimezone)}<br>
        Astro Set: ${formatTime(astroSunset, selectedTimezone)}`;
    tooltip.innerHTML = tooltipContent;
}

function updateDaylightDiagram(astronomicalTimes, topoSunrise, topoSunset) {
    const canvas = document.getElementById('daylight-diagram');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    const astroSunrise = astronomicalTimes.sunrise;
    const astroSunset = astronomicalTimes.sunset;

    if (!astroSunrise || !astroSunset || isNaN(astroSunrise) || isNaN(astroSunset)) {
        ctx.clearRect(0, 0, width, height);
        return;
    }

    const dayStart = new Date(astroSunrise).setHours(0, 0, 0, 0);
    const dayEnd = new Date(astroSunrise).setHours(23, 59, 59, 999);
    const totalDayMs = dayEnd - dayStart;

    const astroSunrisePercent = (astroSunrise.getTime() - dayStart) / totalDayMs;
    const astroSunsetPercent = (astroSunset.getTime() - dayStart) / totalDayMs;
    const topoSunrisePercent = (topoSunrise.getTime() - dayStart) / totalDayMs;
    const topoSunsetPercent = (topoSunset.getTime() - dayStart) / totalDayMs;

    // Background (night)
    ctx.fillStyle = '#2c3e50'; // Dark blue/gray
    ctx.fillRect(0, 0, width, height);

    // Astronomical daylight (potential daylight)
    ctx.fillStyle = '#bdc3c7'; // Light gray
    ctx.fillRect(astroSunrisePercent * width, 0, (astroSunsetPercent - astroSunrisePercent) * width, height);

    // Topographical daylight (actual daylight)
    ctx.fillStyle = '#f1c40f'; // Yellow
    ctx.fillRect(topoSunrisePercent * width, 0, (topoSunsetPercent - topoSunrisePercent) * width, height);

    // Update the tooltip content
    updateDaylightTooltip(astronomicalTimes, topoSunrise, topoSunset);
}

function updateSliderIndicators() {
    const times = SunCalc.getTimes(selectedDate, currentLocation.lat, currentLocation.lon);
    
    const sunriseParts = getPartsInTimezone(times.sunrise, selectedTimezone);
    const sunsetParts = getPartsInTimezone(times.sunset, selectedTimezone);

    const sunriseMinutes = sunriseParts.hour * 60 + sunriseParts.minute;
    const sunsetMinutes = sunsetParts.hour * 60 + sunsetParts.minute;

    const sunriseIndicator = document.getElementById('sunrise-indicator');
    const sunsetIndicator = document.getElementById('sunset-indicator');
    const timeSlider = document.getElementById('time-slider');

    const sunrisePercent = (sunriseMinutes / 1439) * 100;
    const sunsetPercent = (sunsetMinutes / 1439) * 100;

    sunriseIndicator.style.left = `calc(${sunrisePercent}% - 1px)`; // Center the 2px indicator
    sunsetIndicator.style.left = `calc(${sunsetPercent}% - 1px)`;

    const nightColor = '#2c3e50';
    const dayColor = '#87ceeb';
    const twilightColor = '#ffc371';

    timeSlider.style.background = `linear-gradient(to right, 
                ${nightColor} 0%, ${twilightColor} ${Math.max(0, sunrisePercent - 5)}%, ${dayColor} ${Math.min(100, sunrisePercent + 5)}%, 
                ${dayColor} ${Math.max(0, sunsetPercent - 5)}%, ${twilightColor} ${Math.min(100, sunsetPercent + 5)}%, ${nightColor} 100%)`;
}

// --- UI and Data Updates ---
function updateInfoDisplay() {
    document.getElementById('location-coords').textContent = `${currentLocation.lat.toFixed(4)}, ${currentLocation.lon.toFixed(4)}`;
    document.getElementById('lat-input').value = currentLocation.lat.toFixed(4);
    document.getElementById('lon-input').value = currentLocation.lon.toFixed(4);
    
    const times = SunCalc.getTimes(selectedDate, currentLocation.lat, currentLocation.lon);
    currentSunTimes.sunrise = times.sunrise;
    currentSunTimes.sunset = times.sunset;
    document.getElementById('sunrise-time').textContent = formatTime(times.sunrise, selectedTimezone);
    document.getElementById('sunset-time').textContent = formatTime(times.sunset, selectedTimezone);
    document.getElementById('jump-to-sunrise').style.visibility = times.sunrise ? 'visible' : 'hidden';
    document.getElementById('jump-to-sunset').style.visibility = times.sunset ? 'visible' : 'hidden';
    
    const parts = getPartsInTimezone(selectedDate, selectedTimezone);
    const hours = parts.hour.toString().padStart(2, '0');
    const minutes = parts.minute.toString().padStart(2, '0');
    document.getElementById('time-picker').value = `${hours}:${minutes}`;
    document.getElementById('time-slider').value = parts.hour * 60 + parts.minute;
    
    document.getElementById('date-slider').value = getDayOfYear(selectedDate, selectedTimezone);
    document.getElementById('date-picker').value = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;

    updateSliderIndicators();
    updateSceneCloudCover();
}



async function cacheYearlyTopoTimes() {
    const year = selectedDate.getFullYear();
    // Check if cache is valid
    if (topoTimesCache.lat === currentLocation.lat &&
        topoTimesCache.lon === currentLocation.lon &&
        topoTimesCache.year === year &&
        Object.keys(topoTimesCache.data).length > 0) {
        return true;
    }

    // Invalidate and prepare for caching
    topoTimesCache = {
        lat: currentLocation.lat,
        lon: currentLocation.lon,
        year: year,
        data: {}
    };

    const loader = document.getElementById('loader');
    const loaderText = document.getElementById('loader-text');
    const progressBar = document.getElementById('progress-bar');

    loaderText.textContent = `Caching yearly data for ${year}...`;
    progressBar.style.width = '0%';
    loader.style.display = 'block';

    // Yield to render loader
    await new Promise(resolve => setTimeout(resolve, 0));

    const isLeap = new Date(year, 1, 29).getDate() === 29;
    const daysInYear = isLeap ? 366 : 365;

    for (let day = 1; day <= daysInYear; day++) {
        const date = new Date(year, 0, day);
        const times = SunCalc.getTimes(date, currentLocation.lat, currentLocation.lon);
        
        const topoSunrise = await findTopoTime(times.sunrise, times.solarNoon, true);
        const topoSunset = await findTopoTime(times.solarNoon, times.sunset, false);

        topoTimesCache.data[day] = { topoSunrise, topoSunset, sunrise: times.sunrise, sunset: times.sunset };

        progressBar.style.width = `${(day / daysInYear) * 100}%`;
    }

    loader.style.display = 'none';
    return true;
}

// --- Time Navigation ---
function jumpToTime(time) {
    if (!time || isNaN(time)) return;
    
    selectedDate = new Date(time);
    updateInfoDisplay();
    updateSunPosition();
    debouncedUpdateUrl();
}

async function exportVideo(type) {
    stopAnimations();
}

async function exportSplitScreenVideo() {
    // 1. Pre-cache all data to make frame generation fast
    const cacheSuccess = await cacheYearlyTopoTimes();
    if (!cacheSuccess) {
        alert("Could not generate animation data for export.");
        return;
    }

    const loader = document.getElementById('loader');
    const loaderText = document.getElementById('loader-text');
    const progressBar = document.getElementById('progress-bar');
    loaderText.textContent = `Exporting split-screen video...`;
    progressBar.style.width = '0%';
    loader.style.display = 'block';

    // 1.5 Pre-cache cloud data
    loaderText.textContent = `Caching cloud data...`;
    for (let m = 1; m <= 12; m++) {
        await getAverageCloudCover(m);
        progressBar.style.width = `${(m / 12) * 100}%`;
    }
    loaderText.textContent = `Exporting split-screen video...`;
    progressBar.style.width = '0%';

    // 2. Setup for export (canvas, dimensions, etc.)
    const exportWidth = 1920;
    const exportHeight = 1080;
    const fps = 30;
    const framesPerDay = 12; // How many frames to render for each day for a smoother video.

    const originalWidth = canvas.width;
    const originalHeight = canvas.height;
    const originalDate = new Date(selectedDate);
    const originalAspect = camera.aspect;

    renderer.setSize(exportWidth, exportHeight);
    camera.aspect = (exportWidth / 2) / exportHeight; // Aspect ratio for one half of the screen
    camera.updateProjectionMatrix();

    // 3. Setup MediaRecorder
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = exportWidth;
    tempCanvas.height = exportHeight;
    const tempCtx = tempCanvas.getContext('2d');

    // Double buffering: Render everything to stagingCanvas first, then copy to tempCanvas (recorded) in one go.
    // This prevents the MediaRecorder from capturing partial frames (e.g. missing text).
    const stagingCanvas = document.createElement('canvas');
    stagingCanvas.width = exportWidth;
    stagingCanvas.height = exportHeight;
    const stagingCtx = stagingCanvas.getContext('2d');

    const mimeType = 'video/mp4';
    const isMp4Supported = MediaRecorder.isTypeSupported(mimeType);
    const finalMimeType = isMp4Supported ? mimeType : 'video/webm';
    const fileExtension = isMp4Supported ? 'mp4' : 'webm';

    const stream = tempCanvas.captureStream(fps);
    const recorder = new MediaRecorder(stream, { mimeType: finalMimeType, videoBitsPerSecond: 10000000 });
    const recordedChunks = [];

    recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
            recordedChunks.push(event.data);
        }
    };

    recorder.onstop = async () => {
        const blob = new Blob(recordedChunks, { type: finalMimeType });
        const url = URL.createObjectURL(blob);

        const link = document.createElement('a');
        link.href = url;
        link.download = `peakylight-split-export-${year}.${fileExtension}`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

        // Restore original state
        renderer.setSize(originalWidth, originalHeight);
        renderer.setViewport(0, 0, originalWidth, originalHeight);
        renderer.setScissorTest(false);
        camera.aspect = originalAspect;
        camera.updateProjectionMatrix();
        selectedDate = originalDate;
        
        updateInfoDisplay();
        updateSunPosition();
        await calculateTopoTimes();
        debouncedUpdateUrl();

        loader.style.display = 'none';
    };

    // 4. Animation loop
    let day = 1;
    let frameInDay = 0;
    const year = topoTimesCache.year;
    const isLeap = new Date(year, 1, 29).getDate() === 29;
    const daysInYear = isLeap ? 366 : 365;
    const totalFrames = daysInYear * framesPerDay;
    let currentFrame = 0;

    recorder.start();

    // Disable controls to prevent interference/judder during export
    controls.enabled = false;

    async function renderFrame() {
        if (day > daysInYear) {
            recorder.stop();
            controls.enabled = true; // Re-enable controls
            return;
        }

        const cachedTimes = topoTimesCache.data[day];
        if (cachedTimes) {
            // --- Common setup for the frame ---
            const dayProgress = (day - 1 + (frameInDay / framesPerDay)) / daysInYear;
            const angle = dayProgress * Math.PI * 2;
            const distance = 25;
            const height = 10;
            camera.position.set(distance * Math.sin(angle), height, distance * Math.cos(angle));
            camera.lookAt(0, 0, 0); // Manually look at center instead of controls.update()

            const astronomicalTimes = { sunrise: cachedTimes.sunrise, sunset: cachedTimes.sunset };

            // --- Render Left Side (Sunrise) ---
            renderer.setViewport(0, 0, exportWidth / 2, exportHeight);
            renderer.setScissor(0, 0, exportWidth / 2, exportHeight);
            renderer.setScissorTest(true);
            selectedDate = cachedTimes.topoSunrise;
            updateSunPosition();
            await updateSceneCloudCover(true);
            updateSunArc(astronomicalTimes, cachedTimes.topoSunrise, cachedTimes.topoSunset);
            renderer.render(scene, camera);

            // --- Render Right Side (Sunset) ---
            renderer.setViewport(exportWidth / 2, 0, exportWidth / 2, exportHeight);
            renderer.setScissor(exportWidth / 2, 0, exportWidth / 2, exportHeight);
            renderer.setScissorTest(true);
            selectedDate = cachedTimes.topoSunset;
            updateSunPosition();
            updateSunArc(astronomicalTimes, cachedTimes.topoSunrise, cachedTimes.topoSunset);
            renderer.render(scene, camera);

            // --- Composite frame for MediaRecorder ---
            const sunriseDiffMs = (astronomicalTimes.sunrise && cachedTimes.topoSunrise && !isNaN(astronomicalTimes.sunrise) && !isNaN(cachedTimes.topoSunrise))
                ? astronomicalTimes.sunrise.getTime() - cachedTimes.topoSunrise.getTime()
                : 0;
            const sunsetDiffMs = (astronomicalTimes.sunset && cachedTimes.topoSunset && !isNaN(astronomicalTimes.sunset) && !isNaN(cachedTimes.topoSunset))
                ? cachedTimes.topoSunset.getTime() - astronomicalTimes.sunset.getTime()
                : 0;
            const totalLostMs = sunriseDiffMs + sunsetDiffMs;

            const astroTotalMs = (astronomicalTimes.sunset && astronomicalTimes.sunrise) ? astronomicalTimes.sunset.getTime() - astronomicalTimes.sunrise.getTime() : 0;
            const topoTotalMs = (cachedTimes.topoSunset && cachedTimes.topoSunrise) ? cachedTimes.topoSunset.getTime() - cachedTimes.topoSunrise.getTime() : 0;

            // Cloud and Solar
            // We need cloud cover for this specific month (day -> month)
            // cachedTimes.topoSunrise is a Date object
            const currentMonth = cachedTimes.topoSunrise.getMonth() + 1;
            // Since we pre-cached, this should be fast and we can now use the sync version
            const cloudCoverStr = getAverageCloudCoverSync(currentMonth);
            let cloudPercentage = 50;
            if (typeof cloudCoverStr === 'string') {
                const parts = cloudCoverStr.split('%');
                if (parts.length > 0) cloudPercentage = parseInt(parts[0]) || 0;
            }
            const solarGenEst = (topoTotalMs / (1000 * 60 * 60)) * (1.0 - cloudPercentage / 100.0);


            stagingCtx.drawImage(renderer.domElement, 0, 0);
            const locationText = `Location: ${currentLocation.lat.toFixed(4)}, ${currentLocation.lon.toFixed(4)}`;
            const font = `18px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
            const sunriseDate = cachedTimes.topoSunrise, sunsetDate = cachedTimes.topoSunset;

            // Left Panel
            const panelX = 10, panelY = 10, panelW = 420, panelH = 300; // Increased height
            const textX = panelX + 15, textY = panelY + 15;
            stagingCtx.fillStyle = 'rgba(0, 0, 0, 0.6)'; stagingCtx.fillRect(panelX, panelY, panelW, panelH);
            stagingCtx.fillStyle = '#f0f0f0'; stagingCtx.font = font; stagingCtx.textAlign = 'left';
            let y = textY;
            stagingCtx.fillText("Topographic Sunrise", textX, y += 20);
            stagingCtx.fillText(locationText, textX, y += 25);
            stagingCtx.fillText(`Date         : ${sunriseDate.toLocaleDateString([], { timeZone: selectedTimezone })}`, textX, y += 25);
            stagingCtx.fillText(`Topo Sunrise : ${sunriseDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: selectedTimezone })}`, textX, y += 25);
            stagingCtx.fillText(`Astro Sunrise: ${formatTime(astronomicalTimes.sunrise, selectedTimezone)}`, textX, y += 25);
            stagingCtx.fillText(`Sunrise Diff : ${formatTimeDiff(sunriseDiffMs)}`, textX, y += 25);
            stagingCtx.fillText(`Total Lost   : ${formatTimeDiff(totalLostMs)}`, textX, y += 25);
            stagingCtx.fillText(`Astro Total  : ${formatDuration(astroTotalMs)}`, textX, y += 25);
            stagingCtx.fillText(`Topo Total   : ${formatDuration(topoTotalMs)}`, textX, y += 25);
            stagingCtx.fillText(`Cloud Cover  : ${cloudPercentage}%`, textX, y += 25);
            stagingCtx.fillText(`1kW Solar Est: ${solarGenEst.toFixed(2)} kWh`, textX, y += 25);

            // Right Panel
            const rightPanelX = exportWidth / 2 + 10;
            const rightTextX = rightPanelX + 15;
            stagingCtx.fillStyle = 'rgba(0, 0, 0, 0.6)'; stagingCtx.fillRect(rightPanelX, panelY, panelW, panelH);
            stagingCtx.fillStyle = '#f0f0f0'; stagingCtx.font = font; stagingCtx.textAlign = 'left';
            y = textY;
            stagingCtx.fillText("Topographic Sunset", rightTextX, y += 20);
            stagingCtx.fillText(locationText, rightTextX, y += 25);
            stagingCtx.fillText(`Date        : ${sunsetDate.toLocaleDateString([], { timeZone: selectedTimezone })}`, rightTextX, y += 25);
            stagingCtx.fillText(`Topo Sunset : ${sunsetDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: selectedTimezone })}`, rightTextX, y += 25);
            stagingCtx.fillText(`Astro Sunset: ${formatTime(astronomicalTimes.sunset, selectedTimezone)}`, rightTextX, y += 25);
            stagingCtx.fillText(`Sunset Diff : ${formatTimeDiff(sunsetDiffMs)}`, rightTextX, y += 25);
            stagingCtx.fillText(`Total Lost  : ${formatTimeDiff(totalLostMs)}`, rightTextX, y += 25);
            stagingCtx.fillText(`Astro Total : ${formatDuration(astroTotalMs)}`, rightTextX, y += 25);
            stagingCtx.fillText(`Topo Total  : ${formatDuration(topoTotalMs)}`, rightTextX, y += 25);
            stagingCtx.fillText(`Cloud Cover : ${cloudPercentage}%`, rightTextX, y += 25);
            stagingCtx.fillText(`1kW Solar Est: ${solarGenEst.toFixed(2)} kWh`, rightTextX, y += 25);

            stagingCtx.fillStyle = '#f0f0f0'; stagingCtx.fillRect(exportWidth / 2 - 1, 0, 2, exportHeight);

            // Transfer the completed frame from staging to the recorded canvas
            tempCtx.drawImage(stagingCanvas, 0, 0);
        }

        currentFrame++; progressBar.style.width = `${(currentFrame / totalFrames) * 100}%`;
        frameInDay++; if (frameInDay >= framesPerDay) { frameInDay = 0; day++; }
        requestAnimationFrame(renderFrame);
    }

    renderFrame();
}

// --- Solar System Calculator ---
function calculateSolarRecommendations(dailyKwh, offGridPercent, overrideSunHours = null) {
    // Check for user override of effective sun hours
    let sunHoursForCalculation;
    let sunHoursSource = 'calculated';
    
    if (overrideSunHours !== null && overrideSunHours > 0) {
        // User provided override
        sunHoursForCalculation = overrideSunHours;
        sunHoursSource = 'user-override';
    } else if (worstDaySunlightHours !== null) {
        // Use worst day sunlight hours if available from monthly report
        sunHoursForCalculation = worstDaySunlightHours;
        sunHoursSource = 'worst-day';
    } else {
        // Fallback to current day's sunlight hours if no report has been generated
        let sunriseTime = currentSunTimes.topoSunrise || currentSunTimes.sunrise;
        let sunsetTime = currentSunTimes.topoSunset || currentSunTimes.sunset;
        
        // If no topo times available, calculate from astronomical times
        if (!sunriseTime || !sunsetTime) {
            const times = SunCalc.getTimes(selectedDate, currentLocation.lat, currentLocation.lon);
            sunriseTime = times.sunrise;
            sunsetTime = times.sunset;
        }
        
        const sunriseHour = sunriseTime.getHours() + sunriseTime.getMinutes() / 60;
        const sunsetHour = sunsetTime.getHours() + sunsetTime.getMinutes() / 60;
        sunHoursForCalculation = Math.max(0, sunsetHour - sunriseHour);
        sunHoursSource = 'current-day';
    }
    
    // Use topographic times for current day display
    let sunriseTime = currentSunTimes.topoSunrise || currentSunTimes.sunrise;
    let sunsetTime = currentSunTimes.topoSunset || currentSunTimes.sunset;
    
    // If no topo times available yet, calculate from astronomical times
    if (!sunriseTime || !sunsetTime) {
        const times = SunCalc.getTimes(selectedDate, currentLocation.lat, currentLocation.lon);
        sunriseTime = times.sunrise;
        sunsetTime = times.sunset;
    }
    
    // Calculate actual usable sun hours accounting for terrain occlusion
    const sunriseHour = sunriseTime.getHours() + sunriseTime.getMinutes() / 60;
    const sunsetHour = sunsetTime.getHours() + sunsetTime.getMinutes() / 60;
    const actualSunHours = Math.max(0, sunsetHour - sunriseHour);
    
    // Also calculate theoretical sun hours for comparison
    const times = SunCalc.getTimes(selectedDate, currentLocation.lat, currentLocation.lon);
    const theoreticalSunrise = times.sunrise.getHours() + times.sunrise.getMinutes() / 60;
    const theoreticalSunset = times.sunset.getHours() + times.sunset.getMinutes() / 60;
    const theoreticalSunHours = Math.max(0, theoreticalSunset - theoreticalSunrise);
    
    // Calculate terrain occlusion loss
    const occlusionLoss = theoreticalSunHours - actualSunHours;
    
    // Get actual cloud cover for this location and month
    let cloudCoverResult = getTypicalCloudCover(currentLocation.lat, selectedDate.getMonth() + 1);
    let cloudCoverSource = 'climatological';
    let cloudCoverPercent = cloudCoverResult;
    
    // If getAverageCloudCover has been called and returned source info, parse it
    // This is a fallback - the actual real-time call happens in getAverageCloudCover
    
    const cloudCoverFactor = (100 - cloudCoverPercent) / 100; // Convert cloud cover % to clear sky factor
    const effectiveSunHours = sunHoursForCalculation * cloudCoverFactor;
    
    // Energy requirement
    const targetEnergy = (dailyKwh * offGridPercent) / 100;
    
    // Conservative: 1.25x safety factor
    const conservativePanelSize = (targetEnergy * 1.25) / Math.max(effectiveSunHours, 1);
    const conservativeBattery = targetEnergy * 2; // 2 days of storage
    
    // Optimal: 1.5x safety factor
    const optimalPanelSize = (targetEnergy * 1.5) / Math.max(effectiveSunHours, 1);
    const optimalBattery = targetEnergy * 2.5; // 2.5 days of storage
    
    // Premium: 2.0x safety factor
    const premiumPanelSize = (targetEnergy * 2.0) / Math.max(effectiveSunHours, 1);
    const premiumBattery = targetEnergy * 3.5; // 3.5 days of storage
    
    const sunlightHours = currentLocation.lat > 0 ? 
        (new Date().getMonth() < 6 ? 'increasing' : 'decreasing') :
        (new Date().getMonth() < 6 ? 'decreasing' : 'increasing');
    
    return {
        theoreticalSunHours,
        actualSunHours,
        occlusionLoss,
        effectiveSunHours,
        targetEnergy,
        sunriseTime,
        sunsetTime,
        cloudCoverPercent,
        cloudCoverFactor,
        cloudCoverSource: cloudCoverSource,
        worstDaySunHours: worstDaySunlightHours,
        sunHoursSource: sunHoursSource,
        sunHoursForCalculation: sunHoursForCalculation,
        sunlightTrend: sunlightHours,
        recommendations: {
            conservative: {
                panelSize: conservativePanelSize,
                battery: conservativeBattery,
                description: 'Conservative: Higher safety margins, handles cloudy days'
            },
            optimal: {
                panelSize: optimalPanelSize,
                battery: optimalBattery,
                description: 'Optimal: Balanced cost and reliability'
            },
            premium: {
                panelSize: premiumPanelSize,
                battery: premiumBattery,
                description: 'Premium: Maximum reliability, handles extended poor weather'
            }
        }
    };
}

// --- Event Listeners ---
document.getElementById('terrain-detail-picker').addEventListener('input', (e) => {
    const newZoom = parseInt(e.target.value);
    if (newZoom !== mapZoom) {
        mapZoom = newZoom;
        mappingManager.updateMapState(currentLocation, mapZoom);
        updateAll();
    }
});

document.getElementById('map-layer-picker').addEventListener('input', (e) => {
    switchMapLayer(e.target.value);
});

document.getElementById('jump-to-sunrise').addEventListener('click', () => jumpToTime(currentSunTimes.sunrise));
document.getElementById('jump-to-topo-sunrise').addEventListener('click', () => jumpToTime(currentSunTimes.topoSunrise));
document.getElementById('jump-to-sunset').addEventListener('click', () => jumpToTime(currentSunTimes.sunset));
document.getElementById('jump-to-topo-sunset').addEventListener('click', () => jumpToTime(currentSunTimes.topoSunset));

document.getElementById('timezone-picker').addEventListener('input', (e) => {
    selectedTimezone = e.target.value;
    updateInfoDisplay();
    calculateTopoTimes();
    updateUrlWithState();
});

document.getElementById('date-picker').addEventListener('input', (e) => {
    const [year, month, day] = e.target.value.split('-').map(Number);
    const parts = getPartsInTimezone(selectedDate, selectedTimezone);

    const currentDate = Date.UTC(parts.year, parts.month - 1, parts.day);
    const newDate = Date.UTC(year, month - 1, day);
    const dayDiff = Math.round((newDate - currentDate) / (1000 * 60 * 60 * 24));

    const tentativeDate = new Date(selectedDate.getTime() + dayDiff * 24 * 60 * 60 * 1000);
    const finalParts = getPartsInTimezone(tentativeDate, selectedTimezone);
    const hourDiff = parts.hour - finalParts.hour;

    if (hourDiff !== 0) {
        tentativeDate.setTime(tentativeDate.getTime() + hourDiff * 60 * 60 * 1000);
    }
    selectedDate = tentativeDate;

    updateInfoDisplay();
    updateSunPosition();
    calculateTopoTimes();
    debouncedUpdateUrl();
});

document.getElementById('date-slider').addEventListener('input', (e) => {
    const dayOfYear = parseInt(e.target.value);
    const currentDayOfYear = getDayOfYear(selectedDate, selectedTimezone);
    const dayDiff = dayOfYear - currentDayOfYear;

    const tentativeDate = new Date(selectedDate.getTime() + dayDiff * 24 * 60 * 60 * 1000);
    
    const parts = getPartsInTimezone(selectedDate, selectedTimezone);
    const finalParts = getPartsInTimezone(tentativeDate, selectedTimezone);
    const hourDiff = parts.hour - finalParts.hour;

    if (hourDiff !== 0) {
        tentativeDate.setTime(tentativeDate.getTime() + hourDiff * 60 * 60 * 1000);
    }
    selectedDate = tentativeDate;

    updateSunPosition();
    updateInfoDisplay();
    calculateTopoTimes();
    debouncedUpdateUrl();
});

document.getElementById('time-slider').addEventListener('input', (e) => {
    const totalMinutes = parseInt(e.target.value);
    const newHour = Math.floor(totalMinutes / 60);
    const newMinute = totalMinutes % 60;

    const parts = getPartsInTimezone(selectedDate, selectedTimezone);
    const hDiff = newHour - parts.hour;
    const mDiff = newMinute - parts.minute;

    const tentativeDate = new Date(selectedDate.getTime() + (hDiff * 60 + mDiff) * 60000);
    
    const finalParts = getPartsInTimezone(tentativeDate, selectedTimezone);
    const errorMinutes = (finalParts.hour * 60 + finalParts.minute) - (newHour * 60 + newMinute);
    
    if (errorMinutes !== 0) {
        tentativeDate.setTime(tentativeDate.getTime() - errorMinutes * 60000);
    }
    selectedDate = tentativeDate;

    updateSunPosition();
    updateInfoDisplay();
    debouncedUpdateUrl();
});

document.getElementById('toggle-controls-btn').addEventListener('click', () => {
    const controlsPanel = document.getElementById('controls');
    controlsPanel.classList.toggle('collapsed');
});

document.getElementById('export-split-btn').addEventListener('click', () => exportSplitScreenVideo());

document.getElementById('compass').addEventListener('click', () => {
    const distance = controls.object.position.distanceTo(controls.target);
    const polarAngle = controls.getPolarAngle();
    
    controls.target.set(0,0,0);
    camera.position.set(
        0, 
        distance * Math.sin(polarAngle), 
        distance * Math.cos(polarAngle)
    );
    controls.update();
});

document.getElementById('open-solar-btn').addEventListener('click', () => {
    const solarPanel = document.getElementById('solar-panel');
    solarPanel.style.display = 'block';
    updateSunHoursInfo();
});

document.getElementById('close-solar-btn').addEventListener('click', () => {
    const solarPanel = document.getElementById('solar-panel');
    solarPanel.style.display = 'none';
});

// Update sun hours info when override input changes
document.getElementById('effective-sun-hours-override').addEventListener('input', updateSunHoursInfo);

function updateSunHoursInfo() {
    const overrideValue = document.getElementById('effective-sun-hours-override').value;
    const infoElement = document.getElementById('sun-hours-info');
    
    if (overrideValue) {
        infoElement.textContent = `✓ Using custom value: ${overrideValue} hours`;
        infoElement.style.color = '#d32f2f';
    } else {
        // Show calculated value
        let calculatedHours = null;
        if (worstDaySunlightHours !== null && worstDaySunlightHours > 0) {
            calculatedHours = worstDaySunlightHours;
            infoElement.textContent = `📊 Calculated from worst day: ${worstDaySunlightHours.toFixed(1)} hours`;
            infoElement.style.color = '#2e7d32';
        } else if (currentSunTimes.topoSunrise instanceof Date && currentSunTimes.topoSunset instanceof Date) {
            const sunriseHour = currentSunTimes.topoSunrise.getHours() + currentSunTimes.topoSunrise.getMinutes() / 60;
            const sunsetHour = currentSunTimes.topoSunset.getHours() + currentSunTimes.topoSunset.getMinutes() / 60;
            calculatedHours = Math.max(0, sunsetHour - sunriseHour);
            if (calculatedHours > 0) {
                infoElement.textContent = `📊 Calculated from today: ${calculatedHours.toFixed(1)} hours`;
                infoElement.style.color = '#666';
            } else {
                infoElement.textContent = 'Generate monthly report for best sizing';
                infoElement.style.color = '#f57c00';
            }
        } else {
            infoElement.textContent = 'Generate monthly report for best sizing';
            infoElement.style.color = '#f57c00';
        }
    }
}

document.getElementById('calculate-solar-btn').addEventListener('click', async () => {
    const dailyKwh = parseFloat(document.getElementById('daily-kwh').value);
    const offGridPercent = parseFloat(document.getElementById('offgrid-percent').value);
    const overrideSunHours = document.getElementById('effective-sun-hours-override').value ? 
        parseFloat(document.getElementById('effective-sun-hours-override').value) : null;
    
    if (isNaN(dailyKwh) || dailyKwh <= 0 || isNaN(offGridPercent) || offGridPercent < 0 || offGridPercent > 100) {
        alert('Please enter valid values for daily power requirement and off-grid percentage');
        return;
    }
    
    if (overrideSunHours !== null && (isNaN(overrideSunHours) || overrideSunHours <= 0)) {
        alert('If provided, override sun hours must be a positive number');
        return;
    }
    
    // If monthly report hasn't been generated yet, generate it automatically
    if (worstDaySunlightHours === null && overrideSunHours === null) {
        console.log('Generating monthly report for worst-case solar sizing...');
        // Generate report silently without showing UI elements, but show a status
        const originalDisplay = document.getElementById('solar-results').innerHTML;
        document.getElementById('solar-results').innerHTML = '<p style="color: #f57c00;">⏳ Generating monthly report for worst-case sizing...</p>';
        
        try {
            await generateMonthlyReport(false);
            document.getElementById('solar-results').innerHTML = originalDisplay;
        } catch (error) {
            console.error('Error generating monthly report:', error);
            document.getElementById('solar-results').innerHTML = '<p style="color: #d32f2f;">Error generating report. Using current day calculations.</p>';
        }
    }
    
    const results = calculateSolarRecommendations(dailyKwh, offGridPercent, overrideSunHours);
    displaySolarResults(results);
});

function displaySolarResults(results) {
    let html = `
        <div style="margin-bottom: 15px; padding: 10px; background-color: #e3f2fd; border-radius: 5px;">
            <p><strong>Location Info:</strong></p>
            <p>📍 ${currentLocation.name || 'Selected Location'}</p>
    `;
    
    // Show sun hours information with source indicator
    let sourceLabel = '';
    if (results.sunHoursSource === 'user-override') {
        sourceLabel = ' (user-defined override ✏️)';
        html += `<p style="color: #d32f2f; font-weight: bold;">⚠️ Using custom override value: <strong>${results.sunHoursForCalculation.toFixed(1)}</strong> hours${sourceLabel}</p>`;
    } else if (results.worstDaySunHours !== null && results.sunHoursSource === 'worst-day') {
        html += `<p>🏔️ Worst day sunlight: <strong>${results.worstDaySunHours.toFixed(1)}</strong> hours (from monthly report)</p>
            <p style="color: #666; font-size: 0.9em;">System sized for the worst conditions to ensure year-round reliability</p>`;
    } else {
        html += `<p>Current day sunlight: <strong>${results.actualSunHours.toFixed(1)}</strong> hours</p>
            <p style="color: #f57c00; font-size: 0.9em;">Generate a monthly report for worst-case sizing</p>`;
    }
    
    // Show topographic analysis if available
    if (results.occlusionLoss > 0.01) {
        html += `
            <p>Theoretical daylight: <strong>${results.theoreticalSunHours.toFixed(1)}</strong> hours</p>
            <p>Current day actual sunlight: <strong>${results.actualSunHours.toFixed(1)}</strong> hours</p>
            <p>Terrain shadowing loss: <strong>${results.occlusionLoss.toFixed(1)}</strong> hours/day (${((results.occlusionLoss / results.theoreticalSunHours) * 100).toFixed(0)}%)</p>
            <p>Sunrise: <strong>${results.sunriseTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}</strong></p>
            <p>Sunset: <strong>${results.sunsetTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}</strong></p>
        `;
    }
    
    html += `
            <p>Cloud cover: <strong>${results.cloudCoverPercent}%</strong> (${results.cloudCoverSource === 'real-time' ? '🌐 Real-time' : '📊 Climatological'}) (Clear sky factor: ${(results.cloudCoverFactor * 100).toFixed(0)}%)</p>
            <p>Effective sun hours (accounting for ${results.worstDaySunHours !== null ? 'worst day & clouds' : 'terrain & clouds'}): <strong>${results.effectiveSunHours.toFixed(1)}</strong> hours</p>
            <p>Target daily energy: <strong>${results.targetEnergy.toFixed(2)}</strong> kWh</p>
            <p>Sunlight trend: <strong>${results.sunlightTrend}</strong></p>
        </div>
    `;
    
    for (const [key, rec] of Object.entries(results.recommendations)) {
        html += `
            <div class="solar-recommendation">
                <h4>${rec.description}</h4>
                <div class="solar-recommendation-item">
                    Solar Panel Capacity: <strong>${rec.panelSize.toFixed(2)} kW</strong>
                    <br><small>(${(rec.panelSize * 1000).toFixed(0)} watts)</small>
                </div>
                <div class="solar-recommendation-item">
                    Battery Storage: <strong>${rec.battery.toFixed(2)} kWh</strong>
                    <br><small>(Approx ${(rec.battery / 12).toFixed(1)} × 12kWh batteries)</small>
                </div>
            </div>
        `;
    }
    
    html += `
        <div style="margin-top: 15px; padding: 10px; background-color: #fff3cd; border-radius: 5px; font-size: 12px;">
            <strong>Note:</strong> These estimates account for:
            <ul style="margin: 5px 0;">
                <li>🏔️ Terrain occlusion (local topography blocking sunlight)</li>
                <li>☁️ Cloud cover (climatological data for your location and month)</li>
                <li>📅 Worst-case day sunlight (from annual report for reliability)</li>
                <li>Panel orientation and tilt angle (not yet optimized)</li>
            </ul>
        </div>
    `;
    
    document.getElementById('solar-results').innerHTML = html;
}

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Export Functionality ---
function exportLandscape() {
    const exportWidth = 1920;
    const exportHeight = 1080;

    // Store original size
    const originalWidth = canvas.width;
    const originalHeight = canvas.height;

    // Resize for export
    renderer.setSize(exportWidth, exportHeight);
    camera.aspect = exportWidth / exportHeight;
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);

    const sourceCanvas = renderer.domElement;
    
    const location = `Location: ${document.getElementById('location-coords').textContent}`;
    const sunrise = `Sunrise: ${formatTime(SunCalc.getTimes(selectedDate, currentLocation.lat, currentLocation.lon).sunrise, selectedTimezone)}`;
    const topoSunrise = `Topo Sunrise: ${document.getElementById('topo-sunrise-time').textContent}`;
    const sunset = `Sunset: ${formatTime(SunCalc.getTimes(selectedDate, currentLocation.lat, currentLocation.lon).sunset, selectedTimezone)}`;
    const topoSunset = `Topo Sunset: ${document.getElementById('topo-sunset-time').textContent}`;
    const date = `Date: ${selectedDate.toLocaleDateString([], { timeZone: selectedTimezone })}`;
    const time = `Time: ${selectedDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: selectedTimezone })}`;
    const timezoneText = `Timezone: ${selectedTimezone.replace(/_/g, ' ')}`;

    const textLines = [date, time, timezoneText, location, sunrise, topoSunrise, sunset, topoSunset];
    const lineHeight = 24;
    const textMargin = 15;
    const panelWidth = 400;
    const panelHeight = textLines.length * lineHeight + textMargin;

    const tempCanvas = document.createElement('canvas');
    const tempCtx = tempCanvas.getContext('2d');

    tempCanvas.width = exportWidth;
    tempCanvas.height = exportHeight;

    // Draw the rendered scene
    tempCtx.drawImage(sourceCanvas, 0, 0);

    // Draw the semi-opaque panel
    tempCtx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    tempCtx.fillRect(0, 0, panelWidth, panelHeight);

    // Draw the text
    tempCtx.fillStyle = '#f0f0f0';
    tempCtx.font = `20px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
    tempCtx.textAlign = 'left';

    textLines.forEach((line, index) => {
        tempCtx.fillText(line, textMargin, textMargin + (index * lineHeight) + lineHeight / 2);
    });

    const finalDataURL = tempCanvas.toDataURL('image/png');

    // Restore original size
    renderer.setSize(originalWidth, originalHeight);
    camera.aspect = originalWidth / originalHeight;
    camera.updateProjectionMatrix();

    const filename = `landscape-${new Date().toISOString().replace(/:/g, '-')}.png`;

    const link = document.createElement('a');
    link.href = finalDataURL;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// --- Animation Loop ---
function animate() {
    requestAnimationFrame(animate);

    controls.update();

    if (cloudMaterial) {
        cloudMaterial.uniforms.uTime.value += 0.01;
        if (sunLight) {
            cloudMaterial.uniforms.uSunPosition.value.copy(sunLight.position);
        }
    }

    // Prevent camera and target from going below ground during user navigation
    if (controls.enabled) {
        const tileWorldSize = getTileWorldSizeForZoom(mapZoom);
        const gridRadius = getGridRadiusForZoom(mapZoom);
        // 1. Clamp pan target to stay within the terrain grid bounds
        const gridHalfSize = (gridRadius + 0.5) * tileWorldSize;
        const minX = terrainGrid.position.x - gridHalfSize;
        const maxX = terrainGrid.position.x + gridHalfSize;
        const minZ = terrainGrid.position.z - gridHalfSize;
        const maxZ = terrainGrid.position.z + gridHalfSize;
        controls.target.x = THREE.MathUtils.clamp(controls.target.x, minX, maxX);
        controls.target.z = THREE.MathUtils.clamp(controls.target.z, minZ, maxZ);

        // Also clamp the camera's position to the same bounds to prevent it from going off the side
        camera.position.x = THREE.MathUtils.clamp(camera.position.x, minX, maxX);
        camera.position.z = THREE.MathUtils.clamp(camera.position.z, minZ, maxZ);

        // 2. Adjust camera position to prevent going through terrain
        const cameraTerrainHeight = getTerrainHeightAt(camera.position.x, camera.position.z);
        if (isFinite(cameraTerrainHeight)) {
            const minCameraHeight = cameraTerrainHeight + 0.5; // Keep camera 0.5 units above terrain
            if (camera.position.y < minCameraHeight) {
                camera.position.y = minCameraHeight;
            }
        }

        // 3. Adjust control target's height to ride on the terrain surface
        const targetTerrainHeight = getTerrainHeightAt(controls.target.x, controls.target.z);
        if (isFinite(targetTerrainHeight) && controls.target.y < targetTerrainHeight) {
            controls.target.y = targetTerrainHeight;
        }
    }

    const azimuth = controls.getAzimuthalAngle();
    const rotationDegrees = THREE.MathUtils.radToDeg(azimuth);
    document.getElementById('compass-needle').style.transform = `rotate(${-rotationDegrees}deg)`;
    renderer.render(scene, camera);
}

function switchMapLayer(layerKey) {
    if (layerKey === currentMapLayer) return;

    mappingManager.switchMapLayer(layerKey, (newLayer) => {
        currentMapLayer = newLayer;
        lastTerrainLocation = { lat: null, lon: null }; // Force terrain reload
        updateTerrain();
        updateUrlWithState();
    });

    // Force terrain to reload with new textures
    lastTerrainLocation = { lat: null, lon: null };
    updateTerrain();

    updateUrlWithState();
}

function updateAll() {
    terrainHeightData = {}; // Clear height data on location change
    lastTerrainLocation = { lat: null, lon: null }; // Force terrain reload even if location hasn't changed

    // Invalidate cache if location changed
    if (topoTimesCache.lat !== currentLocation.lat || topoTimesCache.lon !== currentLocation.lon) {
        topoTimesCache = { lat: null, lon: null, year: null, data: {} };
    }

    // Clear and hide the report panel on location change
    reportPanel.style.display = 'none';
    reportTableContainer.innerHTML = '<p>Generating report... This may take a moment.</p>';

    updateInfoDisplay();
    updateTerrain();
    updateUrlWithState();
}

function synchronizeTileBoundaries(gridRadius) {
    // Synchronize height values at tile edges to ensure seamless connections
    const gridSize = 256; // Each heightmap is 256x256 vertices

    for (let i = -gridRadius; i <= gridRadius; i++) {
        for (let j = -gridRadius; j <= gridRadius; j++) {
            const tileName = `tile_${i}_${j}`;
            const tile = terrainGrid.getObjectByName(tileName);
            if (!tile) continue;

            const vertices = tile.geometry.attributes.position;
            const geometry = tile.geometry;
            const { topVerticesCount, edgeToSkirtMap, skirtDepth } = geometry.userData;
            let needsUpdate = false;

            // Synchronize with right neighbor (positive X direction)
            if (j < gridRadius) {
                const rightTileName = `tile_${i}_${j + 1}`;
                const rightTile = terrainGrid.getObjectByName(rightTileName);
                if (rightTile) {
                    const rightVertices = rightTile.geometry.attributes.position;
                    // Average the heights at the boundary
                    for (let iy = 0; iy < gridSize; iy++) {
                        const thisEdgeIndex = iy * gridSize + (gridSize - 1); // Right edge of this tile
                        const rightEdgeIndex = iy * gridSize; // Left edge of right tile

                        const thisHeight = vertices.getZ(thisEdgeIndex);
                        const rightHeight = rightVertices.getZ(rightEdgeIndex);
                        const avgHeight = (thisHeight + rightHeight) / 2;

                        vertices.setZ(thisEdgeIndex, avgHeight);
                        rightVertices.setZ(rightEdgeIndex, avgHeight);

                        // Update skirt vertices
                        if (edgeToSkirtMap && edgeToSkirtMap.has(thisEdgeIndex)) {
                            const skirtIndex = edgeToSkirtMap.get(thisEdgeIndex);
                            vertices.setZ(topVerticesCount + skirtIndex, avgHeight - skirtDepth);
                        }
                    }
                    rightVertices.needsUpdate = true;
                    needsUpdate = true;
                }
            }

            // Synchronize with bottom neighbor (positive Z direction)
            if (i < gridRadius) {
                const bottomTileName = `tile_${i + 1}_${j}`;
                const bottomTile = terrainGrid.getObjectByName(bottomTileName);
                if (bottomTile) {
                    const bottomVertices = bottomTile.geometry.attributes.position;
                    // Average the heights at the boundary
                    for (let ix = 0; ix < gridSize; ix++) {
                        const thisEdgeIndex = (gridSize - 1) * gridSize + ix; // Bottom edge of this tile
                        const bottomEdgeIndex = ix; // Top edge of bottom tile

                        const thisHeight = vertices.getZ(thisEdgeIndex);
                        const bottomHeight = bottomVertices.getZ(bottomEdgeIndex);
                        const avgHeight = (thisHeight + bottomHeight) / 2;

                        vertices.setZ(thisEdgeIndex, avgHeight);
                        bottomVertices.setZ(bottomEdgeIndex, avgHeight);

                        // Update skirt vertices
                        if (edgeToSkirtMap && edgeToSkirtMap.has(thisEdgeIndex)) {
                            const skirtIndex = edgeToSkirtMap.get(thisEdgeIndex);
                            vertices.setZ(topVerticesCount + skirtIndex, avgHeight - skirtDepth);
                        }
                    }
                    bottomVertices.needsUpdate = true;
                    needsUpdate = true;
                }
            }

            if (needsUpdate) {
                vertices.needsUpdate = true;
                tile.geometry.computeVertexNormals();
            }
        }
    }

    // Stitch normals at tile boundaries for smooth lighting transitions
    stitchTileNormals(gridRadius);
}

function stitchTileNormals(gridRadius) {
    // Share averaged normal vectors at tile edges for seamless lighting
    const gridSize = 256;
    
    for (let i = -gridRadius; i <= gridRadius; i++) {
        for (let j = -gridRadius; j <= gridRadius; j++) {
            const tileName = `tile_${i}_${j}`;
            const tile = terrainGrid.getObjectByName(tileName);
            if (!tile) continue;
            
            const normals = tile.geometry.attributes.normal;
            const geometry = tile.geometry;
            const { topVerticesCount } = geometry.userData;
            
            // Stitch with right neighbor
            if (j < gridRadius) {
                const rightTileName = `tile_${i}_${j + 1}`;
                const rightTile = terrainGrid.getObjectByName(rightTileName);
                if (rightTile) {
                    const rightNormals = rightTile.geometry.attributes.normal;
                    
                    for (let iy = 0; iy < gridSize; iy++) {
                        const thisEdgeIndex = iy * gridSize + (gridSize - 1); // Right edge
                        const rightEdgeIndex = iy * gridSize; // Left edge of right tile
                        
                        // Average the normals
                        const thisNx = normals.getX(thisEdgeIndex);
                        const thisNy = normals.getY(thisEdgeIndex);
                        const thisNz = normals.getZ(thisEdgeIndex);
                        
                        const rightNx = rightNormals.getX(rightEdgeIndex);
                        const rightNy = rightNormals.getY(rightEdgeIndex);
                        const rightNz = rightNormals.getZ(rightEdgeIndex);
                        
                        const avgNx = (thisNx + rightNx) / 2;
                        const avgNy = (thisNy + rightNy) / 2;
                        const avgNz = (thisNz + rightNz) / 2;
                        
                        const length = Math.sqrt(avgNx * avgNx + avgNy * avgNy + avgNz * avgNz);
                        const normNx = avgNx / length;
                        const normNy = avgNy / length;
                        const normNz = avgNz / length;
                        
                        // Apply averaged normal to both tiles
                        normals.setXYZ(thisEdgeIndex, normNx, normNy, normNz);
                        rightNormals.setXYZ(rightEdgeIndex, normNx, normNy, normNz);
                    }
                    rightNormals.needsUpdate = true;
                }
            }
            
            // Stitch with bottom neighbor
            if (i < gridRadius) {
                const bottomTileName = `tile_${i + 1}_${j}`;
                const bottomTile = terrainGrid.getObjectByName(bottomTileName);
                if (bottomTile) {
                    const bottomNormals = bottomTile.geometry.attributes.normal;
                    
                    for (let ix = 0; ix < gridSize; ix++) {
                        const thisEdgeIndex = (gridSize - 1) * gridSize + ix; // Bottom edge
                        const bottomEdgeIndex = ix; // Top edge of bottom tile
                        
                        // Average the normals
                        const thisNx = normals.getX(thisEdgeIndex);
                        const thisNy = normals.getY(thisEdgeIndex);
                        const thisNz = normals.getZ(thisEdgeIndex);
                        
                        const bottomNx = bottomNormals.getX(bottomEdgeIndex);
                        const bottomNy = bottomNormals.getY(bottomEdgeIndex);
                        const bottomNz = bottomNormals.getZ(bottomEdgeIndex);
                        
                        const avgNx = (thisNx + bottomNx) / 2;
                        const avgNy = (thisNy + bottomNy) / 2;
                        const avgNz = (thisNz + bottomNz) / 2;
                        
                        const length = Math.sqrt(avgNx * avgNx + avgNy * avgNy + avgNz * avgNz);
                        const normNx = avgNx / length;
                        const normNy = avgNy / length;
                        const normNz = avgNz / length;
                        
                        // Apply averaged normal to both tiles
                        normals.setXYZ(thisEdgeIndex, normNx, normNy, normNz);
                        bottomNormals.setXYZ(bottomEdgeIndex, normNx, normNy, normNz);
                    }
                    bottomNormals.needsUpdate = true;
                }
            }
            
            normals.needsUpdate = true;
        }
    }
}

// --- Report Generation ---
const reportPanel = document.getElementById('report-panel');
const toggleReportBtn = document.getElementById('toggle-report-btn');
const generateReportBtn = document.getElementById('generate-report-btn');
const reportTableContainer = document.getElementById('report-table-container');

// Store worst day sunlight hours for solar calculations
let worstDaySunlightHours = null;

toggleReportBtn.addEventListener('click', () => {
    reportPanel.classList.toggle('collapsed');
});

// Extract report generation logic into reusable function
async function generateMonthlyReport(showUI = true) {
    console.log('Starting report generation with showUI:', showUI);
    
    if (showUI) {
        reportPanel.style.display = 'block';
        reportPanel.classList.remove('collapsed');
    }

    const loader = document.getElementById('loader');
    const loaderText = document.getElementById('loader-text');
    const progressBar = document.getElementById('progress-bar');

    loaderText.textContent = 'Creating report...';
    progressBar.style.width = '0%';
    if (showUI) loader.style.display = 'block';

    // Yield to the event loop to allow the loader to render before heavy computation.
    await new Promise(resolve => setTimeout(resolve, 0));

    const year = selectedDate.getFullYear();
    const isNorthernHemisphere = currentLocation.lat > 0;

    const summerSolstice = isNorthernHemisphere ? new Date(year, 5, 21) : new Date(year, 11, 21);
    const winterSolstice = isNorthernHemisphere ? new Date(year, 11, 21) : new Date(year, 5, 21);

    const reportData = [];
    const solsticeData = await Promise.all([
        getReportDataForDate(summerSolstice, 'Summer Solstice'),
        getReportDataForDate(winterSolstice, 'Winter Solstice')
    ]);
    reportData.push(...solsticeData);

    const dates = [];
    for (let i = 0; i < 12; i++) {
        const date = new Date(year, i, 1);
        dates.push(date);
    }

    for (let i = 0; i < dates.length; i++) {
        const date = dates[i];
        const data = await getReportDataForDate(date);
        reportData.push(data);
        if (showUI) progressBar.style.width = `${((i + 2) / (dates.length + 2)) * 100}%`;
    }

    console.log('Report data collected, length:', reportData.length);
    console.log('First few entries:', reportData.slice(0, 3));
    
    // Calculate worst day sunlight hours from report data
    calculateWorstDaySunlight(reportData);
    
    if (showUI) {
        renderReportTable(reportData);
        loader.style.display = 'none';
    }
    
    return reportData;
}

generateReportBtn.addEventListener('click', async () => {
    await generateMonthlyReport(true);
});

function formatTimeDiff(ms) {
    if (isNaN(ms)) return 'N/A';
    const sign = ms < 0 ? '-' : '+';
    const delta = Math.abs(ms);
    const minutes = Math.floor((delta / (1000 * 60)) % 60);
    const hours = Math.floor(delta / (1000 * 60 * 60));
    return `${sign}${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

function formatDuration(ms) {
    if (isNaN(ms) || ms < 0) return '00:00';
    const delta = Math.abs(ms);
    const minutes = Math.floor((delta / (1000 * 60)) % 60);
    const hours = Math.floor(delta / (1000 * 60 * 60));
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

async function getReportDataForDate(date, customLabel) {
    const times = SunCalc.getTimes(date, currentLocation.lat, currentLocation.lon);
    
    const topoSunrise = await findTopoTime(times.sunrise, times.solarNoon, true);
    const topoSunset = await findTopoTime(times.solarNoon, times.sunset, false);

    const sunriseLossMs = (topoSunrise && times.sunrise && !isNaN(topoSunrise) && !isNaN(times.sunrise)) ? topoSunrise.getTime() - times.sunrise.getTime() : 0;
    const sunsetLossMs = (times.sunset && topoSunset && !isNaN(times.sunset) && !isNaN(topoSunset)) ? times.sunset.getTime() - topoSunset.getTime() : 0;
    const totalLossMs = Math.max(0, sunriseLossMs) + Math.max(0, sunsetLossMs);
    const astroTotalMs = (times.sunset && times.sunrise) ? times.sunset.getTime() - times.sunrise.getTime() : 0;
    const topoTotalMs = (topoSunset && topoSunrise) ? topoSunset.getTime() - topoSunrise.getTime() : 0;

    const fullDateString = date.toLocaleString('default', { day: 'numeric', month: 'long', year: 'numeric' });

    const dateString = customLabel ? `${customLabel} (${fullDateString})` : fullDateString;

    // Fetch cloud cover data
    const cloudCover = await getAverageCloudCover(date.getMonth() + 1);
    
    let cloudPercentage = 50;
    if (typeof cloudCover === 'string') {
        const parts = cloudCover.split('%');
        if (parts.length > 0) cloudPercentage = parseInt(parts[0]) || 0;
    }
    
    const solarGenEst = (topoTotalMs / (1000 * 60 * 60)) * (1.0 - cloudPercentage / 100.0);

    return {
        date: dateString,
        astroSunrise: times.sunrise,
        topoSunrise: topoSunrise,
        sunriseLoss: formatDuration(sunriseLossMs),
        astroSunset: times.sunset,
        topoSunset: topoSunset,
        sunsetLoss: formatDuration(sunsetLossMs),
        totalLoss: formatDuration(totalLossMs),
        astroTotal: formatDuration(astroTotalMs),
        topoTotal: formatDuration(topoTotalMs),
        cloudCover: cloudCover,
        solarGenEst: solarGenEst.toFixed(2) + ' kWh'
    };
}

// Cloud cover caching now persisted to IndexedDB via `dataManager.getKV` / `dataManager.saveKV`.

// Calculate the worst day (minimum sunlight hours) from report data
function calculateWorstDaySunlight(reportData) {
    console.log('calculateWorstDaySunlight called with', reportData.length, 'data points');
    let minSunlightHours = Infinity;
    let validDayCount = 0;
    const dayDetails = [];
    
    for (const data of reportData) {
        console.log('Checking data entry:', data.date, 'sunrise:', data.topoSunrise, 'sunset:', data.topoSunset);
        
        // Check if topoSunrise and topoSunset are valid Date objects
        if (data.topoSunrise instanceof Date && data.topoSunset instanceof Date && 
            !isNaN(data.topoSunrise.getTime()) && !isNaN(data.topoSunset.getTime())) {
            const sunriseHour = data.topoSunrise.getHours() + data.topoSunrise.getMinutes() / 60;
            let sunsetHour = data.topoSunset.getHours() + data.topoSunset.getMinutes() / 60;
            
            // If sunset is on a different day than sunrise, add 24 hours
            if (data.topoSunset.getDate() !== data.topoSunrise.getDate()) {
                sunsetHour += 24;
            }
            
            const sunlightHours = Math.max(0, sunsetHour - sunriseHour);
            
            dayDetails.push({
                date: data.date,
                hours: sunlightHours,
                sunrise: data.topoSunrise.toLocaleTimeString(),
                sunset: data.topoSunset.toLocaleTimeString(),
                sunriseHour: sunriseHour.toFixed(2),
                sunsetHour: sunsetHour.toFixed(2)
            });
            
            validDayCount++;
            if (sunlightHours < minSunlightHours) {
                minSunlightHours = sunlightHours;
            }
        }
    }
    
    console.log(`Worst day calculation: ${validDayCount} valid days analyzed`);
    console.log('Day details:', dayDetails);
    console.log(`Worst day: ${minSunlightHours === Infinity ? 'N/A' : minSunlightHours.toFixed(1)} hours`);
    worstDaySunlightHours = minSunlightHours === Infinity ? null : minSunlightHours;
    console.log('worstDaySunlightHours global set to:', worstDaySunlightHours);
}

// Typical cloud cover percentages by latitude zone and month
function getTypicalCloudCover(latitude, month) {
    // Determine climate zone based on latitude
    const absLat = Math.abs(latitude);
    let cloudByMonth;
    
    if (absLat < 10) {
        // Tropical (0-10°)
        cloudByMonth = [75, 73, 70, 68, 72, 80, 85, 85, 82, 78, 75, 76];
    } else if (absLat < 23.5) {
        // Subtropical (10-23.5°)
        cloudByMonth = [65, 62, 58, 55, 58, 65, 70, 72, 68, 62, 60, 65];
    } else if (absLat < 35) {
        // Warm temperate (23.5-35°)
        cloudByMonth = [58, 55, 50, 48, 50, 55, 60, 60, 55, 52, 55, 60];
    } else if (absLat < 45) {
        // Temperate (35-45°) - Melbourne is around -37.8°
        cloudByMonth = [55, 52, 48, 45, 48, 52, 55, 55, 52, 55, 58, 60];
    } else if (absLat < 60) {
        // Cold temperate (45-60°)
        cloudByMonth = [60, 58, 55, 52, 52, 55, 58, 58, 58, 62, 65, 68];
    } else {
        // Polar (60°+)
        cloudByMonth = [70, 68, 65, 60, 58, 60, 65, 68, 70, 72, 75, 75];
    }
    
    return cloudByMonth[month - 1];
}

async function getAverageCloudCover(month) {
    try {
        const cacheKey = `${currentLocation.lat.toFixed(2)}_${currentLocation.lon.toFixed(2)}_${month}`;

        // Try in-memory cache first
        if (cloudCoverInMemoryCache[cacheKey]) {
            return cloudCoverInMemoryCache[cacheKey];
        }

        // Try IndexedDB cache second
        try {
            const cached = await dataManager.getKV(cacheKey);
            if (cached) {
                cloudCoverInMemoryCache[cacheKey] = cached;
                return cached;
            }
        } catch (e) {
            console.warn('IndexedDB cache unavailable, falling back to in-memory behavior', e);
        }

        // Try to fetch real cloud cover data from Open-Meteo API (free, no API key required)
        let cloudCover = null;
        let dataSource = 'climatological';

        try {
            const lat = currentLocation.lat;
            const lon = currentLocation.lon;

            // Open-Meteo API - free with no key required
            const response = await fetch(
                `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=cloudcover&timezone=auto`
            );

            if (response.ok) {
                const data = await response.json();
                if (data.current && data.current.cloudcover !== undefined) {
                    const currentClouds = data.current.cloudcover;
                    const climateClouds = getTypicalCloudCover(lat, month);
                    // Weight: 30% current, 70% climatological for better estimate
                    cloudCover = Math.round(currentClouds * 0.3 + climateClouds * 0.7);
                    dataSource = 'real-time';
                    console.log(`Cloud cover for ${currentLocation.name || 'selected location'}: ${cloudCover}% (${dataSource} via Open-Meteo, blended with climatological)`);
                }
            }
        } catch (apiError) {
            console.log('Open-Meteo API unavailable, using climatological data:', apiError.message);
        }

        // Fallback to climatological if API fails
        if (cloudCover === null) {
            cloudCover = getTypicalCloudCover(currentLocation.lat, month);
            dataSource = 'climatological';
        }

        const result = `${cloudCover}%|${dataSource}`;
        cloudCoverInMemoryCache[cacheKey] = result;

        // Persist to IndexedDB (fire-and-forget)
        try {
            dataManager.saveKV(cacheKey, result);
        } catch (e) {
            console.warn('Failed to persist cloud cover to IndexedDB', e);
        }

        return result;
    } catch (error) {
        console.error('Error calculating cloud cover data:', error);
        return 'N/A|error';
    }
}

/**
 * Synchronous version of getAverageCloudCover.
 * Returns cached value if available, otherwise falls back to climatological data immediately.
 */
function getAverageCloudCoverSync(month) {
    const cacheKey = `${currentLocation.lat.toFixed(2)}_${currentLocation.lon.toFixed(2)}_${month}`;
    if (cloudCoverInMemoryCache[cacheKey]) {
        return cloudCoverInMemoryCache[cacheKey];
    }
    // Synchronous fallback
    const cloudCover = getTypicalCloudCover(currentLocation.lat, month);
    return `${cloudCover}%|climatological`;
}

function renderReportTable(data) {
    let tableHTML = '<table><thead><tr>' +
        '<th>Date</th>' +
        '<th>Astro Sunrise</th><th>Topo Sunrise</th><th>Sunrise Loss</th>' +
        '<th>Astro Sunset</th><th>Topo Sunset</th><th>Sunset Loss</th>' +
        '<th>Astro Total</th><th>Topo Total</th><th>Total Loss</th>' +
        '<th>Avg Cloud Cover</th><th>1kW Solar Est</th>' +
        '</tr></thead><tbody>';
    data.forEach(row => {
        // Remove source suffix (e.g. "|real-time") for the monthly table display
        let cloudCoverDisplay = row.cloudCover;
        if (typeof cloudCoverDisplay === 'string' && cloudCoverDisplay.includes('|')) {
            cloudCoverDisplay = cloudCoverDisplay.split('|')[0];
        }

        tableHTML += `<tr>
                    <td>${row.date}</td>
                    <td>${formatTime(row.astroSunrise, selectedTimezone)} <span class="time-jump" data-time="${row.astroSunrise.getTime()}">🕰️</span></td>
                    <td>${formatTime(row.topoSunrise, selectedTimezone)} <span class="time-jump" data-time="${row.topoSunrise.getTime()}">🕰️</span></td>
                    <td>${row.sunriseLoss}</td>
                    <td>${formatTime(row.astroSunset, selectedTimezone)} <span class="time-jump" data-time="${row.astroSunset.getTime()}">🕰️</span></td>
                    <td>${formatTime(row.topoSunset, selectedTimezone)} <span class="time-jump" data-time="${row.topoSunset.getTime()}">🕰️</span></td>
                    <td>${row.sunsetLoss}</td>
                    <td>${row.astroTotal}</td>
                    <td>${row.topoTotal}</td>
                    <td>${row.totalLoss}</td>
                    <td>${cloudCoverDisplay}</td>
                    <td>${row.solarGenEst}</td>
                </tr>`;
    });
    tableHTML += '</tbody></table>';
    reportTableContainer.innerHTML = tableHTML;

    reportTableContainer.querySelectorAll('.time-jump').forEach(span => {
        span.style.cursor = 'pointer';
        span.addEventListener('click', async (e) => {
            const newTime = parseInt(e.currentTarget.dataset.time);
            if (isNaN(newTime)) return;
            selectedDate = new Date(newTime);

            // Don't call updateAll() as it hides the report panel.
            // Instead, call the necessary update functions directly.
            updateInfoDisplay();
            await updateTerrain(); // This will take the fast path for time-only changes.
            updateUrlWithState();
        });
    });
}

document.getElementById('export-report-btn').addEventListener('click', exportReportAsPDF);

async function exportReportAsPDF() {
    const loader = document.getElementById('loader');
    const loaderText = document.getElementById('loader-text');
    const progressBar = document.getElementById('progress-bar');

    loaderText.textContent = 'Generating PDF...';
    progressBar.style.width = '0%';
    loader.style.display = 'block';

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();

    // Set fonts
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(22);
    doc.text("Sunrise & Sunset Report", doc.internal.pageSize.getWidth() / 2, 20, { align: 'center' });

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(12);
    doc.text(`Location: ${currentLocation.lat.toFixed(4)}, ${currentLocation.lon.toFixed(4)}`, doc.internal.pageSize.getWidth() / 2, 30, { align: 'center' });
    doc.text(`Year: ${selectedDate.getFullYear()}`, doc.internal.pageSize.getWidth() / 2, 38, { align: 'center' });


    const table = document.querySelector("#report-table-container table");
    const tableData = [];
    const headers = [];
    table.querySelectorAll("thead th").forEach(th => headers.push(th.innerText));
    table.querySelectorAll("tbody tr").forEach(tr => {
        const rowData = [];
        tr.querySelectorAll("td").forEach(td => rowData.push(td.innerText.replace('🕰️', '').trim()));
        tableData.push(rowData);
    });

    doc.autoTable({
        head: [headers],
        body: tableData,
        startY: 50,
        theme: 'grid',
        headStyles: {
            fillColor: [41, 128, 185],
            textColor: 255,
            fontStyle: 'bold',
        },
        alternateRowStyles: {
            fillColor: [245, 245, 245],
        },
    });

    const reportData = Array.from(document.querySelectorAll("#report-table-container tbody tr")).map(tr => {
        const jumps = tr.querySelectorAll(".time-jump");
        return {
            date: tr.cells[0].innerText,
            astroSunriseText: tr.cells[1].innerText.replace('🕰️', '').trim(),
            topoSunriseText: tr.cells[2].innerText.replace('🕰️', '').trim(),
            sunriseLoss: tr.cells[3].innerText,
            astroSunsetText: tr.cells[4].innerText.replace('🕰️', '').trim(),
            topoSunsetText: tr.cells[5].innerText.replace('🕰️', '').trim(),
            sunsetLoss: tr.cells[6].innerText,
            astroTotal: tr.cells[7].innerText,
            topoTotal: tr.cells[8].innerText,
            totalLoss: tr.cells[9].innerText,
            cloudCover: tr.cells[10].innerText,
            solarEst: tr.cells[11].innerText,
            // For images
            topoSunriseDate: new Date(parseInt(jumps[1].dataset.time)),
            topoSunsetDate: new Date(parseInt(jumps[3].dataset.time)),
        }
    });

    for (const [index, data] of reportData.entries()) {
        doc.addPage();
        doc.setFontSize(16);
        doc.text(data.date, doc.internal.pageSize.getWidth() / 2, 20, { align: 'center' });

        const tableBody = [
            ['Astro Sunrise', data.astroSunriseText],
            ['Topo Sunrise', data.topoSunriseText],
            ['Sunrise Loss', data.sunriseLoss],
            ['Astro Sunset', data.astroSunsetText],
            ['Topo Sunset', data.topoSunsetText],
            ['Sunset Loss', data.sunsetLoss],
            ['Astro Total', data.astroTotal],
            ['Topo Total', data.topoTotal],
            ['Total Daylight Lost', data.totalLoss],
            ['Cloud Cover', data.cloudCover],
            ['1kW Solar Est', data.solarEst]
        ];

        doc.autoTable({
            startY: 30,
            head: [['Metric', 'Value']],
            body: tableBody,
            theme: 'striped',
            headStyles: { fillColor: [62, 83, 104] },
            margin: { left: 20, right: 20 },
        });

        const finalY = doc.lastAutoTable.finalY;

        const imageWidth = 150;
        const imageHeight = 84; // Approx 16:9
        const imageX = (doc.internal.pageSize.getWidth() - imageWidth) / 2;

        // Add image
        const sunriseImage = await getLandscapeImage(data.topoSunriseDate);
        const sunsetImage = await getLandscapeImage(data.topoSunsetDate);

        doc.addImage(sunriseImage, 'JPEG', imageX, finalY + 10, imageWidth, imageHeight);
        doc.addImage(sunsetImage, 'JPEG', imageX, finalY + 10 + imageHeight + 5, imageWidth, imageHeight);
        
        // Add footer
        const pageCount = doc.internal.getNumberOfPages();
        doc.setFontSize(10);
        doc.text(`Page ${pageCount}`, doc.internal.pageSize.getWidth() / 2, doc.internal.pageSize.getHeight() - 10, { align: 'center' });
        progressBar.style.width = `${((index + 1) / reportData.length) * 100}%`;
    }

    doc.save("sunrise-sunset-report.pdf");
    loader.style.display = 'none';
}

async function getLandscapeImage(date) {
    const originalDate = selectedDate;
    const exportWidth = 1920;
    const exportHeight = 1080;

    // Store original size
    const originalWidth = canvas.width;
    const originalHeight = canvas.height;

    // Set the date
    selectedDate = date;
    await calculateTopoTimes();
    updateSunPosition();

    // Resize for export
    renderer.setSize(exportWidth, exportHeight);
    camera.aspect = exportWidth / exportHeight;
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);

    const finalDataURL = renderer.domElement.toDataURL('image/jpeg', 0.9);

    // Restore original size and date
    renderer.setSize(originalWidth, originalHeight);
    camera.aspect = originalWidth / originalHeight;
    camera.updateProjectionMatrix();
    selectedDate = originalDate;
    updateSunPosition();

    return finalDataURL;
}

function populateTimezones() {
    const timezonePicker = document.getElementById('timezone-picker');
    try {
        const timezones = Intl.supportedValuesOf('timeZone');
        timezonePicker.innerHTML = ''; // Clear existing
        timezones.forEach(tz => {
            const option = document.createElement('option');
            option.value = tz;
            option.textContent = tz.replace(/_/g, ' ');
            if (tz === selectedTimezone) {
                option.selected = true;
            }
            timezonePicker.appendChild(option);
        });
    } catch (e) {
        console.warn("Timezone listing not supported, hiding picker.", e);
        document.getElementById('timezone-picker').parentElement.style.display = 'none';
    }
}

let lastCloudMonth = -1;
let lastCloudLat = null;
let lastCloudLon = null;
let lastCloudPercentage = 50;

async function updateSceneCloudCover(forceUpdate = false) {
    if (!cloudMaterial) return;
    
    // Get cloud cover for current month/location
    const month = selectedDate.getMonth() + 1;

    // Fetch if needed
    if (forceUpdate ||
        month !== lastCloudMonth || 
        currentLocation.lat !== lastCloudLat || 
        currentLocation.lon !== lastCloudLon) {
        
        const cloudDisplay = document.getElementById('cloud-cover-display');
        if (cloudDisplay) {
            cloudDisplay.textContent = "Calculating...";
        }

        const cloudResult = await getAverageCloudCover(month);
        
        // Parse result "50%|source"
        if (cloudResult && typeof cloudResult === 'string') {
            const parts = cloudResult.split('%');
            if (parts.length > 0) {
                 const val = parseInt(parts[0]);
                 if (!isNaN(val)) lastCloudPercentage = val;
            }
        }
        
        // Update uniform
        cloudMaterial.uniforms.uCloudCover.value = lastCloudPercentage / 100.0;

        lastCloudMonth = month;
        lastCloudLat = currentLocation.lat;
        lastCloudLon = currentLocation.lon;
    }

    // Update display (always run this part to ensure solar estimate uses fresh topo times)
    const cloudDisplay = document.getElementById('cloud-cover-display');
    if (cloudDisplay) {
        cloudDisplay.textContent = `${lastCloudPercentage}%`;
    }

    // Calculate and display 1kW Solar Gen Estimate
    const solarGenDisplay = document.getElementById('solar-gen-estimate');
    if (solarGenDisplay && currentSunTimes.topoSunrise && currentSunTimes.topoSunset) {
        const topoHours = (currentSunTimes.topoSunset.getTime() - currentSunTimes.topoSunrise.getTime()) / (1000 * 60 * 60);
        const cloudFraction = lastCloudPercentage / 100.0;
        // Simple estimate: TopoHours * (1 - CloudFraction) * 1kW. 
        const estKwh = Math.max(0, topoHours * (1.0 - cloudFraction)); 
        solarGenDisplay.textContent = `${estKwh.toFixed(2)} kWh`;
    }
}

const cloudToggle = document.getElementById('cloud-cover-toggle');
if (cloudToggle) {
    cloudToggle.addEventListener('change', (e) => {
        if (cloudMesh) {
            cloudMesh.visible = e.target.checked;
        }
    });
}

// --- Initialization ---
function init() {
    getStateFromUrl();
    // This function will be called by mappingManager when the location changes
    const handleLocationChange = (newLocation) => {
        currentLocation = newLocation;
        updateAll();
    };

    dataManager.init(textureLoader);
    populateTimezones();
    const mapInterface = mappingManager.init(
        { lat: currentLocation.lat, lon: currentLocation.lon, zoom: mapZoom, layer: currentMapLayer, layers: mapLayerConfigs },
        handleLocationChange
    );
    setupScene();
    updateAll();
    animate();

    canvas.addEventListener('click', (e) => {
        if (!mapInterface.isSelectionModeActive()) return;

        const mouse = new THREE.Vector2();
        mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
        mouse.y = - (e.clientY / window.innerHeight) * 2 + 1;

        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObjects(terrainGrid.children);
        if (intersects.length > 0) {
            const intersectPoint = intersects[0].point;
            const tileWorldSize = getTileWorldSizeForZoom(mapZoom);
            const preciseTileCoords = dataManager.lonLatToTileCoords(currentLocation.lon, currentLocation.lat, mapZoom);
            const newXTile = preciseTileCoords.x + intersectPoint.x / tileWorldSize;
            const newYTile = preciseTileCoords.y + intersectPoint.z / tileWorldSize;
            const newCoords = dataManager.tileCoordsToLonLat(newXTile, newYTile, mapZoom);

            mapInterface.exitSelectionMode();
            mappingManager.updateMapState(newCoords, mapZoom);
            handleLocationChange(newCoords);
        }
    });
}

init();
