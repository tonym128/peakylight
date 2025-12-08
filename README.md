# PeakyLight

## About

This is a serverless web application to fetch and show you astronomical daylight vs topographical daylight at any place on earth. In short, it shows you how much less sun you will get than your weather forecast for your area predicts.

It shows sunrise and sunset differences on any day of the year, using the topographical layout of the surrounding land. You can get a monthly report and export a video for every day of the year to view the differences.

## How to Use

1.  Open `index.html` or `peakylight.html` in your web browser.

## How to Run

This project consists of static HTML files. To view them, you can open the `.html` files directly in your browser. However, for a more realistic development and testing environment, it's recommended to use a local web server.

You can view the website at https://tonym128.github.io/peakylight/ which would be the same as hosting this yourself.

### Using Python's built-in server

If you have Python installed, you can run a simple web server from the project root directory:

```bash
python -m http.server 8000
```

Then, open your browser and navigate to `http://localhost:8000`.

### Using `serve` (Node.js)

A more feature-rich option is to use the `serve` package.

1.  Install `serve` globally (or as a dev dependency):
    ```bash
    npm install -g serve
    ```

2.  Run the server from the project root:
    ```bash
    serve
    ```

3.  It will give you a URL to open in your browser, typically `http://localhost:3000`.

## How to Dev

1.  Clone the repository.
2.  Install dependencies: `npm install`
3.  Make changes to the code.

## How to Test

1.  Run the tests: `npx playwright test`

## Data Sources

The PeakyLight application utilizes several external data sources and libraries to provide its functionality:

*   **Mapping & Geocoding:**
    *   **LeafletJS:** An open-source JavaScript library for mobile-friendly interactive maps.
    *   **OpenTopoMap:** Provides topographic map tiles.
    *   **Nominatim:** Provides geocoding services from OpenStreetMap data.

*   **3D Visualization & Sun Position:**
    *   **Three.js:** A cross-browser JavaScript library and API used to create and display animated 3D computer graphics in a web browser.
    *   **SunCalc:** A tiny JavaScript library for calculating sun position, sunlight phases (times for sunrise, sunset, dusk, etc.), and lunar position and phases.

*   **Elevation Data:**
    *   **Amazon Web Services (AWS) Terrain Tiles:** Provides elevation data for rendering the 3D terrain.

*   **Location Services:**
    *   **what3words API:** Used to convert 3-word addresses into geographic coordinates (latitude and longitude).

*   **PDF Generation:**
    *   **jsPDF & jsPDF-AutoTable:** Libraries used to generate and export reports as PDF documents.

## License

This project is licensed under the Apache License 2.0. See the [LICENSE](LICENSE) file for details.
