const mappingManager = (() => {
    let map, marker, leafletTileLayer, MAP_LAYERS;
    let isLocationSelectionMode = false;

    // --- Leaflet Caching Layer ---
    function initCacheLayer() {
        L.TileLayer.Cached = L.TileLayer.extend({
            createTile: function (coords, done) {
                const tile = document.createElement('img');

                const originalOnLoad = L.Util.bind(this._tileOnLoad, this, done, tile);
                const originalOnError = L.Util.bind(this._tileOnError, this, done, tile);

                const customOnLoad = () => {
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

                dataManager.getCachedTileUrl(tileUrl).then(url => {
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
    }

    function initMap(initialState, onLocationChanged) {
        MAP_LAYERS = initialState.layers;
        map = L.map('map').setView([initialState.lat, initialState.lon], initialState.zoom);
        const layerConfig = MAP_LAYERS[initialState.layer]; // Now MAP_LAYERS is defined
        leafletTileLayer = L.tileLayer.cached(layerConfig.leafletUrl, {
            attribution: layerConfig.leafletAttribution
        }).addTo(map);

        marker = L.marker([initialState.lat, initialState.lon]).addTo(map);

        // --- Event Listeners ---
        document.getElementById('locate-btn').addEventListener('click', () => {
            if (navigator.geolocation) {
                navigator.geolocation.getCurrentPosition(position => {
                    const newLocation = { lat: position.coords.latitude, lon: position.coords.longitude };
                    map.setView([newLocation.lat, newLocation.lon], map.getZoom());
                    marker.setLatLng([newLocation.lat, newLocation.lon]);
                    onLocationChanged(newLocation);
                });
            }
        });

        document.getElementById('update-coords-btn').addEventListener('click', () => {
            const lat = parseFloat(document.getElementById('lat-input').value);
            const lon = parseFloat(document.getElementById('lon-input').value);
            if (!isNaN(lat) && !isNaN(lon)) {
                const newLocation = { lat, lon };
                map.setView([lat, lon], map.getZoom());
                marker.setLatLng([lat, lon]);
                onLocationChanged(newLocation);
            }
        });

        const debouncedAddressSearch = debounce(async (query) => {
            if (query.length < 3) {
                document.getElementById('address-results').innerHTML = '';
                return;
            }
            const data = await dataManager.searchAddresses(query);
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
                const newLocation = { lat, lon };
                map.setView([lat, lon], map.getZoom());
                marker.setLatLng([lat, lon]);
                onLocationChanged(newLocation);
                document.getElementById('address-results').innerHTML = '';
                document.getElementById('address-search').value = e.target.textContent;
            }
        });

        const selectLocationBtn = document.getElementById('select-location-btn');

        function enterSelectionMode() {
            isLocationSelectionMode = true;
            document.getElementById('webgl-canvas').style.cursor = 'crosshair';
            selectLocationBtn.textContent = 'Cancel Selection';
            selectLocationBtn.style.backgroundColor = '#dc3545';
            if (window.controls) window.controls.enableRotate = false;
        }

        function exitSelectionMode() {
            isLocationSelectionMode = false;
            document.getElementById('webgl-canvas').style.cursor = 'grab';
            selectLocationBtn.textContent = 'Select Location on Map';
            selectLocationBtn.style.backgroundColor = '';
            if (window.controls) window.controls.enableRotate = true;
        }

        selectLocationBtn.addEventListener('click', () => {
            if (isLocationSelectionMode) {
                exitSelectionMode();
            } else {
                enterSelectionMode();
            }
        });

        return {
            isSelectionModeActive: () => isLocationSelectionMode,
            exitSelectionMode: exitSelectionMode,
            getMap: () => map,
            getMarker: () => marker,
        };
    }

    function switchMapLayer(layerKey, onLayerChanged) {
        if (!MAP_LAYERS[layerKey]) return;

        if (leafletTileLayer) {
            map.removeLayer(leafletTileLayer);
        }
        const layerConfig = MAP_LAYERS[layerKey];
        leafletTileLayer = L.tileLayer.cached(layerConfig.leafletUrl, {
            attribution: layerConfig.leafletAttribution
        }).addTo(map);

        onLayerChanged(layerKey);
    }

    function updateMapState(location, zoom) {
        if (map) {
            map.setView([location.lat, location.lon], zoom);
        }
        if (marker) {
            marker.setLatLng([location.lat, location.lon]);
        }
    }

    initCacheLayer();

    return {
        init: initMap,
        switchMapLayer,
        updateMapState,
    };
})();