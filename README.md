# Infrastructure Map Explorer

A browser-based map viewer and query tool for infrastructure planning. It uses only open data and has no build step and no backend.

## Layers

| Group | Layer | Source | Loads |
|---|---|---|---|
| Power generation & supply | Conventional power plants | WRI Global Power Plant Database | Worldwide, all zoom levels |
| | Conventional power plants | OpenStreetMap (`power=plant`) | Zoom 7 and closer |
| | Substations | OSM `power=substation` | Zoom 9 and closer |
| | Transmission lines | OSM `power=line` | Zoom 8 and closer |
| Renewable power | Renewable plants (solar, wind, hydro, biomass, geothermal, tidal) | WRI GPPD | Worldwide |
| | Renewable plants | OSM `plant:source` | Zoom 7 and closer |
| | Wind turbines | OSM `generator:source=wind` | Zoom 10 and closer |
| | Solar energy potential: GHI, kWh/m²/day | NASA POWER climatology 2001–2025, 1° grid | Zoom 5 and closer |
| | Wind energy potential: wind speed at 50 m, m/s | NASA POWER climatology, 0.5° × 0.625° grid | Zoom 5 and closer |
| Roads & connectivity | Major roads: motorway, trunk and primary, plus secondary at zoom 11 | OSM `highway` | Zoom 8 and closer |
| | Railways | OSM `railway=rail` | Zoom 8 and closer |
| | Airports & ports | OSM `aeroway`, `landuse=port` | Zoom 6 and closer |
| Population | Population density 2020 (raster) | CIESIN GPWv4 via NASA GIBS | Worldwide |
| | Cities, towns & villages (with population tags) | OSM `place` | Zoom 6 and closer |
| Water sources | Rivers & canals | OSM `waterway` | Zoom 9 and closer |
| | Lakes & reservoirs | OSM `natural=water` | Zoom 8 and closer |
| | Dams, wells, springs & water works | OSM | Zoom 11 and closer |

OSM layers are fetched live from the Overpass API for the current map view. The app tries several Overpass mirrors in turn if one fails.

## Features

- **Layers tab:** toggle each layer, switch basemap (light, dark, OSM, topographic or satellite) and search for a place with Nominatim. Click any feature to see all of its attributes and a link to OSM.
- **Query tab:**
  - *Attribute filters:* filter by name, energy source, minimum capacity in MW, minimum voltage in kV and minimum population. Filters update the map straight away.
  - *Spatial query:* draw a rectangle, polygon or circle, or use the current view. You get:
    - counts per layer, total MW, km of lines or roads and population
    - installed capacity by source, with the renewable share
    - a clickable feature list
    - **GeoJSON / CSV export**
- **Suitability tab (multi-criteria analysis):** a weighted-overlay suitability model for the current view.
  - Presets: Solar park, Wind farm, Industrial park, Data centre, Green hydrogen hub, or Custom.
  - Criteria: distance to substation, transmission line, major road, railway, water source, town or city, existing renewable plants, and distance away from settlements.
  - Each criterion has a weight from 0 to 10, a direction (closer or farther is better) and a maximum distance.
  - You can exclude a buffer around settlements and choose the grid resolution.
  - Output: a red-to-green suitability layer, the area in each score band, the top 5 candidate sites and a CSV export of the grid. Click any cell to see its score breakdown.
  - **Purpose-specific criteria:** each purpose preset sets its own weights, thresholds and hard constraints, with a short explanation of the reasoning.
    - A criterion with weight 0 is marked "not used". Its data is not downloaded and it has no effect on the score, so a parameter that is irrelevant to the purpose (for example, wind speed for a solar park) cannot distort the result.
    - Minimum resource values work as hard exclusions rather than score penalties. For example, a solar park excludes GHI below 4.5 and a wind farm excludes wind below 5 m/s.
  - Scoring: a cell scores `1 − d/max` for "closer is better" and `d/max` for "farther is better". The final score is the weighted mean × 100.
- **Site tab:** click any point to find the nearest substation, transmission line, conventional plant, renewable plant, major road, railway, river, lake or reservoir, and city or town. Each result shows its distance and is drawn on the map, and you can export the results as CSV.

## Run it

Serve the folder over HTTP rather than opening the file directly:

```bash
cd Infra_Map_Platform
python -m http.server 8000
# open http://localhost:8000
```

On Windows you can also double-click `start.bat`.

### Optional: offline copy of the power plant database

The app downloads the WRI GPPD CSV (about 10 MB) from a CDN on first use. To skip that download, or if it is blocked on your network, save the file as `data/global_power_plant_database.csv`:

https://github.com/wri/global-power-plant-database/blob/master/output_database/global_power_plant_database.csv

## Data sources & licences

- OpenStreetMap: © OpenStreetMap contributors, ODbL. https://www.openstreetmap.org/copyright
- WRI Global Power Plant Database v1.3: CC BY 4.0. https://datasets.wri.org/dataset/globalpowerplantdatabase
- GPWv4 Population Density 2020: CIESIN, Columbia University, served by NASA GIBS.
- NASA POWER (solar and wind climatology): free, no key. https://power.larc.nasa.gov
- Nominatim geocoding: follows the [usage policy](https://operations.osmfoundation.org/policies/nominatim/) (light, interactive use).
- Basemaps: Esri Light/Dark Gray Canvas, Esri Streets, OpenStreetMap, OpenTopoMap and Esri World Imagery. None needs an API key, and attribution is shown on the map.

## Notes & limits

- Public Overpass servers are rate-limited, so requests run one at a time. If a layer shows "error", pan the map slightly to retry.
- Layers stop at 6,000 elements per request. Zoom in further if a layer shows "partial".
- OSM coverage and tagging, especially capacity (`plant:output:electricity`) and `population`, vary by region. The GPPD has consistent capacities but was last updated in 2021.
- Area and site results are straight-line (geodesic) measurements, not routed distances.

## Extending

All layers are defined in the `GROUPS` array at the top of `app.js`. To add an OSM layer, add an entry with:

- an Overpass query
- `kind: 'point'` or `kind: 'line'`
- a `minZoom`
- a `color`

To add a raster overlay, add an entry with `kind: 'tile'` and a `L.tileLayer`.
