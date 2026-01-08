const dataManager = (() => {
    let textureLoader;

    const dbCache = {
        db: null,
        dbName: 'PeakyLightTileCache',
        storeName: 'tiles',
        async init() {
            if (this.db) return Promise.resolve(this.db);
            const self = this;
            return new Promise((resolve, reject) => {
                const openDB = (version) => version ? indexedDB.open(self.dbName, version) : indexedDB.open(self.dbName);

                    // Open without specifying a version so existing newer DBs won't cause a failure
                    const request = openDB();
                request.onerror = (event) => {
                    console.error("IndexedDB error:", event.target.error);
                    reject("IndexedDB not available");
                };

                request.onupgradeneeded = (event) => {
                    const db = event.target.result;
                    if (!db.objectStoreNames.contains(self.storeName)) {
                        db.createObjectStore(self.storeName, { keyPath: 'url' });
                    }
                    // Key/value store for small cached items (e.g. cloud cover)
                    if (!db.objectStoreNames.contains('kv')) {
                        db.createObjectStore('kv', { keyPath: 'key' });
                    }
                };

                request.onsuccess = async (event) => {
                    const db = event.target.result;
                    // If KV store is missing (older DB), upgrade DB to add it
                    if (!db.objectStoreNames.contains('kv')) {
                        try {
                            const currentVersion = db.version || 1;
                            db.close();
                            const upgradeReq = openDB(currentVersion + 1);
                            upgradeReq.onupgradeneeded = (ev) => {
                                const upgradedDb = ev.target.result;
                                if (!upgradedDb.objectStoreNames.contains(self.storeName)) {
                                    upgradedDb.createObjectStore(self.storeName, { keyPath: 'url' });
                                }
                                if (!upgradedDb.objectStoreNames.contains('kv')) {
                                    upgradedDb.createObjectStore('kv', { keyPath: 'key' });
                                }
                            };
                            upgradeReq.onsuccess = (ev2) => {
                                self.db = ev2.target.result;
                                resolve(self.db);
                            };
                            upgradeReq.onerror = (ev2) => {
                                console.error('IndexedDB upgrade error:', ev2.target.error);
                                // Still resolve with the original DB if upgrade fails
                                self.db = db;
                                resolve(self.db);
                            };
                        } catch (upgradeErr) {
                            console.warn('Failed to upgrade IndexedDB, continuing without kv store', upgradeErr);
                            self.db = db;
                            resolve(self.db);
                        }
                    } else {
                        self.db = db;
                        resolve(self.db);
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
        async getKV(key) {
            try {
                await this.init();
                return new Promise((resolve, reject) => {
                    const transaction = this.db.transaction(['kv'], 'readonly');
                    const store = transaction.objectStore('kv');
                    const request = store.get(key);
                    request.onsuccess = (event) => resolve(event.target.result ? event.target.result.value : null);
                    request.onerror = (event) => {
                        console.error("Error getting kv from IndexedDB:", event.target.error);
                        reject(event.target.error);
                    };
                });
            } catch (e) {
                console.error("DB not available for getKV", e);
                return null;
            }
        },
        async saveKV(key, value) {
            try {
                await this.init();
                const transaction = this.db.transaction(['kv'], 'readwrite');
                const store = transaction.objectStore('kv');
                store.put({ key: key, value: value });
            } catch (e) {
                console.warn("DB not available for saveKV, caching disabled for this item.", e);
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
        if (!textureLoader) {
            throw new Error("dataManager not initialized. Call init() first.");
        }
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

    async function getTileData(satelliteUrl, heightmapUrl) {
        const [satelliteTexture, heightmapTexture] = await Promise.all([
            getCachedTexture(satelliteUrl),
            getCachedTexture(heightmapUrl)
        ]);

        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        const img = heightmapTexture.image;
        canvas.width = img.width;
        canvas.height = img.height;
        context.drawImage(img, 0, 0);
        const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;

        const heightArray = new Float32Array(img.width * img.height);
        for (let i = 0; i < heightArray.length; i++) {
            const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
            const height = (r * 256 + g + b / 256) - 32768;
            heightArray[i] = height * 0.005; // Apply scaling
        }

        return {
            satelliteTexture,
            heights: heightArray,
            width: img.width,
            height: img.height,
        };
    }

    return {
        init: (loader) => {
            textureLoader = loader;
            dbCache.init();
        },

        getTileData,

        getCachedTileUrl: async (url) => {
            try {
                return await getCachedBlobUrl(url);
            } catch (error) {
                console.error(`Failed to get cached tile URL for ${url}`, error);
                return url; // Fallback to original url on error
            }
        },

        // Generic KV access backed by IndexedDB (used for small cached items)
        getKV: async (key) => {
            try {
                return await dbCache.getKV(key);
            } catch (e) {
                console.error('getKV failed', e);
                return null;
            }
        },

        saveKV: async (key, value) => {
            try {
                return await dbCache.saveKV(key, value);
            } catch (e) {
                console.error('saveKV failed', e);
            }
        },

        searchAddresses: async (query) => {
            if (query.length < 3) {
                return [];
            }
            try {
                const response = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5`);
                if (!response.ok) {
                    console.error("Nominatim search failed:", response.statusText);
                    return [];
                }
                const data = await response.json();
                return data;
            } catch (error) {
                console.error("Error searching address:", error);
                return [];
            }
        },

        lonLatToTileCoords: (lon, lat, zoom) => {
            const n = Math.pow(2, zoom);
            const xtile = n * ((lon + 180) / 360);
            const latRad = lat * Math.PI / 180;
            const ytile = n * (1 - (Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI)) / 2;
            return { x: xtile, y: ytile, z: zoom };
        },

        tileCoordsToLonLat: (xtile, ytile, zoom) => {
            const n = Math.pow(2, zoom);
            const lon_deg = xtile / n * 360.0 - 180.0;
            const lat_rad = Math.atan(Math.sinh(Math.PI * (1 - 2 * ytile / n)));
            const lat_deg = lat_rad * 180.0 / Math.PI;
            return { lat: lat_deg, lon: lon_deg };
        }
    };
})();