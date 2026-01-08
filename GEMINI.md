# PeakyLight: AI Context & Architecture

PeakyLight is a serverless web application that visualizes the difference between astronomical daylight (ideal) and topographical daylight (actual) at any point on Earth. It helps users understand how local terrain (mountains, hills) affects the amount of sunlight they receive.

## 核心 (Core) Purpose
Calculates "sunlight loss" by ray-casting from a location to the sun's position across a 3D terrain model generated from global elevation data.

## 🛠 Technology Stack
- **Frontend:** HTML5, CSS3, Vanilla JavaScript.
- **3D Engine:** [Three.js](https://threejs.org/) (WebGL) for terrain rendering and sun ray-casting.
- **Mapping:** [LeafletJS](https://leafletjs.com/) for 2D location selection.
- **Astronomy:** [SunCalc](https://github.com/mourner/suncalc) for sun position and astronomical sunrise/sunset times.
- **Terrain Data:** AWS Terrain Tiles (Terrarium format) for global elevation data.
- **PDF Export:** jsPDF & jsPDF-AutoTable.
- **Testing:** Playwright.

## 📁 Project Structure & Entry Points
- `index.html` / `peakylight.html`: Main UI entry points.
- `peakylight.js`: Main application logic (State management, 3D scene setup, ray-casting logic, UI updates).
- `mapping.js`: Leaflet map integration and geocoding.
- `data.js`: Data management, tile coordinate conversion, and API fetching (Open-Meteo, AWS Tiles).
- `peakylight.css`: Application styling.
- `mapping.css`: Custom styles for the map component.

## 🧠 Key Logic: Topographical Occlusion
The app determines if a location is "sunlit" at a specific time by:
1. Calculating the sun's altitude and azimuth using SunCalc.
2. Converting the sun's position into a 3D vector in the Three.js scene.
3. Performing a ray-cast from the observer's location toward the sun.
4. Checking for intersections with the `terrainGrid` mesh.

## 🚀 Development Quick Start
- **Local Server:** `npx serve`
- **Tests:** `npx playwright test`
- **Build:** No build step required (Static site).

## 📊 Features for AI to Note
- **3D Visualization:** Real-time rendering of terrain with sun position arcs.
- **Monthly Reports:** Batch calculation of daylight loss across the year.
- **Solar Recommendations:** Estimates solar panel and battery needs based on actual topographical sunlight and climatological cloud cover data.
- **Video Export:** Generates split-screen videos of sunrise/sunset transitions.
