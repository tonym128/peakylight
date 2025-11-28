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
let currentLocation = { lat: -25.2744, lon: 133.7751 };
let selectedDate = new Date();
let currentSunTimes = {};
let lastTerrainLocation = { lat: null, lon: null };
let selectedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
let map, marker, leafletTileLayer;
let mapZoom = 13; // Default to Medium detail
let isLocationSelectionMode = false;
let isYearAnimating = false;
const MAP_LAYERS = {
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
let currentMapLayer = 'opentopo';
let terrainHeightData = {};
let animationConfig = {
    type: 'sunrise', // 'sunrise' or 'sunset'
    day: 1,
    frameCounter: 0,
    framesPerDay: 5 // Speed of animation
};
let topoTimesCache = {
    lat: null,
    lon: null,
    year: null,
    data: {} // dayOfYear -> { topoSunrise, topoSunset }
};

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

    if (layer && MAP_LAYERS[layer]) {
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

// --- Leaflet Caching Layer ---
L.TileLayer.Cached = L.TileLayer.extend({
    createTile: function (coords, done) {
        const tile = document.createElement('img');

        const originalOnLoad = L.Util.bind(this._tileOnLoad, this, done, tile);
        const originalOnError = L.Util.bind(this._tileOnError, this, done, tile);

        const customOnLoad = () => {
            if (tile.src.startsWith('blob:')) {
                URL.revokeObjectURL(tile.src);
            }
            originalOnLoad();
        };

        L.DomEvent.on(tile, 'load', customOnLoad);
        L.DomEvent.on(tile, 'error', originalOnError);

        if (this.options.crossOrigin) {
            tile.crossOrigin = '';
        }
        tile.alt = '';
        tile.setAttribute('role', 'presentation');

        const tileUrl = this.getTileUrl(coords);

        getCachedTileUrl(tileUrl).then(url => {
            tile.src = url;
        }).catch(() => {
            // Fallback on error
            tile.src = tileUrl;
        });

        return tile;
    }
});

L.tileLayer.cached = function (url, options) {
    return new L.TileLayer.Cached(url, options);
};

// --- Map Initialization ---
function initMap() {
    map = L.map('map').setView([currentLocation.lat, currentLocation.lon], mapZoom);
    const layerConfig = MAP_LAYERS[currentMapLayer];
    leafletTileLayer = L.tileLayer.cached(layerConfig.leafletUrl, {
        attribution: layerConfig.leafletAttribution
    }).addTo(map);

    marker = L.marker([currentLocation.lat, currentLocation.lon]).addTo(map);
}

// --- 3D Scene Setup ---
let terrainGrid, sunLight, locationMarker, sunRayLine, sunArcMesh;
const raycaster = new THREE.Raycaster();
const textureLoader = new THREE.TextureLoader();
textureLoader.crossOrigin = 'anonymous';

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

    camera.position.set(0, 8, 15);
    controls.update();
}

// --- Caching with IndexedDB ---
const dbCache = {
    db: null,
    dbName: 'PeakyLightTileCache',
    storeName: 'tiles',
    async init() {
        if (this.db) return Promise.resolve(this.db);
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);
            request.onerror = (event) => {
                console.error("IndexedDB error:", event.target.error);
                reject("IndexedDB not available");
            };
            request.onsuccess = (event) => {
                this.db = event.target.result;
                resolve(this.db);
            };
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName, { keyPath: 'url' });
                }
            };
        });
    },
    async getTile(url) {
        try {
            await this.init();
            return new Promise((resolve, reject) => {
                const transaction = this.db.transaction([this.storeName], 'readonly');
                const store = transaction.objectStore(this.storeName);
                const request = store.get(url);
                request.onsuccess = (event) => resolve(event.target.result ? event.target.result.blob : null);
                request.onerror = (event) => {
                    console.error("Error getting tile from IndexedDB:", event.target.error);
                    reject(event.target.error);
                };
            });
        } catch (e) {
            console.error("DB not available for getTile", e);
            return null;
        }
    },
    async saveTile(url, blob) {
        try {
            await this.init();
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            store.put({ url: url, blob: blob });
        } catch (e) {
            console.warn("DB not available for saveTile, caching disabled for this item.", e);
        }
    }
};

async function getCachedBlobUrl(url) {
    const cachedBlob = await dbCache.getTile(url).catch(() => null);
    if (cachedBlob) return URL.createObjectURL(cachedBlob);

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.statusText}`);
    const blob = await response.blob();
    dbCache.saveTile(url, blob); // Fire and forget
    return URL.createObjectURL(blob);
}

async function getCachedTexture(url) {
    try {
        const blobUrl = await getCachedBlobUrl(url);
        const texture = await textureLoader.loadAsync(blobUrl);
        URL.revokeObjectURL(blobUrl); // Clean up blob URL after texture is loaded
        return texture;
    } catch (error) {
        console.error(`Failed to load texture from ${url}`, error);
        throw error;
    }
}

async function getCachedTileUrl(url) {
    try {
        return await getCachedBlobUrl(url);
    } catch (error) {
        console.error(`Failed to get cached tile URL for ${url}`, error);
        return url; // Fallback to original url on error
    }
}

function lonLatToTileCoords(lon, lat, zoom) {
    const n = Math.pow(2, zoom);
    const xtile = n * ((lon + 180) / 360);
    const latRad = lat * Math.PI / 180;
    const ytile = n * (1 - (Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI)) / 2;
    return { x: xtile, y: ytile, z: zoom };
}

function tileCoordsToLonLat(xtile, ytile, zoom) {
    const n = Math.pow(2, zoom);
    const lon_deg = xtile / n * 360.0 - 180.0;
    const lat_rad = Math.atan(Math.sinh(Math.PI * (1 - 2 * ytile / n)));
    const lat_deg = lat_rad * 180.0 / Math.PI;
    return { lat: lat_deg, lon: lon_deg };
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
    const preciseTileCoords = lonLatToTileCoords(currentLocation.lon, currentLocation.lat, mapZoom);
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
            const satelliteUrl = MAP_LAYERS[currentMapLayer].threeUrl(centralTileCoords.z, tileX, tileY);
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
    const [satelliteTexture, heightmapTexture] = await Promise.all([
        getCachedTexture(satelliteUrl),
        getCachedTexture(heightmapUrl)
    ]);

    terrainMesh.material.map = satelliteTexture;
    terrainMesh.material.needsUpdate = true;

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    const img = heightmapTexture.image;
    canvas.width = img.width;
    canvas.height = img.height;
    context.drawImage(img, 0, 0);
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    const geometry = terrainMesh.geometry;
    const vertices = geometry.attributes.position;
    const { topVerticesCount, edgeToSkirtMap, skirtDepth } = geometry.userData;

    const heightArray = new Float32Array(topVerticesCount);
    for (let i = 0; i < topVerticesCount; i++) {
        const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
        const height = (r * 256 + g + b / 256) - 32768;
        const scaledHeight = height * 0.005;
        vertices.setZ(i, scaledHeight);
        heightArray[i] = scaledHeight;
    }

    // Update skirt vertices heights to match their corresponding edge vertex
    if (edgeToSkirtMap && skirtDepth !== undefined) {
        for (const [edgeIndex, skirtRelativeIndex] of edgeToSkirtMap.entries()) {
            const edgeHeight = vertices.getZ(edgeIndex);
            const skirtIndex = topVerticesCount + skirtRelativeIndex;
            vertices.setZ(skirtIndex, edgeHeight - skirtDepth);
        }
    }

    vertices.needsUpdate = true;
    geometry.computeVertexNormals();

    terrainHeightData[terrainMesh.name] = {
        heights: heightArray,
        width: img.width,
        height: img.height
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

    for (let i = 0; i < 15; i++) {
        const mid = low + (high - low) / 2;
        const { isLit } = isLocationSunlit(new Date(mid));
        if (findFirstLight) {
            if (isLit) { bestTime = mid; high = mid; } else { low = mid; }
        } else {
            if (isLit) { bestTime = mid; low = mid; } else { high = mid; }
        }
        // Yield to the event loop to prevent UI blocking during heavy calculation
        await new Promise(resolve => setTimeout(resolve, 0));
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
            second: '2-digit',
            hour12: false,
            timeZone: timeZone,
            hourCycle: 'h23'
        }).format(date);
    } catch (e) {
        console.error(`Invalid timezone: ${timeZone}`, e);
        // Fallback to browser's local time if timezone is invalid
        const hours = date.getHours().toString().padStart(2, '0');
        const minutes = date.getMinutes().toString().padStart(2, '0');
        const seconds = date.getSeconds().toString().padStart(2, '0');
        return `${hours}:${minutes}:${seconds}`;
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

    document.getElementById('topo-sunrise-time').textContent = formatTime(topoSunrise, selectedTimezone);
    document.getElementById('topo-sunset-time').textContent = formatTime(topoSunset, selectedTimezone);
    document.getElementById('jump-to-topo-sunrise').style.visibility = 'visible';
    document.getElementById('jump-to-topo-sunset').style.visibility = 'visible';

    document.getElementById('sunrise-loss').textContent = formatDuration(sunriseLossMs);
    document.getElementById('sunset-loss').textContent = formatDuration(sunsetLossMs);
    document.getElementById('total-daylight-loss').textContent = formatDuration(totalLossMs);

    updateSunArc(times, topoSunrise, topoSunset);
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
}



// --- Animation ---
function stopAnimations() {
    if (isYearAnimating) {
        isYearAnimating = false;
        controls.enabled = true;

        document.getElementById('stop-animation-btn').style.display = 'none';
        document.querySelector('.animation-controls').style.display = 'flex';
    }
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

async function startYearAnimation(type) {
    stopAnimations();
    
    const cacheSuccess = await cacheYearlyTopoTimes();
    if (!cacheSuccess) {
        alert("Could not generate animation data.");
        return;
    }

    isYearAnimating = true;
    animationConfig.type = type;
    animationConfig.day = 1;
    animationConfig.frameCounter = 0;
    
    document.getElementById('stop-animation-btn').style.display = 'block';
    document.querySelector('.animation-controls').style.display = 'none';
    
    controls.enabled = false;
}

// --- Time Navigation ---
function jumpToTime(time) {
    if (!time || isNaN(time)) return;
    
    selectedDate = new Date(time);
    stopAnimations();
    updateInfoDisplay();
    updateSunPosition();
    debouncedUpdateUrl();
}

async function exportVideo(type) {
    stopAnimations();

    // 1. Pre-cache all data to make frame generation fast
    const cacheSuccess = await cacheYearlyTopoTimes();
    if (!cacheSuccess) {
        alert("Could not generate animation data for export.");
        return;
    }

    const loader = document.getElementById('loader');
    const loaderText = document.getElementById('loader-text');
    const progressBar = document.getElementById('progress-bar');
    loaderText.textContent = `Exporting ${type} video...`;
    progressBar.style.width = '0%';
    loader.style.display = 'block';

    // 2. Setup for export (canvas, dimensions, etc.)
    const exportWidth = 1920;
    const exportHeight = 1080;
    const fps = 30;
    const framesPerDay = 12; // How many frames to render for each day for a smoother video.

    const originalWidth = canvas.width;
    const originalHeight = canvas.height;
    const originalDate = new Date(selectedDate);

    renderer.setSize(exportWidth, exportHeight);
    camera.aspect = exportWidth / exportHeight;
    camera.updateProjectionMatrix();

    // 3. Setup MediaRecorder
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = exportWidth;
    tempCanvas.height = exportHeight;
    const tempCtx = tempCanvas.getContext('2d');

    const mimeType = 'video/mp4';
    const isMp4Supported = MediaRecorder.isTypeSupported(mimeType);
    const finalMimeType = isMp4Supported ? mimeType : 'video/webm';
    const fileExtension = isMp4Supported ? 'mp4' : 'webm';

    const stream = tempCanvas.captureStream(fps);
    const recorder = new MediaRecorder(stream, { mimeType: finalMimeType, videoBitsPerSecond: 1000000 });
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
        link.download = `mylight-${type}-export-${year}.${fileExtension}`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

        // Restore original state
        renderer.setSize(originalWidth, originalHeight);
        camera.aspect = originalWidth / originalHeight;
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

    function renderFrame() {
        if (day > daysInYear) {
            recorder.stop();
            return;
        }

        const cachedTimes = topoTimesCache.data[day];
        if (cachedTimes) {
            selectedDate = (type === 'sunrise') ? cachedTimes.topoSunrise : cachedTimes.topoSunset;
            
            // Fast updates using cached data
            const astronomicalTimes = { sunrise: cachedTimes.sunrise, sunset: cachedTimes.sunset };
            currentSunTimes.sunrise = astronomicalTimes.sunrise;
            currentSunTimes.sunset = astronomicalTimes.sunset;
            currentSunTimes.topoSunrise = cachedTimes.topoSunrise;
            currentSunTimes.topoSunset = cachedTimes.topoSunset;
            updateInfoDisplay();
            updateSunPosition();
            updateSunArc(astronomicalTimes, cachedTimes.topoSunrise, cachedTimes.topoSunset);

            // Panning camera - interpolate for smoothness
            const dayProgress = (day - 1 + (frameInDay / framesPerDay)) / daysInYear;
            const angle = dayProgress * Math.PI * 2;
            const distance = 25;
            const height = 10;
            camera.position.set(distance * Math.sin(angle), height, distance * Math.cos(angle));
            controls.target.set(0, 0, 0);
            controls.update();

            // Render WebGL and composite with overlay
            renderer.render(scene, camera);
            const sourceCanvas = renderer.domElement;

            const sunriseDiffMs = (astronomicalTimes.sunrise && cachedTimes.topoSunrise && !isNaN(astronomicalTimes.sunrise) && !isNaN(cachedTimes.topoSunrise))
                ? astronomicalTimes.sunrise.getTime() - cachedTimes.topoSunrise.getTime()
                : 0;
            const sunsetDiffMs = (astronomicalTimes.sunset && cachedTimes.topoSunset && !isNaN(astronomicalTimes.sunset) && !isNaN(cachedTimes.topoSunset))
                ? cachedTimes.topoSunset.getTime() - astronomicalTimes.sunset.getTime()
                : 0;
            const totalLostMs = sunriseDiffMs + sunsetDiffMs;

            const textLines = [
                `Location: ${document.getElementById('location-coords').textContent}`,
                `Date: ${selectedDate.toLocaleDateString([], { timeZone: selectedTimezone })}`,
                `Time: ${selectedDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: selectedTimezone })}`,
                '', // spacer
                `Sunrise: ${formatTime(astronomicalTimes.sunrise, selectedTimezone)}`,
                `Topo Sunrise: ${formatTime(cachedTimes.topoSunrise, selectedTimezone)}`,
                `  └ Diff: ${formatTimeDiff(sunriseDiffMs)}`,
                '', // spacer
                `Sunset: ${formatTime(astronomicalTimes.sunset, selectedTimezone)}`,
                `Topo Sunset: ${formatTime(cachedTimes.topoSunset, selectedTimezone)}`,
                `  └ Diff: ${formatTimeDiff(sunsetDiffMs)}`,
                '', // spacer
                `Total Daylight Lost: ${formatTimeDiff(totalLostMs)}`
            ];

            const lineHeight = 22;
            const textMargin = 15;
            const panelWidth = 450;
            const panelHeight = textLines.length * lineHeight;

            tempCtx.drawImage(sourceCanvas, 0, 0);
            tempCtx.fillStyle = 'rgba(0, 0, 0, 0.6)';
            tempCtx.fillRect(10, 10, panelWidth, panelHeight);
            tempCtx.fillStyle = '#f0f0f0';
            tempCtx.font = `18px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
            tempCtx.textAlign = 'left';

            textLines.forEach((line, index) => {
                tempCtx.fillText(line, 10 + textMargin, 10 + textMargin + (index * lineHeight));
            });
        }

        // Update progress and counters
        currentFrame++;
        progressBar.style.width = `${(currentFrame / totalFrames) * 100}%`;
        
        frameInDay++;
        if (frameInDay >= framesPerDay) {
            frameInDay = 0;
            day++;
        }

        requestAnimationFrame(renderFrame);
    }

    renderFrame();
}

async function exportSplitScreenVideo() {
    stopAnimations();

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

    const mimeType = 'video/mp4';
    const isMp4Supported = MediaRecorder.isTypeSupported(mimeType);
    const finalMimeType = isMp4Supported ? mimeType : 'video/webm';
    const fileExtension = isMp4Supported ? 'mp4' : 'webm';

    const stream = tempCanvas.captureStream(fps);
    const recorder = new MediaRecorder(stream, { mimeType: finalMimeType, videoBitsPerSecond: 1000000 });
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

    function renderFrame() {
        if (day > daysInYear) {
            recorder.stop();
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
            controls.target.set(0, 0, 0);
            controls.update();

            const astronomicalTimes = { sunrise: cachedTimes.sunrise, sunset: cachedTimes.sunset };

            // --- Render Left Side (Sunrise) ---
            renderer.setViewport(0, 0, exportWidth / 2, exportHeight);
            renderer.setScissor(0, 0, exportWidth / 2, exportHeight);
            renderer.setScissorTest(true);
            selectedDate = cachedTimes.topoSunrise;
            updateSunPosition();
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

            tempCtx.drawImage(renderer.domElement, 0, 0);
            const locationText = `Location: ${currentLocation.lat.toFixed(4)}, ${currentLocation.lon.toFixed(4)}`;
            const font = `18px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
            const sunriseDate = cachedTimes.topoSunrise, sunsetDate = cachedTimes.topoSunset;

            // Left Panel
            const panelX = 10, panelY = 10, panelW = 420, panelH = 200;
            const textX = panelX + 15, textY = panelY + 15;
            tempCtx.fillStyle = 'rgba(0, 0, 0, 0.6)'; tempCtx.fillRect(panelX, panelY, panelW, panelH);
            tempCtx.fillStyle = '#f0f0f0'; tempCtx.font = font; tempCtx.textAlign = 'left';
            let y = textY;
            tempCtx.fillText("Topographic Sunrise", textX, y += 20);
            tempCtx.fillText(locationText, textX, y += 25);
            tempCtx.fillText(`Date         : ${sunriseDate.toLocaleDateString([], { timeZone: selectedTimezone })}`, textX, y += 25);
            tempCtx.fillText(`Topo Sunrise : ${sunriseDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: selectedTimezone })}`, textX, y += 25);
            tempCtx.fillText(`Astro Sunrise: ${formatTime(astronomicalTimes.sunrise, selectedTimezone)}`, textX, y += 25);
            tempCtx.fillText(`Sunrise Diff : ${formatTimeDiff(sunriseDiffMs)}`, textX, y += 25);
            tempCtx.fillText(`Total Lost   : ${formatTimeDiff(totalLostMs)}`, textX, y += 25);

            // Right Panel
            const rightPanelX = exportWidth / 2 + 10;
            const rightTextX = rightPanelX + 15;
            tempCtx.fillStyle = 'rgba(0, 0, 0, 0.6)'; tempCtx.fillRect(rightPanelX, panelY, panelW, panelH);
            tempCtx.fillStyle = '#f0f0f0'; tempCtx.font = font; tempCtx.textAlign = 'left';
            y = textY;
            tempCtx.fillText("Topographic Sunset", rightTextX, y += 20);
            tempCtx.fillText(locationText, rightTextX, y += 25);
            tempCtx.fillText(`Date        : ${sunsetDate.toLocaleDateString([], { timeZone: selectedTimezone })}`, rightTextX, y += 25);
            tempCtx.fillText(`Topo Sunset : ${sunsetDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: selectedTimezone })}`, rightTextX, y += 25);
            tempCtx.fillText(`Astro Sunset: ${formatTime(astronomicalTimes.sunset, selectedTimezone)}`, rightTextX, y += 25);
            tempCtx.fillText(`Sunset Diff : ${formatTimeDiff(sunsetDiffMs)}`, rightTextX, y += 25);
            tempCtx.fillText(`Total Lost  : ${formatTimeDiff(totalLostMs)}`, rightTextX, y += 25);

            tempCtx.fillStyle = '#f0f0f0'; tempCtx.fillRect(exportWidth / 2 - 1, 0, 2, exportHeight);
        }

        currentFrame++; progressBar.style.width = `${(currentFrame / totalFrames) * 100}%`;
        frameInDay++; if (frameInDay >= framesPerDay) { frameInDay = 0; day++; }
        requestAnimationFrame(renderFrame);
    }

    renderFrame();
}

// --- Event Listeners ---
document.getElementById('locate-btn').addEventListener('click', () => {
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(position => {
            currentLocation = { lat: position.coords.latitude, lon: position.coords.longitude };
            map.setView([currentLocation.lat, currentLocation.lon], mapZoom);
            marker.setLatLng([currentLocation.lat, currentLocation.lon]);
            updateAll();
        });
    }
});

document.getElementById('terrain-detail-picker').addEventListener('input', (e) => {
    const newZoom = parseInt(e.target.value);
    if (newZoom !== mapZoom) {
        mapZoom = newZoom;
        map.setZoom(mapZoom);
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

document.getElementById('update-coords-btn').addEventListener('click', () => {
    const lat = parseFloat(document.getElementById('lat-input').value);
    const lon = parseFloat(document.getElementById('lon-input').value);
    if (!isNaN(lat) && !isNaN(lon)) {
        currentLocation = { lat, lon };
        map.setView([lat, lon], mapZoom);
        marker.setLatLng([lat, lon]);
        updateAll();
    }
});

document.getElementById('timezone-picker').addEventListener('input', (e) => {
    selectedTimezone = e.target.value;
    stopAnimations();
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

    stopAnimations();
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

const debouncedAddressSearch = debounce(async (query) => {
    if (query.length < 3) {
        document.getElementById('address-results').innerHTML = '';
        return;
    }
    const response = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5`);
    const data = await response.json();
    const resultsContainer = document.getElementById('address-results');
    resultsContainer.innerHTML = '';
    if (data && data.length > 0) {
        data.forEach(result => {
            const item = document.createElement('div');
            item.classList.add('address-result-item');
            item.textContent = result.display_name;
            item.dataset.lon = result.lon;
            item.dataset.lat = result.lat;
            resultsContainer.appendChild(item);
        });
    }
}, 250);

document.getElementById('address-search').addEventListener('input', (e) => debouncedAddressSearch(e.target.value));

document.getElementById('address-results').addEventListener('click', (e) => {
    if (e.target.classList.contains('address-result-item')) {
        const lat = parseFloat(e.target.dataset.lat);
        const lon = parseFloat(e.target.dataset.lon);
        currentLocation = { lat, lon };
        map.setView([lat, lon], mapZoom);
        marker.setLatLng([lat, lon]);
        updateAll();
        document.getElementById('address-results').innerHTML = '';
        document.getElementById('address-search').value = e.target.textContent;
    }
});

document.getElementById('animate-sunrise-btn').addEventListener('click', () => startYearAnimation('sunrise'));
document.getElementById('animate-sunset-btn').addEventListener('click', () => startYearAnimation('sunset'));
document.getElementById('stop-animation-btn').addEventListener('click', stopAnimations);

document.getElementById('export-sunrise-btn').addEventListener('click', () => exportVideo('sunrise'));
document.getElementById('export-sunset-btn').addEventListener('click', () => exportVideo('sunset'));
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
    const time = `Time: ${selectedDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: selectedTimezone })}`;
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

    if (isYearAnimating) {
        animationConfig.frameCounter++;
        if (animationConfig.frameCounter >= animationConfig.framesPerDay) {
            animationConfig.frameCounter = 0;
            animationConfig.day++;
            
            const year = topoTimesCache.year;
            const isLeap = new Date(year, 1, 29).getDate() === 29;
            const daysInYear = isLeap ? 366 : 365;

            if (animationConfig.day > daysInYear) {
                stopAnimations();
            } else {
                const cachedTimes = topoTimesCache.data[animationConfig.day];
                if (cachedTimes) {
                    selectedDate = animationConfig.type === 'sunrise' ? cachedTimes.topoSunrise : cachedTimes.topoSunset;
                    
                    // These functions will update the scene and UI based on the new selectedDate
                    calculateTopoTimes(); // This is async, but it's fine. It will update the arc when it can.
                    updateSunPosition();
                    updateInfoDisplay();
                }
            }
        }
        
        if (isYearAnimating) { // Check again in case stopAnimations() was called
            const year = topoTimesCache.year;
            const isLeap = new Date(year, 1, 29).getDate() === 29;
            const daysInYear = isLeap ? 366 : 365;
            const angle = (animationConfig.day / daysInYear) * Math.PI * 2;
            const distance = 25;
            const height = 10;
            camera.position.set(
                distance * Math.sin(angle),
                height,
                distance * Math.cos(angle)
            );
            controls.target.set(0, 0, 0);
        }
    }

    controls.update();

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
    if (!MAP_LAYERS[layerKey] || layerKey === currentMapLayer) {
        return;
    }

    currentMapLayer = layerKey;

    // Update Leaflet 2D map
    if (leafletTileLayer) {
        map.removeLayer(leafletTileLayer);
    }
    const layerConfig = MAP_LAYERS[currentMapLayer];
    leafletTileLayer = L.tileLayer.cached(layerConfig.leafletUrl, {
        attribution: layerConfig.leafletAttribution
    }).addTo(map);

    // Force terrain to reload with new textures
    lastTerrainLocation = { lat: null, lon: null };
    updateTerrain();

    updateUrlWithState();
}

function updateAll() {
    stopAnimations();
    terrainHeightData = {}; // Clear height data on location change

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

// --- Report Generation ---
const reportPanel = document.getElementById('report-panel');
const toggleReportBtn = document.getElementById('toggle-report-btn');
const generateReportBtn = document.getElementById('generate-report-btn');
const reportTableContainer = document.getElementById('report-table-container');

toggleReportBtn.addEventListener('click', () => {
    reportPanel.classList.toggle('collapsed');
});

generateReportBtn.addEventListener('click', async () => {
    reportPanel.style.display = 'block';
    reportPanel.classList.remove('collapsed');

    const loader = document.getElementById('loader');
    const loaderText = document.getElementById('loader-text');
    const progressBar = document.getElementById('progress-bar');

    loaderText.textContent = 'Creating report...';
    progressBar.style.width = '0%';
    loader.style.display = 'block';

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
        progressBar.style.width = `${((i + 2) / (dates.length + 2)) * 100}%`;
    }

    renderReportTable(reportData);
    loader.style.display = 'none';
});

function formatTimeDiff(ms) {
    if (isNaN(ms)) return 'N/A';
    const sign = ms < 0 ? '-' : '+';
    const delta = Math.abs(ms);
    const seconds = Math.floor((delta / 1000) % 60);
    const minutes = Math.floor((delta / (1000 * 60)) % 60);
    const hours = Math.floor(delta / (1000 * 60 * 60));
    return `${sign}${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function formatDuration(ms) {
    if (isNaN(ms) || ms < 0) return '00:00:00';
    const delta = Math.abs(ms);
    const seconds = Math.floor((delta / 1000) % 60);
    const minutes = Math.floor((delta / (1000 * 60)) % 60);
    const hours = Math.floor(delta / (1000 * 60 * 60));
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

async function getReportDataForDate(date, customLabel) {
    const times = SunCalc.getTimes(date, currentLocation.lat, currentLocation.lon);
    
    const topoSunrise = await findTopoTime(times.sunrise, times.solarNoon, true);
    const topoSunset = await findTopoTime(times.solarNoon, times.sunset, false);

    const sunriseLossMs = (topoSunrise && times.sunrise && !isNaN(topoSunrise) && !isNaN(times.sunrise)) ? topoSunrise.getTime() - times.sunrise.getTime() : 0;
    const sunsetLossMs = (times.sunset && topoSunset && !isNaN(times.sunset) && !isNaN(topoSunset)) ? times.sunset.getTime() - topoSunset.getTime() : 0;
    const totalLossMs = Math.max(0, sunriseLossMs) + Math.max(0, sunsetLossMs);

    const fullDateString = date.toLocaleString('default', { day: 'numeric', month: 'long', year: 'numeric' });

    const dateString = customLabel ? `${customLabel} (${fullDateString})` : fullDateString;

    return {
        date: dateString,
        astroSunrise: times.sunrise,
        topoSunrise: topoSunrise,
        sunriseLoss: formatDuration(sunriseLossMs),
        astroSunset: times.sunset,
        topoSunset: topoSunset,
        sunsetLoss: formatDuration(sunsetLossMs),
        totalLoss: formatDuration(totalLossMs)
    };
}

function renderReportTable(data) {
    let tableHTML = '<table><thead><tr>' +
        '<th>Date</th>' +
        '<th>Astro Sunrise</th><th>Topo Sunrise</th><th>Sunrise Loss</th>' +
        '<th>Astro Sunset</th><th>Topo Sunset</th><th>Sunset Loss</th>' +
        '<th>Total Loss</th>' +
        '</tr></thead><tbody>';
    data.forEach(row => {
        tableHTML += `<tr>
                    <td>${row.date}</td>
                    <td>${formatTime(row.astroSunrise, selectedTimezone)} <span class="time-jump" data-time="${row.astroSunrise.getTime()}">🕰️</span></td>
                    <td>${formatTime(row.topoSunrise, selectedTimezone)} <span class="time-jump" data-time="${row.topoSunrise.getTime()}">🕰️</span></td>
                    <td>${row.sunriseLoss}</td>
                    <td>${formatTime(row.astroSunset, selectedTimezone)} <span class="time-jump" data-time="${row.astroSunset.getTime()}">🕰️</span></td>
                    <td>${formatTime(row.topoSunset, selectedTimezone)} <span class="time-jump" data-time="${row.topoSunset.getTime()}">🕰️</span></td>
                    <td>${row.sunsetLoss}</td>
                    <td>${row.totalLoss}</td>
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
            stopAnimations();
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
            totalLoss: tr.cells[7].innerText,
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
            ['Total Daylight Lost', data.totalLoss],
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

// --- Initialization ---
function init() {
    getStateFromUrl();
    populateTimezones();
    initMap();
    setupScene();
    updateAll();
    animate();
    
    const selectLocationBtn = document.getElementById('select-location-btn');

    function enterSelectionMode() {
        isLocationSelectionMode = true;
        canvas.style.cursor = 'crosshair';
        selectLocationBtn.textContent = 'Cancel Selection';
        selectLocationBtn.style.backgroundColor = '#dc3545'; // Red for cancel/active state
        controls.enableRotate = false; // Disable rotation to allow for easy panning
    }

    function exitSelectionMode() {
        isLocationSelectionMode = false;
        canvas.style.cursor = 'grab';
        selectLocationBtn.textContent = 'Select Location on Map';
        selectLocationBtn.style.backgroundColor = ''; // Revert to default
        controls.enableRotate = true;
    }

    selectLocationBtn.addEventListener('click', () => {
        if (isLocationSelectionMode) {
            exitSelectionMode();
        } else {
            enterSelectionMode();
        }
    });

    canvas.addEventListener('click', (e) => {
        if (!isLocationSelectionMode) return;

        // Use raycasting to find the precise 3D point on the terrain
        const mouse = new THREE.Vector2();
        mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
        mouse.y = - (e.clientY / window.innerHeight) * 2 + 1;

        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObjects(terrainGrid.children);

        if (intersects.length > 0) {
            const intersectPoint = intersects[0].point;
            const tileWorldSize = getTileWorldSizeForZoom(mapZoom);
            
            // Convert the 3D world point back to geographical coordinates
            const preciseTileCoords = lonLatToTileCoords(currentLocation.lon, currentLocation.lat, mapZoom);
            const newXTile = preciseTileCoords.x + intersectPoint.x / tileWorldSize;
            const newYTile = preciseTileCoords.y + intersectPoint.z / tileWorldSize;
            const newCoords = tileCoordsToLonLat(newXTile, newYTile, mapZoom);

            currentLocation = { lat: newCoords.lat, lon: newCoords.lon };
            marker.setLatLng([newCoords.lat, newCoords.lon]);
            map.panTo([newCoords.lat, newCoords.lon]);
            
            exitSelectionMode(); // Automatically exit selection mode after a successful click
            updateAll();
        }
    });
}

init();