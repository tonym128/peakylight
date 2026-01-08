# Copilot Instructions for PeakyLight

## Project Overview
PeakyLight is a serverless, static web application for visualizing the difference between astronomical and topographical daylight at any location on Earth. It uses 3D terrain rendering and sun position calculations to show how local topography affects sunlight duration, with features for daily, monthly, and yearly analysis, including video and PDF export.

## Key Components
- **peakylight.js**: Main application logic, 3D scene setup (Three.js), sun/terrain calculations, UI event handling.
- **mapping.js**: Likely handles map display and geocoding (uses LeafletJS, OpenTopoMap, Nominatim).
- **data.js**: Data management, tile fetching, and caching.
- **peakylight.html / index.html**: Entry points; contain UI and canvas elements.
- **peakylight.css**: Styles for the app.

## Developer Workflows
-- **Run Locally**: Use a static server (recommended: `serve`). Open `index.html` or `peakylight.html` in your browser.

	Examples:

	```bash
	# run with npx on port 3000 (no global install)
	npx serve -l 3000

	# or run with a specific port after installing globally
	serve -l 8000
	```
- **Install Dependencies**: `npm install` (for Playwright tests and optional Node.js tooling).
- **Testing**: Run `npx playwright test` for end-to-end tests.

## Patterns & Conventions
- **3D Rendering**: Uses Three.js for terrain and sun visualization. Terrain tiles are loaded dynamically based on map zoom and location.
- **Sunlight Calculation**: Uses SunCalc for astronomical times, then raycasts against 3D terrain to compute topographical sunrise/sunset.
- **Caching**: Yearly topographical times are cached for video/report export.
- **UI State**: State is synced to the URL for shareability and reproducibility.
- **External Data**: Elevation from AWS Terrain Tiles, map tiles from OpenTopoMap/OSM, geocoding via Nominatim.
- **Export**: Supports PDF (jsPDF) and video (MediaRecorder) export of reports/visualizations.

## Project-Specific Advice
- **Performance**: Minimize terrain reloads by checking for significant location/zoom changes before fetching new data.
- **Async Patterns**: Many UI updates and calculations are async (e.g., terrain loading, topo time calculation). Use `await` where needed.
- **Testing**: Playwright tests expect no blocking alerts; use non-blocking error handling.
- **Customization**: Map layers and terrain detail are user-selectable; update UI and state accordingly.

## Examples
- To add a new map layer, update `mapLayerConfigs` in `peakylight.js` and ensure UI pickers are synced.
- For new export formats, see the `exportVideo` and `exportSplitScreenVideo` functions in `peakylight.js`.
- For new data sources, integrate in `data.js` and update fetch logic in `peakylight.js`.

## References
- See [README.md](../../README.md) for setup, usage, and data source details.
- Key logic: [peakylight.js](../peakylight.js), [mapping.js](../mapping.js), [data.js](../data.js)

---
If any section is unclear or missing important project-specific details, please provide feedback for further refinement.
