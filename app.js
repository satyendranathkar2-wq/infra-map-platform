/* Infrastructure Map Explorer
 * Map view + query platform built entirely on open data:
 *  - OpenStreetMap (live via the Overpass API)
 *  - WRI Global Power Plant Database (CSV, CC BY 4.0)
 *  - CIESIN GPWv4 population density (tiles via NASA GIBS)
 *  - Nominatim geocoding
 */
'use strict';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// Tried in order: a local copy (see README) first, then CDN mirrors of the WRI repo.
const GPPD_URLS = [
  'data/global_power_plant_database.csv',
  'https://cdn.jsdelivr.net/gh/wri/global-power-plant-database@master/output_database/global_power_plant_database.csv',
  'https://raw.githubusercontent.com/wri/global-power-plant-database/master/output_database/global_power_plant_database.csv',
];

const OVERPASS_LIMIT = 6000;      // max elements per layer request
const MAX_FEATURES_PER_LAYER = 40000;
const INITIAL_VIEW = { center: [22.5, 79], zoom: 5 };

const RENEWABLE = new Set(['solar', 'wind', 'hydro', 'biomass', 'geothermal', 'tidal']);
const RENEW_RE = 'solar|wind|hydro|biomass|biogas|biofuel|geothermal|tidal|wave';

const SOURCE_COLORS = {
  solar: '#e8a500', wind: '#2ea8d8', hydro: '#1d4fbf', biomass: '#4f9a2f',
  geothermal: '#c2410c', tidal: '#0f8b8d',
  coal: '#3b3b3b', gas: '#e07b24', oil: '#8b5a2b', nuclear: '#8e44ad',
  waste: '#7d8c8d', storage: '#d63384', other: '#9aa5b1',
};
const ALL_SOURCES = Object.keys(SOURCE_COLORS);

// All basemaps below work without an API key.
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
const BASEMAPS = {
  'Light gray (Esri)': L.tileLayer(ESRI + 'Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles © Esri — Esri, HERE, Garmin, © OpenStreetMap contributors', maxNativeZoom: 16, maxZoom: 20 }),
  'Dark gray (Esri)': L.tileLayer(ESRI + 'Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles © Esri — Esri, HERE, Garmin, © OpenStreetMap contributors', maxNativeZoom: 16, maxZoom: 20 }),
  'OpenStreetMap': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors', maxZoom: 19 }),
  'Streets (Esri)': L.tileLayer(ESRI + 'World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles © Esri — Esri, HERE, Garmin, © OpenStreetMap contributors', maxZoom: 19 }),
  'Topographic (OpenTopoMap)': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)', maxZoom: 17 }),
  'Satellite (Esri)': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics', maxZoom: 19 }),
};

/* Layer definitions.
 * kind: 'point' | 'line'  -> live OSM via Overpass (bbox of current view)
 *       'gppd'            -> WRI Global Power Plant Database (global, loaded once)
 *       'tile'            -> raster tile overlay
 */
const GROUPS = [
  {
    id: 'power', name: 'Power generation & supply', layers: [
      { id: 'gppd_conv', name: 'Power plants – conventional (WRI GPPD)', kind: 'gppd', renewable: false, plant: true, color: SOURCE_COLORS.coal, on: true },
      { id: 'osm_plants_conv', name: 'Power plants – conventional (OSM)', kind: 'point', minZoom: 7, plant: true, color: SOURCE_COLORS.gas,
        query: () => `nwr["power"="plant"]["plant:source"!~"${RENEW_RE}"];` },
      { id: 'substations', name: 'Substations', kind: 'point', minZoom: 9, voltage: true, color: '#b03a2e',
        query: (z) => z >= 12 ? 'nwr["power"="substation"];' : 'nwr["power"="substation"]["substation"!~"minor_distribution|distribution"];' },
      { id: 'tx_lines', name: 'Transmission lines', kind: 'line', minZoom: 8, voltage: true, color: '#d9534f',
        query: () => 'way["power"="line"];' },
    ],
  },
  {
    id: 'renewable', name: 'Renewable power', layers: [
      { id: 'gppd_ren', name: 'Renewable plants (WRI GPPD)', kind: 'gppd', renewable: true, plant: true, color: SOURCE_COLORS.solar, on: true },
      { id: 'osm_plants_ren', name: 'Renewable plants – solar/wind/hydro… (OSM)', kind: 'point', minZoom: 7, plant: true, color: SOURCE_COLORS.wind,
        query: () => `nwr["power"="plant"]["plant:source"~"${RENEW_RE}"];` },
      { id: 'wind_turbines', name: 'Wind turbines (OSM)', kind: 'point', minZoom: 10, plant: true, color: SOURCE_COLORS.wind,
        query: () => 'node["power"="generator"]["generator:source"="wind"];' },
      { id: 'solar_res', name: 'Solar energy potential – GHI (NASA POWER)', kind: 'resource', param: 'ALLSKY_SFC_SW_DWN', minZoom: 5, color: '#fd8d3c' },
      { id: 'wind_res', name: 'Wind energy potential – speed @50 m (NASA POWER)', kind: 'resource', param: 'WS50M', minZoom: 5, color: '#4292c6' },
    ],
  },
  {
    id: 'roads', name: 'Roads & connectivity', layers: [
      { id: 'roads', name: 'Major roads', kind: 'line', minZoom: 8, color: '#e67e22',
        key: (z) => z >= 11 ? 'sec' : 'pri',
        query: (z) => `way["highway"~"^(motorway|trunk|primary${z >= 11 ? '|secondary' : ''})$"];` },
      { id: 'railways', name: 'Railways', kind: 'line', minZoom: 8, color: '#6c4f9e',
        query: () => 'way["railway"="rail"]["service"!~"."];' },
      { id: 'airports_ports', name: 'Airports & ports', kind: 'point', minZoom: 6, color: '#2c3e50',
        query: () => 'nwr["aeroway"="aerodrome"]["aerodrome:type"!~"private"];nwr["landuse"="port"];nwr["industrial"="port"];' },
    ],
  },
  {
    id: 'population', name: 'Population', layers: [
      { id: 'pop_density', name: 'Population density 2020 (GPWv4)', kind: 'tile', color: '#bd0026',
        tile: L.tileLayer('https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GPW_Population_Density_2020/default/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png', {
          attribution: 'CIESIN GPWv4 / NASA GIBS', maxNativeZoom: 7, maxZoom: 20, opacity: 0.6 }) },
      { id: 'settlements', name: 'Cities, towns & villages', kind: 'point', minZoom: 6, settlement: true, color: '#7b3fa0',
        key: (z) => (z >= 11 ? 'v' : z >= 8 ? 't' : 'c'),
        query: (z) => `node["place"~"^(${z >= 11 ? 'city|town|village' : z >= 8 ? 'city|town' : 'city'})$"];` },
    ],
  },
  {
    id: 'water', name: 'Water sources', layers: [
      { id: 'rivers', name: 'Rivers & canals', kind: 'line', minZoom: 9, color: '#2f80ed',
        query: () => 'way["waterway"~"^(river|canal)$"];' },
      { id: 'lakes', name: 'Lakes & reservoirs', kind: 'point', minZoom: 8, color: '#1aa3c9',
        query: () => 'nwr["natural"="water"]["water"~"^(lake|reservoir)$"];nwr["landuse"="reservoir"];' },
      { id: 'water_infra', name: 'Dams, wells, springs & water works', kind: 'point', minZoom: 11, color: '#0b5d7a',
        query: () => 'nwr["waterway"="dam"];nwr["man_made"~"^(water_works|wastewater_plant|water_tower|water_well|reservoir_covered)$"];node["natural"="spring"];' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);
const fmt = (n, d = 0) => (n == null || isNaN(n)) ? '–' : Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function normSource(raw) {
  const s = String(raw || '').toLowerCase().split(/[;,]/)[0].trim();
  if (!s) return 'other';
  if (s.includes('tidal') || s.includes('wave')) return 'tidal';
  if (/^(bio|biomass|biogas|biofuel)/.test(s)) return 'biomass';
  if (/^(oil|diesel|petcoke|gasoline|fuel_oil)/.test(s)) return 'oil';
  if (/^(battery|storage)/.test(s)) return 'storage';
  if (s === 'hydro' || s === 'water') return 'hydro';
  return SOURCE_COLORS[s] ? s : 'other';
}

// "500 MW", "1.2 GW", "1,200 MW", "800 kW", "yes" -> megawatts (or null)
function parseMW(v) {
  if (!v) return null;
  const str = String(v).replace(/(\d),(\d{3})/g, '$1$2').replace(',', '.');
  const m = str.match(/([\d.]+)\s*(gw|mw|kw|w)?/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (isNaN(n)) return null;
  const u = (m[2] || 'mw').toLowerCase();
  return u === 'gw' ? n * 1000 : u === 'kw' ? n / 1000 : u === 'w' ? n / 1e6 : n;
}

// voltage tag is in volts, may be "400000;220000" -> highest kV
function parseKV(v) {
  if (!v) return null;
  const vals = String(v).split(/[;,]/).map((x) => parseFloat(x)).filter((x) => !isNaN(x));
  return vals.length ? Math.max(...vals) / 1000 : null;
}

function parsePop(v) {
  if (!v) return null;
  const n = parseInt(String(v).replace(/[\s,.]/g, ''), 10);
  return isNaN(n) ? null : n;
}

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

let statusTimer;
function showStatus(msg, sticky = false) {
  const el = $('#status');
  clearTimeout(statusTimer);
  if (!msg) { el.hidden = true; return; }
  el.textContent = msg;
  el.hidden = false;
  if (!sticky) statusTimer = setTimeout(() => (el.hidden = true), 4000);
}

// ---------------------------------------------------------------------------
// Map setup
// ---------------------------------------------------------------------------

const map = L.map('map', {
  preferCanvas: true, zoomControl: true, minZoom: 3,
  maxBounds: [[-85, -200], [85, 200]], maxBoundsViscosity: 1,
}).setView(INITIAL_VIEW.center, INITIAL_VIEW.zoom);
const canvas = L.canvas({ padding: 0.5, tolerance: 4 });
L.control.scale({ imperial: false }).addTo(map);

let currentBase = BASEMAPS['Light gray (Esri)'].addTo(map);
const baseSelect = $('#basemap-select');
Object.keys(BASEMAPS).forEach((k) => baseSelect.add(new Option(k, k)));
baseSelect.addEventListener('change', () => {
  map.removeLayer(currentBase);
  currentBase = BASEMAPS[baseSelect.value].addTo(map);
  currentBase.bringToBack();
});

// ---------------------------------------------------------------------------
// Layer state
// ---------------------------------------------------------------------------

const state = {};   // layerId -> { def, enabled, features: Map, group: L.LayerGroup, loaded: [], statusEl }
GROUPS.forEach((g) => g.layers.forEach((def) => {
  state[def.id] = { def, enabled: false, features: new Map(), group: L.layerGroup(), loaded: [], queued: false, statusEl: null };
}));

const filters = { name: '', sources: new Set(ALL_SOURCES), mw: 0, kv: 0, pop: 0 };
let mcaOverlay = null;   // suitability raster from the multi-criteria analysis

function passes(f, def) {
  const p = f.properties;
  if (filters.name && !String(p.name || '').toLowerCase().includes(filters.name)) return false;
  if (def.plant) {
    if (!filters.sources.has(p._source)) return false;
    if (filters.mw > 0 && !(p._mw >= filters.mw)) return false;
  }
  if (def.voltage && filters.kv > 0 && !(p._kv >= filters.kv)) return false;
  if (def.settlement && filters.pop > 0 && !(p._pop >= filters.pop)) return false;
  return true;
}

// Plant markers shrink when zoomed out so national/global views stay readable.
function zoomScale(z = map.getZoom()) {
  return z <= 3 ? 0.3 : z <= 4 ? 0.4 : z <= 5 ? 0.55 : z <= 6 ? 0.7 : z <= 8 ? 0.85 : 1;
}

function plantRadius(p) {
  const r = p._mw ? Math.min(16, 3 + Math.sqrt(p._mw) / 2.5) : 4;
  return Math.max(1.5, r * zoomScale());
}

function pointStyle(f, def) {
  const p = f.properties;
  if (def.plant) {
    const z = map.getZoom();
    return { renderer: canvas, bubblingMouseEvents: false, radius: plantRadius(p), color: '#fff', weight: z <= 5 ? 0.3 : 0.8,
      fillColor: SOURCE_COLORS[p._source] || def.color, fillOpacity: z <= 5 ? 0.75 : 0.85 };
  }
  if (def.settlement) {
    const r = p._pop ? Math.min(16, 2 + Math.log10(p._pop + 1) * 1.8) : 3;
    return { renderer: canvas, bubblingMouseEvents: false, radius: r, color: '#fff', weight: 0.6, fillColor: def.color, fillOpacity: 0.7 };
  }
  if (def.voltage) {
    const r = p._kv >= 220 ? 7 : p._kv >= 66 ? 5 : 4;
    return { renderer: canvas, bubblingMouseEvents: false, radius: r, color: '#fff', weight: 0.8, fillColor: def.color, fillOpacity: 0.9 };
  }
  return { renderer: canvas, bubblingMouseEvents: false, radius: 5, color: '#fff', weight: 0.8, fillColor: def.color, fillOpacity: 0.85 };
}

let lastScale = zoomScale();
map.on('zoomend', () => {
  const s = zoomScale();
  if (s === lastScale) return;
  lastScale = s;
  Object.values(state).forEach((st) => { if (st.def.plant && st.enabled) render(st.def.id); });
});

function lineStyle(f, def) {
  const p = f.properties;
  let weight = 1.5;
  if (def.id === 'tx_lines') weight = p._kv >= 400 ? 3 : p._kv >= 220 ? 2.2 : p._kv >= 110 ? 1.6 : 1.1;
  if (def.id === 'roads') weight = { motorway: 3.2, trunk: 2.6, primary: 2, secondary: 1.2 }[p.highway] || 1.2;
  if (def.id === 'rivers') weight = p.waterway === 'river' ? 1.8 : 1.2;
  return { renderer: canvas, bubblingMouseEvents: false, color: def.color, weight, opacity: 0.85, dashArray: def.id === 'railways' ? '6 4' : null };
}

function popupHtml(f, def) {
  const p = f.properties;
  const rows = [];
  if (p._source && def.plant) rows.push(['source', p._source]);
  if (p._mw) rows.push(['capacity', `${fmt(p._mw, 1)} MW`]);
  if (p._kv) rows.push(['voltage', `${fmt(p._kv)} kV`]);
  if (p._pop) rows.push(['population', fmt(p._pop)]);
  Object.entries(p).forEach(([k, v]) => {
    if (!k.startsWith('_') && v !== '' && v != null && k !== 'name') rows.push([k, v]);
  });
  const link = p._osm ? `<p><a href="https://www.openstreetmap.org/${p._osm}" target="_blank" rel="noopener">View on OpenStreetMap ↗</a></p>` : '';
  return `<strong>${esc(p.name || def.name)}</strong><br><span style="color:#667">${esc(def.name)}</span>
    <table class="popup-table">${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>${link}`;
}

function toLeaflet(f, def) {
  const g = f.geometry;
  const m = g.type === 'Point'
    ? L.circleMarker([g.coordinates[1], g.coordinates[0]], pointStyle(f, def))
    : L.polyline(g.coordinates.map(([x, y]) => [y, x]), lineStyle(f, def));
  m.bindPopup(() => popupHtml(f, def));
  m.feature = f;
  f._leaflet = m;
  return m;
}

function render(id) {
  const st = state[id];
  if (st.def.kind === 'tile' || st.def.kind === 'resource') return;
  st.group.clearLayers();
  st.features.forEach((f) => { if (passes(f, st.def)) st.group.addLayer(toLeaflet(f, st.def)); });
}

function setLayerStatus(st, text, isErr = false) {
  if (!st.statusEl) return;
  st.statusEl.textContent = text;
  st.statusEl.classList.toggle('err', isErr);
}

function countLabel(st) {
  let n = 0;
  st.features.forEach((f) => { if (passes(f, st.def)) n++; });
  return fmt(n);
}

// ---------------------------------------------------------------------------
// OSM / Overpass loading
// ---------------------------------------------------------------------------

async function overpass(query) {
  let lastErr;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
      });
      if (!res.ok) { lastErr = new Error(`${new URL(url).host}: HTTP ${res.status}`); continue; }
      return await res.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Overpass unavailable');
}

function osmToFeature(el, kind) {
  let geometry;
  if (el.type === 'node') geometry = { type: 'Point', coordinates: [el.lon, el.lat] };
  else if (kind === 'line' && el.geometry) {
    const coords = el.geometry.filter(Boolean).map((p) => [p.lon, p.lat]);
    if (coords.length < 2) return null;
    geometry = { type: 'LineString', coordinates: coords };
  } else if (el.center) geometry = { type: 'Point', coordinates: [el.center.lon, el.center.lat] };
  else return null;
  return { type: 'Feature', id: `${el.type}/${el.id}`, properties: enrich({ ...(el.tags || {}), _osm: `${el.type}/${el.id}` }), geometry };
}

function enrich(p) {
  if (p.power === 'plant' || p.power === 'generator') {
    p._source = normSource(p['plant:source'] || p['generator:source']);
    p._mw = parseMW(p['plant:output:electricity'] || p['generator:output:electricity']);
  }
  if (p.voltage) p._kv = parseKV(p.voltage);
  if (p.population) p._pop = parsePop(p.population);
  return p;
}

// Requests are serialized: public Overpass servers allow only a couple of concurrent slots.
// force=true loads a layer even when it is switched off (used by the multi-criteria analysis).
const jobs = [];
let jobRunning = false;
function enqueue(st, force = false) {
  if (st.queuedPromise) { st.force = st.force || force; return st.queuedPromise; }
  st.force = force;
  st.queuedPromise = new Promise((resolve) => jobs.push({ st, resolve }));
  pump();
  return st.queuedPromise;
}
async function pump() {
  if (jobRunning || !jobs.length) return;
  jobRunning = true;
  const { st, resolve } = jobs.shift();
  const force = st.force;
  st.queuedPromise = null;
  st.force = false;
  try { await loadOsmLayer(st, force); } finally { jobRunning = false; resolve(); pump(); }
}

async function loadOsmLayer(st, force = false) {
  const { def } = st;
  if (!st.enabled && !force) return;
  const z = map.getZoom();
  if (z < def.minZoom) { setLayerStatus(st, `zoom in (z≥${def.minZoom})`); return; }
  const key = def.key ? def.key(z) : '';
  const view = map.getBounds();
  if (st.loaded.some((l) => l.key === key && l.bounds.contains(view))) { setLayerStatus(st, countLabel(st)); return; }

  const b = view.pad(0.15);
  const bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((v) => v.toFixed(4)).join(',');
  const q = `[out:json][timeout:90][bbox:${bbox}];(${def.query(z)});out tags ${def.kind === 'line' ? 'geom' : 'center'} ${OVERPASS_LIMIT};`;

  setLayerStatus(st, 'loading…');
  showStatus(`Loading ${def.name}…`, true);
  try {
    const data = await overpass(q);
    if (st.features.size > MAX_FEATURES_PER_LAYER) { st.features.clear(); st.loaded = []; }
    (data.elements || []).forEach((el) => {
      const f = osmToFeature(el, def.kind);
      if (f) { f.properties._layer = def.id; st.features.set(f.id, f); }
    });
    const truncated = (data.elements || []).length >= OVERPASS_LIMIT;
    // A truncated result does not fully cover the area, so don't mark it as loaded.
    if (!truncated) st.loaded.push({ key, bounds: b });
    render(def.id);
    setLayerStatus(st, countLabel(st) + (truncated ? ' (partial – zoom in)' : ''));
    showStatus(null);
  } catch (e) {
    console.error(def.id, e);
    setLayerStatus(st, 'error – retry by panning', true);
    showStatus(`Could not load ${def.name}: ${e.message}`);
  }
  updateLegend();
}

const refreshVisible = debounce(() => {
  Object.values(state).forEach((st) => {
    if (st.enabled && (st.def.kind === 'point' || st.def.kind === 'line')) enqueue(st);
    if (st.enabled && st.def.kind === 'resource') renderResource(st);
  });
}, 500);
map.on('moveend', refreshVisible);

// ---------------------------------------------------------------------------
// WRI Global Power Plant Database
// ---------------------------------------------------------------------------

let gppdPromise = null;
function loadGPPD() {
  if (gppdPromise) return gppdPromise;
  gppdPromise = (async () => {
    showStatus('Loading Global Power Plant Database (~10 MB)…', true);
    let text = null, lastErr;
    for (const url of GPPD_URLS) {
      try {
        const res = await fetch(url);
        if (res.ok) { text = await res.text(); break; }
        lastErr = new Error(`HTTP ${res.status}`);
      } catch (e) { lastErr = e; }
    }
    if (!text) throw lastErr || new Error('GPPD unavailable');
    const rows = parseCSV(text);
    const head = rows.shift();
    const ix = Object.fromEntries(head.map((h, i) => [h, i]));
    const feats = [];
    for (const r of rows) {
      const lat = parseFloat(r[ix.latitude]), lon = parseFloat(r[ix.longitude]);
      if (isNaN(lat) || isNaN(lon)) continue;
      const fuel = r[ix.primary_fuel];
      const props = {
        name: r[ix.name],
        country: r[ix.country_long],
        primary_fuel: fuel,
        capacity_mw: r[ix.capacity_mw],
        commissioning_year: r[ix.commissioning_year] ? Math.round(parseFloat(r[ix.commissioning_year])) : '',
        owner: r[ix.owner],
        other_fuel: [r[ix.other_fuel1], r[ix.other_fuel2], r[ix.other_fuel3]].filter(Boolean).join(', '),
        dataset: 'WRI Global Power Plant Database',
        gppd_id: r[ix.gppd_idnr],
        _source: normSource(fuel),
        _mw: parseFloat(r[ix.capacity_mw]) || null,
      };
      feats.push({ type: 'Feature', id: 'gppd/' + r[ix.gppd_idnr], properties: props, geometry: { type: 'Point', coordinates: [lon, lat] } });
    }
    showStatus(`Global Power Plant Database: ${fmt(feats.length)} plants loaded`);
    return feats;
  })();
  gppdPromise.catch(() => { gppdPromise = null; });
  return gppdPromise;
}

async function enableGPPD(st) {
  if (st.features.size) return;
  setLayerStatus(st, 'loading…');
  try {
    const feats = await loadGPPD();
    feats.forEach((f) => {
      if (RENEWABLE.has(f.properties._source) === st.def.renewable) {
        st.features.set(f.id, { ...f, properties: { ...f.properties, _layer: st.def.id } });
      }
    });
    render(st.def.id);
    setLayerStatus(st, countLabel(st));
  } catch (e) {
    console.error(e);
    setLayerStatus(st, 'failed – see README', true);
    showStatus('Could not download the Global Power Plant Database. See README to use a local copy.');
  }
  updateLegend();
}

// ---------------------------------------------------------------------------
// Layer panel UI
// ---------------------------------------------------------------------------

function buildLayerPanel() {
  const root = $('#layer-groups');
  GROUPS.forEach((g) => {
    const box = document.createElement('div');
    box.className = 'group';
    box.innerHTML = `<div class="group-head"><span>${esc(g.name)}</span><span class="caret">▾</span></div><div class="group-body"></div>`;
    box.querySelector('.group-head').addEventListener('click', () => box.classList.toggle('collapsed'));
    const body = box.querySelector('.group-body');
    g.layers.forEach((def) => {
      const st = state[def.id];
      const shape = def.kind === 'line' ? 'line' : def.kind === 'tile' ? '' : 'dot';
      const zoomNote = def.minZoom ? ` <span class="hint">z≥${def.minZoom}</span>` : '';
      const row = document.createElement('label');
      row.className = 'layer-item';
      row.innerHTML = `<input type="checkbox"><span class="swatch ${shape}" style="background:${def.color}"></span>
        <span class="lname">${esc(def.name)}${zoomNote}</span><span class="lstatus"></span>`;
      st.statusEl = row.querySelector('.lstatus');
      const cb = row.querySelector('input');
      cb.addEventListener('change', () => toggleLayer(def.id, cb.checked));
      body.appendChild(row);
      if (def.on) { cb.checked = true; toggleLayer(def.id, true); }
    });
    root.appendChild(box);
  });
}

function toggleLayer(id, on) {
  const st = state[id];
  st.enabled = on;
  const leafletLayer = st.def.kind === 'tile' ? st.def.tile : st.group;
  if (on) {
    if (st.def.kind !== 'tile' && st.features.size) render(id);
    leafletLayer.addTo(map);
    if (st.def.kind === 'gppd') enableGPPD(st);
    else if (st.def.kind === 'resource') renderResource(st);
    else if (st.def.kind !== 'tile') enqueue(st);
  } else {
    map.removeLayer(leafletLayer);
    setLayerStatus(st, '');
  }
  updateLegend();
}

function updateLegend() {
  const el = $('#legend');
  const on = Object.values(state).filter((s) => s.enabled);
  if (!on.length) { el.innerHTML = ''; return; }
  let html = '';
  if (on.some((s) => s.def.plant)) {
    const used = new Set();
    on.filter((s) => s.def.plant).forEach((s) => s.features.forEach((f) => used.add(f.properties._source)));
    const list = ALL_SOURCES.filter((s) => used.has(s));
    if (list.length) {
      html += '<div class="lg-title">Plant source (size = MW)</div>' +
        list.map((s) => `<div class="lg-item"><i style="background:${SOURCE_COLORS[s]}"></i>${s}</div>`).join('');
    }
  }
  const others = on.filter((s) => !s.def.plant && s.def.kind !== 'tile' && s.def.kind !== 'resource');
  if (others.length) {
    html += '<div class="lg-title">Layers</div>' + others.map((s) =>
      `<div class="lg-item"><i style="background:${s.def.color};${s.def.kind === 'line' ? 'height:3px;border-radius:0' : ''}"></i>${esc(s.def.name)}</div>`).join('');
  }
  if (mcaOverlay && map.hasLayer(mcaOverlay)) {
    html += '<div class="lg-title">Suitability score</div><div class="ramp mca"></div><div style="display:flex;justify-content:space-between"><span>0 low</span><span>100 high</span></div>';
  }
  if (state.pop_density.enabled) {
    html += '<div class="lg-title">Population density</div><div class="ramp"></div><div style="display:flex;justify-content:space-between"><span>low</span><span>high</span></div>';
  }
  const resOn = on.filter((s) => s.def.kind === 'resource');
  resOn.forEach((s) => {
    const R = RESOURCES[s.def.param];
    html += `<div class="lg-title">${esc(R.label)} (annual mean)</div>
      <div class="ramp" style="background:linear-gradient(90deg,${R.ramp.map((c) => `rgb(${c.join(',')})`).join(',')})"></div>
      <div style="display:flex;justify-content:space-between"><span>≤ ${R.lo}</span><span>${R.unit}</span><span>≥ ${R.hi}</span></div>`;
  });
  if (resOn.length) html += '<div id="readout" class="readout"></div>';
  el.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

function buildFilters() {
  const chips = $('#f-sources');
  ALL_SOURCES.forEach((s) => {
    const c = document.createElement('button');
    c.className = 'chip';
    c.innerHTML = `<i style="background:${SOURCE_COLORS[s]}"></i>${s}`;
    c.addEventListener('click', () => {
      if (filters.sources.has(s)) filters.sources.delete(s); else filters.sources.add(s);
      c.classList.toggle('off', !filters.sources.has(s));
      applyFilters();
    });
    chips.appendChild(c);
  });
  const num = (v) => Math.max(0, parseFloat(v) || 0);
  $('#f-name').addEventListener('input', debounce((e) => { filters.name = e.target.value.trim().toLowerCase(); applyFilters(); }, 300));
  $('#f-mw').addEventListener('input', debounce((e) => { filters.mw = num(e.target.value); applyFilters(); }, 300));
  $('#f-kv').addEventListener('input', debounce((e) => { filters.kv = num(e.target.value); applyFilters(); }, 300));
  $('#f-pop').addEventListener('input', debounce((e) => { filters.pop = num(e.target.value); applyFilters(); }, 300));
  $('#f-reset').addEventListener('click', () => {
    filters.name = ''; filters.mw = filters.kv = filters.pop = 0; filters.sources = new Set(ALL_SOURCES);
    ['#f-name', '#f-mw', '#f-kv', '#f-pop'].forEach((s) => ($(s).value = ''));
    chips.querySelectorAll('.chip').forEach((c) => c.classList.remove('off'));
    applyFilters();
  });
}

function applyFilters() {
  Object.values(state).forEach((st) => {
    if (st.enabled && st.def.kind !== 'tile') { render(st.def.id); if (st.features.size) setLayerStatus(st, countLabel(st)); }
  });
  if (queryArea) runAreaQuery(queryArea);
}

// ---------------------------------------------------------------------------
// Spatial query
// ---------------------------------------------------------------------------

const drawn = new L.FeatureGroup().addTo(map);
map.addControl(new L.Control.Draw({
  position: 'topleft',
  draw: {
    polyline: false, marker: false, circlemarker: false,
    rectangle: { showArea: false, shapeOptions: { color: '#1f6feb', weight: 2, fillOpacity: 0.05 } },
    polygon: { showArea: false, shapeOptions: { color: '#1f6feb', weight: 2, fillOpacity: 0.05 } },
    circle: { shapeOptions: { color: '#1f6feb', weight: 2, fillOpacity: 0.05 } },
  },
  edit: { featureGroup: drawn, edit: false, remove: false },
}));

let queryArea = null;
let lastResults = [];

map.on(L.Draw.Event.CREATED, (e) => {
  drawn.clearLayers();
  drawn.addLayer(e.layer);
  let area;
  if (e.layerType === 'circle') {
    const c = e.layer.getLatLng();
    area = turf.circle([c.lng, c.lat], e.layer.getRadius() / 1000, { steps: 72, units: 'kilometers' });
  } else {
    area = e.layer.toGeoJSON();
  }
  queryArea = area;
  switchTab('query');
  runAreaQuery(area);
});

$('#q-view').addEventListener('click', () => {
  const b = map.getBounds();
  drawn.clearLayers();
  queryArea = turf.bboxPolygon([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
  runAreaQuery(queryArea);
});
$('#q-clear').addEventListener('click', () => {
  drawn.clearLayers();
  queryArea = null;
  lastResults = [];
  $('#q-results').innerHTML = '';
});

function inBox(c, bb) { return c[0] >= bb[0] && c[0] <= bb[2] && c[1] >= bb[1] && c[1] <= bb[3]; }

function runAreaQuery(area) {
  const bb = turf.bbox(area);
  const inside = (c) => inBox(c, bb) && turf.booleanPointInPolygon(c, area);
  const areaKm2 = turf.area(area) / 1e6;
  const summary = [];
  lastResults = [];
  const capBySource = { gppd: {}, osm: {} };

  Object.values(state).forEach((st) => {
    const { def } = st;
    if (!st.enabled || def.kind === 'tile' || !st.features.size) return;
    let count = 0, metric = 0;
    st.features.forEach((f) => {
      if (!passes(f, def)) return;
      const g = f.geometry;
      if (g.type === 'Point') {
        if (!inside(g.coordinates)) return;
        count++;
        lastResults.push(f);
        if (def.plant) {
          metric += f.properties._mw || 0;
          const bucket = def.kind === 'gppd' ? capBySource.gppd : capBySource.osm;
          bucket[f.properties._source] = (bucket[f.properties._source] || 0) + (f.properties._mw || 0);
        } else if (def.settlement) metric += f.properties._pop || 0;
      } else {
        const flags = g.coordinates.map(inside);
        if (!flags.some(Boolean)) return;
        count++;
        lastResults.push(f);
        for (let i = 1; i < g.coordinates.length; i++) {
          if (flags[i] && flags[i - 1]) metric += turf.distance(g.coordinates[i - 1], g.coordinates[i], { units: 'kilometers' });
        }
      }
    });
    const unit = def.plant ? 'MW' : def.settlement ? 'people*' : def.kind === 'line' ? 'km' : '';
    summary.push({ name: def.name, count, metric: unit ? metric : null, unit });
  });

  const el = $('#q-results');
  if (!summary.length) {
    el.innerHTML = '<p class="hint">No data loaded yet. Turn on layers in the Layers tab and zoom in so they load, then query again.</p>';
    return;
  }

  // Capacity chart: prefer the GPPD (curated capacities); fall back to OSM if no GPPD hits.
  const useGppd = Object.keys(capBySource.gppd).length > 0;
  const cap = useGppd ? capBySource.gppd : capBySource.osm;
  const capEntries = Object.entries(cap).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const capMax = capEntries.length ? capEntries[0][1] : 1;
  const capTotal = capEntries.reduce((s, [, v]) => s + v, 0);
  const renTotal = capEntries.filter(([k]) => RENEWABLE.has(k)).reduce((s, [, v]) => s + v, 0);

  let html = `<p class="hint">Area ≈ ${fmt(areaKm2)} km² · results reflect loaded data and the active filters.</p>
    <table class="summary"><thead><tr><th>Layer</th><th class="num">Count</th><th class="num">Total</th></tr></thead><tbody>
    ${summary.map((s) => `<tr><td>${esc(s.name)}</td><td class="num">${fmt(s.count)}</td>
      <td class="num">${s.metric != null ? fmt(s.metric, s.unit === 'km' ? 1 : 0) + ' ' + s.unit : ''}</td></tr>`).join('')}
    </tbody></table>`;
  if (summary.some((s) => s.unit === 'people*')) html += '<p class="hint">* Sum of OSM population tags for settlements with a value. Not a census total.</p>';

  if (capEntries.length) {
    html += `<h2>Installed capacity by source (${useGppd ? 'WRI GPPD' : 'OSM'})</h2>
      <p class="hint">Total ${fmt(capTotal)} MW · renewable share ${fmt(capTotal ? (renTotal / capTotal) * 100 : 0, 1)}%</p>` +
      capEntries.map(([k, v]) => `<div class="bar-row"><span class="lbl">${k}</span>
        <span class="bar" style="width:${Math.max(2, (v / capMax) * 150)}px;background:${SOURCE_COLORS[k]}"></span>
        <span class="val">${fmt(v)} MW</span></div>`).join('');
  }

  const listed = lastResults
    .slice()
    .sort((a, b) => (b.properties._mw || b.properties._pop || 0) - (a.properties._mw || a.properties._pop || 0))
    .slice(0, 300);
  html += `<h2>Features (${fmt(lastResults.length)}${lastResults.length > 300 ? ', top 300 shown' : ''})</h2>
    <div class="row"><button class="btn ghost small" id="x-geojson">Export GeoJSON</button><button class="btn ghost small" id="x-csv">Export CSV</button></div>
    <ul class="result-list">${listed.map((f, i) => {
      const p = f.properties;
      const extra = p._mw ? `${fmt(p._mw, 1)} MW · ${p._source}` : p._pop ? `pop. ${fmt(p._pop)}` : p._kv ? `${fmt(p._kv)} kV` : (p.highway || p.waterway || p.railway || '');
      return `<li data-i="${i}">${esc(p.name || '(unnamed)')} <span class="sub">— ${esc(state[p._layer].def.name)}${extra ? ' · ' + esc(extra) : ''}</span></li>`;
    }).join('')}</ul>`;
  el.innerHTML = html;

  el.querySelectorAll('.result-list li').forEach((li) => li.addEventListener('click', () => zoomToFeature(listed[+li.dataset.i])));
  $('#x-geojson').addEventListener('click', () => exportGeoJSON(lastResults));
  $('#x-csv').addEventListener('click', () => exportCSV(lastResults));
  if (drawn.getLayers().length) drawn.getLayers()[0].bringToBack();
}

function zoomToFeature(f) {
  const g = f.geometry;
  if (g.type === 'Point') map.setView([g.coordinates[1], g.coordinates[0]], Math.max(map.getZoom(), 12));
  else map.fitBounds(L.latLngBounds(g.coordinates.map(([x, y]) => [y, x])), { maxZoom: 14 });
  if (f._leaflet && map.hasLayer(f._leaflet)) setTimeout(() => f._leaflet.openPopup(), 350);
}

function cleanProps(p) {
  return Object.fromEntries(Object.entries(p).filter(([k]) => !k.startsWith('_') || ['_layer', '_source', '_mw', '_kv', '_pop', '_osm'].includes(k)));
}

function exportGeoJSON(features) {
  const fc = { type: 'FeatureCollection', features: features.map((f) => ({ type: 'Feature', id: f.id, properties: cleanProps(f.properties), geometry: f.geometry })) };
  download('query_results.geojson', JSON.stringify(fc), 'application/geo+json');
}

function exportCSV(features) {
  const cols = ['id', 'layer', 'name', 'lat', 'lon', 'source', 'capacity_mw', 'voltage_kv', 'population', 'type'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [cols.join(',')];
  features.forEach((f) => {
    const p = f.properties;
    const c = f.geometry.type === 'Point' ? f.geometry.coordinates : turf.centroid(f).geometry.coordinates;
    lines.push([f.id, p._layer, p.name, c[1].toFixed(6), c[0].toFixed(6), p._source, p._mw, p._kv, p._pop,
      p.highway || p.waterway || p.railway || p.power || p.place || p.man_made || p.natural || p.aeroway || ''].map(q).join(','));
  });
  download('query_results.csv', lines.join('\n'), 'text/csv');
}

// ---------------------------------------------------------------------------
// Site proximity analysis
// ---------------------------------------------------------------------------

const SITE_CATEGORIES = [
  { id: 'substation', label: 'Substation', radius: 30, color: '#b03a2e' },
  { id: 'line', label: 'Transmission line', radius: 20, color: '#d9534f' },
  { id: 'plant_conv', label: 'Power plant – conventional/unspecified', radius: 50, color: SOURCE_COLORS.coal },
  { id: 'plant_ren', label: 'Renewable power plant', radius: 50, color: SOURCE_COLORS.solar },
  { id: 'road', label: 'Major road (motorway/trunk/primary)', radius: 15, color: '#e67e22' },
  { id: 'rail', label: 'Railway', radius: 25, color: '#6c4f9e' },
  { id: 'river', label: 'River / canal', radius: 15, color: '#2f80ed' },
  { id: 'lake', label: 'Lake / reservoir', radius: 15, color: '#1aa3c9' },
  { id: 'town', label: 'City / town', radius: 50, color: '#7b3fa0' },
];

const siteLayer = L.layerGroup().addTo(map);
let pickingSite = false;

$('#site-pick').addEventListener('click', () => {
  pickingSite = !pickingSite;
  $('#site-pick').classList.toggle('active', pickingSite);
  $('#site-pick').textContent = pickingSite ? 'Click on the map… (cancel)' : 'Pick site on map';
  map.getContainer().style.cursor = pickingSite ? 'crosshair' : '';
});

map.on('click', (e) => {
  if (!pickingSite) return;
  pickingSite = false;
  $('#site-pick').classList.remove('active');
  $('#site-pick').textContent = 'Pick another site';
  map.getContainer().style.cursor = '';
  e.sitePicked = true;   // tells the MCA click handler to skip this click
  runSiteAnalysis(e.latlng);
});

function siteCategory(t) {
  if (t.power === 'substation') return 'substation';
  if (t.power === 'line') return 'line';
  if (t.power === 'plant') return RENEWABLE.has(normSource(t['plant:source'])) ? 'plant_ren' : 'plant_conv';
  if (t.highway) return 'road';
  if (t.railway) return 'rail';
  if (t.waterway) return 'river';
  if (t.natural === 'water' || t.landuse === 'reservoir') return 'lake';
  if (t.place) return 'town';
  return null;
}

function elementParts(el) {
  const pts = (arr) => arr.filter(Boolean).map((g) => [g.lon, g.lat]);
  if (el.type === 'node') return [[[el.lon, el.lat]]];
  if (el.type === 'way') return el.geometry ? [pts(el.geometry)] : [];
  return (el.members || []).map((m) => (m.type === 'node' && m.lat != null ? [[m.lon, m.lat]] : m.geometry ? pts(m.geometry) : null)).filter((p) => p && p.length);
}

function nearestOnParts(parts, origin) {
  let best = null;
  parts.forEach((part) => {
    if (part.length === 1) {
      const d = turf.distance(origin, part[0], { units: 'kilometers' });
      if (!best || d < best.dist) best = { dist: d, coord: part[0] };
    } else {
      const np = turf.nearestPointOnLine(turf.lineString(part), origin, { units: 'kilometers' });
      if (!best || np.properties.dist < best.dist) best = { dist: np.properties.dist, coord: np.geometry.coordinates };
    }
  });
  return best;
}

async function runSiteAnalysis(latlng) {
  const out = $('#site-results');
  siteLayer.clearLayers();
  L.marker(latlng).addTo(siteLayer);
  switchTab('site');
  out.innerHTML = `<p class="hint">Analysing ${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}… this can take up to a minute.</p>`;

  const { lat, lng } = latlng;
  const R = Object.fromEntries(SITE_CATEGORIES.map((c) => [c.id, c.radius * 1000]));
  const around = (r) => `(around:${r},${lat},${lng})`;
  const q = `[out:json][timeout:120];(
    nwr["power"="substation"]${around(R.substation)};
    way["power"="line"]${around(R.line)};
    nwr["power"="plant"]${around(R.plant_conv)};
    way["highway"~"^(motorway|trunk|primary)$"]${around(R.road)};
    way["railway"="rail"]${around(R.rail)};
    way["waterway"~"^(river|canal)$"]${around(R.river)};
    way["natural"="water"]["water"~"^(lake|reservoir)$"]${around(R.lake)};
    way["landuse"="reservoir"]${around(R.lake)};
    node["place"~"^(city|town)$"]${around(R.town)};
  );out tags geom;`;

  const origin = [lng, lat];
  const best = {};
  const consider = (cat, name, tags, hit) => {
    if (!hit) return;
    if (!best[cat] || hit.dist < best[cat].dist) best[cat] = { ...hit, name, tags };
  };

  // Solar & wind resource at the exact point (NASA POWER point climatology), fetched in parallel.
  const resourcePromise = fetch(`${POWER_API}/point?parameters=ALLSKY_SFC_SW_DWN,WS50M,WS10M&community=RE&longitude=${lng.toFixed(4)}&latitude=${lat.toFixed(4)}&format=JSON`)
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => d?.properties?.parameter || null)
    .catch(() => null);

  try {
    const data = await overpass(q);
    (data.elements || []).forEach((el) => {
      const t = el.tags || {};
      const cat = siteCategory(t);
      if (!cat) return;
      consider(cat, t.name || t.ref || '(unnamed)', t, nearestOnParts(elementParts(el), origin));
    });
  } catch (e) {
    out.innerHTML = `<p class="hint" style="color:#d1453b">Overpass query failed: ${esc(e.message)}. Try again in a moment.</p>`;
    return;
  }

  // Also consider GPPD plants if that dataset is loaded (gives capacity-rated plants).
  if (gppdPromise) {
    try {
      (await gppdPromise).forEach((f) => {
        const d = turf.distance(origin, f.geometry.coordinates, { units: 'kilometers' });
        const cat = RENEWABLE.has(f.properties._source) ? 'plant_ren' : 'plant_conv';
        if (d <= R[cat] / 1000) consider(cat, `${f.properties.name} (${fmt(f.properties._mw)} MW ${f.properties._source}, GPPD)`, f.properties, { dist: d, coord: f.geometry.coordinates });
      });
    } catch { /* GPPD unavailable: OSM results are still shown */ }
  }

  const bounds = L.latLngBounds([latlng]);
  let html = `<p class="hint">Site: ${lat.toFixed(5)}, ${lng.toFixed(5)} · straight-line distances</p>`;

  const res = await resourcePromise;
  const resRows = [];
  if (res) {
    const ghi = res.ALLSKY_SFC_SW_DWN?.ANN, ws50 = res.WS50M?.ANN, ws10 = res.WS10M?.ANN;
    const rate = (v, t) => (v >= t[0] ? 'excellent' : v >= t[1] ? 'good' : v >= t[2] ? 'moderate' : 'low');
    if (ghi > 0) {
      // Rough fixed-tilt PV yield: annual GHI × performance ratio 0.78 ≈ kWh per kWp.
      const yieldKwh = ghi * 365 * 0.78;
      const months = Object.entries(res.ALLSKY_SFC_SW_DWN).filter(([m]) => m !== 'ANN');
      const [bestM] = months.reduce((a, b) => (b[1] > a[1] ? b : a));
      const [worstM] = months.reduce((a, b) => (b[1] < a[1] ? b : a));
      html += `<div class="site-card res"><span class="dist">${ghi.toFixed(2)}</span><div class="cat">Solar energy potential (GHI, kWh/m²/day)</div>
        <div class="nm">${rate(ghi, [5.5, 4.5, 3.5])} · ${fmt(ghi * 365)} kWh/m²/yr</div>
        <div class="hint">Rough PV yield ≈ ${fmt(yieldKwh)} kWh/kWp/yr (CUF ≈ ${fmt(yieldKwh / 87.6, 1)}%) · best ${bestM}, weakest ${worstM}</div></div>`;
      resRows.push(['Solar GHI (kWh/m²/day, annual mean)', '', ghi.toFixed(2), '', '']);
    }
    if (ws50 > 0) {
      html += `<div class="site-card res"><span class="dist">${ws50.toFixed(2)} m/s</span><div class="cat">Wind energy potential (speed at 50 m)</div>
        <div class="nm">${rate(ws50, [7, 6, 5])}${ws10 > 0 ? ` · ${ws10.toFixed(2)} m/s at 10 m` : ''}</div>
        <div class="hint">Modern turbines (100 m+ hubs) typically see higher speeds than at 50 m.</div></div>`;
      resRows.push(['Wind speed 50 m (m/s, annual mean)', '', ws50.toFixed(2), '', '']);
    }
    html += '<p class="hint">Resource: NASA POWER long-term climatology (≈50–100 km grid).</p>';
  } else {
    html += '<p class="hint warn">Solar/wind resource unavailable (NASA POWER did not respond).</p>';
  }
  SITE_CATEGORIES.forEach((c) => {
    const b = best[c.id];
    if (!b) {
      html += `<div class="site-card"><div class="cat">${esc(c.label)}</div><span class="hint">None within ${c.radius} km</span></div>`;
      return;
    }
    const target = [b.coord[1], b.coord[0]];
    bounds.extend(target);
    L.polyline([latlng, target], { color: c.color, weight: 2, dashArray: '5 5' }).addTo(siteLayer)
      .bindTooltip(`${c.label}: ${fmt(b.dist, 2)} km`);
    L.circleMarker(target, { radius: 5, color: '#fff', weight: 1, fillColor: c.color, fillOpacity: 1 }).addTo(siteLayer)
      .bindPopup(`<strong>${esc(b.name)}</strong><br>${esc(c.label)} · ${fmt(b.dist, 2)} km`);
    const kv = parseKV(b.tags.voltage);
    const detail = [kv ? `${fmt(kv)} kV` : '', b.tags.highway || '', b.tags.operator || ''].filter(Boolean).join(' · ');
    html += `<div class="site-card"><span class="dist">${fmt(b.dist, 2)} km</span><div class="cat">${esc(c.label)}</div>
      <div class="nm">${esc(b.name)}</div>${detail ? `<div class="hint">${esc(detail)}</div>` : ''}</div>`;
  });
  html += '<button class="btn ghost small" id="site-csv">Export as CSV</button>';
  out.innerHTML = html;
  map.fitBounds(bounds.pad(0.15), { maxZoom: 13 });

  $('#site-csv').addEventListener('click', () => {
    const rows = [['category', 'name', 'distance_km_or_value', 'lat', 'lon'], ...resRows];
    SITE_CATEGORIES.forEach((c) => {
      const b = best[c.id];
      rows.push(b ? [c.label, b.name, b.dist.toFixed(3), b.coord[1].toFixed(6), b.coord[0].toFixed(6)] : [c.label, `none within ${c.radius} km`, '', '', '']);
    });
    download(`site_${lat.toFixed(4)}_${lng.toFixed(4)}.csv`, rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n'), 'text/csv');
  });
}

// ---------------------------------------------------------------------------
// Place search (Nominatim)
// ---------------------------------------------------------------------------

const searchInput = $('#search-input');
const searchResults = $('#search-results');

async function geocode(q) {
  if (q.length < 3) { searchResults.innerHTML = ''; return; }
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=6&q=${encodeURIComponent(q)}`, { headers: { 'Accept-Language': 'en' } });
    const items = await res.json();
    searchResults.innerHTML = items.map((it, i) => `<li data-i="${i}">${esc(it.display_name)}</li>`).join('') || '<li>No results</li>';
    searchResults.querySelectorAll('li[data-i]').forEach((li) => li.addEventListener('click', () => {
      const it = items[+li.dataset.i];
      const [s, n, w, e] = it.boundingbox.map(Number);
      map.fitBounds([[s, w], [n, e]], { maxZoom: 13 });
      searchResults.innerHTML = '';
      searchInput.value = it.display_name.split(',')[0];
    }));
  } catch {
    searchResults.innerHTML = '<li>Search unavailable</li>';
  }
}
searchInput.addEventListener('input', debounce(() => geocode(searchInput.value.trim()), 600));
searchInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') searchResults.innerHTML = ''; });

// ---------------------------------------------------------------------------
// Solar & wind resource (NASA POWER climatology, 2001–2025 averages)
// ---------------------------------------------------------------------------
/* The regional endpoint returns a grid of long-term annual means (solar ≈1°, wind ≈0.5°).
 * Data is fetched in fixed 10°×10° tiles (the API maximum), cached, and bilinearly
 * interpolated wherever a value is needed. */

const POWER_API = 'https://power.larc.nasa.gov/api/temporal/climatology';
const RESOURCES = {
  ALLSKY_SFC_SW_DWN: {
    short: 'GHI', label: 'Solar irradiance (GHI)', unit: 'kWh/m²/day', lo: 3, hi: 7,
    ramp: [[255, 255, 204], [254, 217, 118], [253, 141, 60], [227, 26, 28], [128, 0, 38]],
  },
  WS50M: {
    short: 'Wind 50 m', label: 'Wind speed at 50 m', unit: 'm/s', lo: 2, hi: 9,
    ramp: [[240, 249, 255], [158, 202, 225], [66, 146, 198], [8, 81, 156], [63, 0, 125]],
  },
};
const resCache = {};   // param -> { tiles: Map(key -> Promise), values: Map("i,j" -> v), lat0, lon0, dLat, dLon }

function rampColor(ramp, t) {
  t = Math.max(0, Math.min(1, t)) * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(t)), f = t - i;
  return ramp[i].map((v, k) => Math.round(v + (ramp[i + 1][k] - v) * f));
}

function ingestResource(param, data) {
  const g = resCache[param];
  const feats = (data.features || []).filter((f) => {
    const v = f.properties?.parameter?.[param]?.ANN;
    return v != null && v > -900;
  });
  if (!feats.length) return;
  if (!g.dLat) {
    const uniq = (arr) => [...new Set(arr.map((v) => +v.toFixed(4)))].sort((a, b) => a - b);
    const minStep = (arr) => arr.slice(1).reduce((m, v, i) => Math.min(m, v - arr[i]), Infinity);
    const lats = uniq(feats.map((f) => f.geometry.coordinates[1]));
    const lons = uniq(feats.map((f) => f.geometry.coordinates[0]));
    g.lat0 = lats[0]; g.lon0 = lons[0];
    g.dLat = isFinite(minStep(lats)) ? minStep(lats) : 1;
    g.dLon = isFinite(minStep(lons)) ? minStep(lons) : 1;
  }
  feats.forEach((f) => {
    const [lon, lat] = f.geometry.coordinates;
    g.values.set(`${Math.round((lat - g.lat0) / g.dLat)},${Math.round((lon - g.lon0) / g.dLon)}`, f.properties.parameter[param].ANN);
  });
}

async function ensureResource(param, bounds) {
  const g = (resCache[param] ||= { tiles: new Map(), values: new Map() });
  const S = Math.max(-90, Math.floor((bounds.getSouth() - 1) / 10) * 10);
  const N = Math.min(90, Math.ceil((bounds.getNorth() + 1) / 10) * 10);
  const W = Math.max(-180, Math.floor((bounds.getWest() - 1) / 10) * 10);
  const E = Math.min(180, Math.ceil((bounds.getEast() + 1) / 10) * 10);
  const tiles = [];
  for (let la = S; la < N; la += 10) for (let lo = W; lo < E; lo += 10) tiles.push([la, lo]);
  if (tiles.length > 20) throw new Error('view too large; zoom in');
  for (const [la, lo] of tiles) {
    const key = `${la},${lo}`;
    if (!g.tiles.has(key)) {
      const url = `${POWER_API}/regional?parameters=${param}&community=RE&latitude-min=${la}&latitude-max=${la + 10}` +
        `&longitude-min=${lo}&longitude-max=${lo + 10}&format=JSON`;
      const p = fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`NASA POWER HTTP ${r.status}`))))
        .then((d) => ingestResource(param, d));
      p.catch(() => g.tiles.delete(key));
      g.tiles.set(key, p);
    }
    await g.tiles.get(key);
  }
}

function sampleResource(param, lat, lon) {
  const g = resCache[param];
  if (!g || !g.dLat) return null;
  const fi = (lat - g.lat0) / g.dLat, fj = (lon - g.lon0) / g.dLon;
  const i0 = Math.floor(fi), j0 = Math.floor(fj), ti = fi - i0, tj = fj - j0;
  let sum = 0, wsum = 0;
  [[0, 0], [1, 0], [0, 1], [1, 1]].forEach(([di, dj]) => {
    const v = g.values.get(`${i0 + di},${j0 + dj}`);
    if (v == null) return;
    const w = (di ? ti : 1 - ti) * (dj ? tj : 1 - tj);
    sum += v * w; wsum += w;
  });
  return wsum > 1e-6 ? sum / wsum : null;
}

// Display layer: interpolated raster for the current view.
async function renderResource(st) {
  const { def } = st;
  const token = (st.renderToken = (st.renderToken || 0) + 1);
  if (map.getZoom() < def.minZoom) { st.group.clearLayers(); setLayerStatus(st, `zoom in (z≥${def.minZoom})`); return; }
  const b = map.getBounds().pad(0.05);
  setLayerStatus(st, 'loading…');
  try {
    await ensureResource(def.param, b);
  } catch (e) {
    setLayerStatus(st, 'error – pan to retry', true);
    showStatus(`Could not load ${def.name}: ${e.message}`);
    return;
  }
  if (!st.enabled || token !== st.renderToken) return;

  const R = RESOURCES[def.param];
  const proj = L.Projection.SphericalMercator;
  const nw = proj.project(b.getNorthWest()), se = proj.project(b.getSouthEast());
  const Wpx = 260, Hpx = Math.max(20, Math.min(500, Math.round(Wpx * (se.y - nw.y) / (se.x - nw.x))));
  const cv = document.createElement('canvas');
  cv.width = Wpx; cv.height = Hpx;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(Wpx, Hpx);
  let vmin = Infinity, vmax = -Infinity;
  for (let r = 0; r < Hpx; r++) {
    const lat = proj.unproject(L.point(0, nw.y + (r + 0.5) / Hpx * (se.y - nw.y))).lat;
    for (let c = 0; c < Wpx; c++) {
      const lon = b.getWest() + (c + 0.5) / Wpx * (b.getEast() - b.getWest());
      const v = sampleResource(def.param, lat, lon);
      if (v == null) continue;
      vmin = Math.min(vmin, v); vmax = Math.max(vmax, v);
      img.data.set([...rampColor(R.ramp, (v - R.lo) / (R.hi - R.lo)), 255], (r * Wpx + c) * 4);
    }
  }
  ctx.putImageData(img, 0, 0);
  st.group.clearLayers();
  st.group.addLayer(L.imageOverlay(cv.toDataURL(), b, { opacity: 0.6, interactive: false }));
  setLayerStatus(st, isFinite(vmin) ? `${vmin.toFixed(1)}–${vmax.toFixed(1)} ${R.unit}` : 'no data');
  updateLegend();
}

// Cursor readout of resource values (shown in the legend).
map.on('mousemove', (e) => {
  const el = document.getElementById('readout');
  if (!el) return;
  const parts = Object.values(state).filter((s) => s.enabled && s.def.kind === 'resource').map((s) => {
    const R = RESOURCES[s.def.param];
    const v = sampleResource(s.def.param, e.latlng.lat, e.latlng.lng);
    return `${R.short}: ${v != null ? v.toFixed(2) : '–'} ${R.unit}`;
  });
  el.textContent = parts.length ? 'At cursor · ' + parts.join(' · ') : '';
});

// ---------------------------------------------------------------------------
// Multi-criteria analysis (weighted overlay suitability)
// ---------------------------------------------------------------------------
/* The current view is split into a grid. Each criterion turns a raw value into a 0–1 score:
 *   distance criteria  "closer is better":  1 − d / max   (0 beyond max)
 *                      "farther is better": d / max       (1 beyond max)
 *   resource criteria  linear from `lo` (0) to `hi` (1), clamped
 * Suitability = weighted mean × 100.
 * Purpose matters: each preset sets its own weights, thresholds and hard constraints.
 * A criterion with weight 0 is "not used". Its data is not loaded and it has no effect,
 * so a parameter that is irrelevant to the purpose (e.g. wind speed for a solar park)
 * cannot distort the result. Hard constraints (settlement buffer, minimum resource)
 * remove cells entirely instead of just lowering their score. */

const MCA_MIN_ZOOM = 9;

const MCA_CRITERIA = [
  { id: 'solar', label: 'Solar irradiance (GHI)', kind: 'value', param: 'ALLSKY_SFC_SW_DWN', lo: 4, hi: 6, min: 0 },
  { id: 'wind', label: 'Wind speed at 50 m', kind: 'value', param: 'WS50M', lo: 4, hi: 7, min: 0 },
  { id: 'substation', label: 'Near substation', kind: 'distance', layers: ['substations'], dir: 'near', max: 30 },
  { id: 'line', label: 'Near transmission line', kind: 'distance', layers: ['tx_lines'], dir: 'near', max: 20 },
  { id: 'road', label: 'Near major road', kind: 'distance', layers: ['roads'], dir: 'near', max: 15 },
  { id: 'rail', label: 'Near railway', kind: 'distance', layers: ['railways'], dir: 'near', max: 25 },
  { id: 'water', label: 'Near water source (river/lake)', kind: 'distance', layers: ['rivers', 'lakes'], dir: 'near', max: 15 },
  { id: 'town', label: 'Near town/city (labour, demand)', kind: 'distance', layers: ['settlements'], dir: 'near', max: 40 },
  { id: 'renewable', label: 'Near existing renewable plants', kind: 'distance', layers: ['osm_plants_ren', 'gppd_ren'], dir: 'near', max: 30 },
  { id: 'settle_far', label: 'Away from settlements (land conflict)', kind: 'distance', layers: ['settlements'], dir: 'far', max: 10 },
];
const CRIT = Object.fromEntries(MCA_CRITERIA.map((c) => [c.id, c]));

/* Per purpose: w = weights (missing = 0 = not used), set = parameter overrides,
 * excl = settlement exclusion buffer (km), why = rationale shown to the user. */
const MCA_PRESETS = {
  'Solar park': {
    why: 'Energy yield scales with solar irradiance, so GHI carries the top weight, and sites below 4.5 kWh/m²/day are excluded. Grid connection cost (substation or line distance) is the next biggest driver. Roads are needed for construction. Some water is needed for panel cleaning. Wind speed and railways do not matter, so they are not used.',
    w: { solar: 10, substation: 9, line: 8, road: 6, water: 3, town: 2, renewable: 2, settle_far: 5 },
    set: { solar: { min: 4.5 }, settle_far: { max: 5 } }, excl: 1,
  },
  'Wind farm': {
    why: 'Turbine power grows with the cube of wind speed, so wind speed dominates, and sites below 5 m/s at 50 m are excluded. Blades and towers are heavy, oversized loads, so road access matters. Turbines need setbacks from villages for noise and shadow flicker. Solar irradiance and water are not relevant.',
    w: { wind: 10, line: 9, substation: 8, road: 8, settle_far: 7, renewable: 3, town: 1 },
    set: { wind: { min: 5 }, settle_far: { max: 3 } }, excl: 0.5,
  },
  'Industrial park': {
    why: 'Industry needs freight access by road and rail, process water, a workforce nearby and a reliable grid. Solar and wind resource and nearby renewable plants are not used.',
    w: { road: 10, water: 8, town: 8, rail: 7, substation: 7, line: 4, settle_far: 2 },
    set: {}, excl: 0.5,
  },
  'Data centre': {
    why: 'Data centres need large, reliable power, so substation proximity comes first. Cooling uses water. Towns provide fibre and staff. Access to green power is a plus. Railways and settlement distance do not matter.',
    w: { substation: 10, line: 8, town: 8, water: 7, road: 5, renewable: 5, solar: 2 },
    set: {}, excl: 0,
  },
  'Green hydrogen hub': {
    why: 'Electrolysis uses about 9 L of water per kg of H₂ and needs cheap renewable electricity. That makes water, solar, wind and nearby renewable plants all important. Product moves by road or rail.',
    w: { water: 10, solar: 7, wind: 6, renewable: 6, substation: 6, road: 6, line: 5, rail: 5, town: 3, settle_far: 3 },
    set: {}, excl: 1,
  },
  'Custom': null,
};

const mca = { weights: {}, dirs: {}, max: {}, lo: {}, hi: {}, min: {}, exclusionKm: 1, resolution: 70, result: null };

function applyPreset(name) {
  const p = MCA_PRESETS[name];
  if (!p) return;
  MCA_CRITERIA.forEach((c) => {
    const o = p.set[c.id] || {};
    mca.weights[c.id] = p.w[c.id] || 0;
    mca.dirs[c.id] = o.dir ?? c.dir;
    mca.max[c.id] = o.max ?? c.max;
    mca.lo[c.id] = o.lo ?? c.lo;
    mca.hi[c.id] = o.hi ?? c.hi;
    mca.min[c.id] = o.min ?? c.min;
  });
  mca.exclusionKm = p.excl;
  $('#mca-excl').value = p.excl;
  $('#mca-why').innerHTML = `<strong>Why these weights:</strong> ${esc(p.why)}`;
  syncCriteriaUI();
}

function critRowHtml(c) {
  const opts = c.kind === 'value'
    ? `<label>0 at <input data-k="lo" type="number" step="0.1"></label>
       <label>100 at <input data-k="hi" type="number" step="0.1"></label>
       <label>exclude &lt; <input data-k="min" type="number" step="0.1" min="0"></label>
       <span>${esc(RESOURCES[c.param].unit)}</span>`
    : `<select data-k="dir" aria-label="Direction">
         <option value="near">closer is better</option><option value="far">farther is better</option>
       </select>
       <label>max <input data-k="max" type="number" min="1" step="1"> km</label>`;
  return `<div class="crit-head"><span>${esc(c.label)}</span><span class="tag">not used</span><span class="w-val"></span></div>
    <input type="range" min="0" max="10" step="1" aria-label="Weight for ${esc(c.label)}">
    <div class="crit-opts">${opts}</div>`;
}

// Push mca state into the inputs; used criteria first, unused ones dimmed at the bottom.
function syncCriteriaUI() {
  const box = $('#mca-criteria');
  const rows = MCA_CRITERIA.map((c) => box.querySelector(`[data-crit="${c.id}"]`));
  rows.forEach((row, k) => {
    const id = MCA_CRITERIA[k].id;
    row.querySelector('input[type=range]').value = mca.weights[id];
    row.querySelector('.w-val').textContent = mca.weights[id];
    row.querySelectorAll('[data-k]').forEach((el) => (el.value = mca[el.dataset.k === 'dir' ? 'dirs' : el.dataset.k][id]));
    row.classList.toggle('unused', !mca.weights[id]);
  });
  rows.sort((a, b) => mca.weights[b.dataset.crit] - mca.weights[a.dataset.crit]).forEach((r) => box.appendChild(r));
  const unused = MCA_CRITERIA.filter((c) => !mca.weights[c.id]).length;
  $('#mca-unused-note').textContent = unused
    ? `${unused} criteria are not used for this purpose (weight 0). Raise a slider to include one.` : '';
}

function buildMcaPanel() {
  const presetSel = $('#mca-preset');
  Object.keys(MCA_PRESETS).forEach((k) => presetSel.add(new Option(k, k)));
  presetSel.addEventListener('change', () => applyPreset(presetSel.value));

  const box = $('#mca-criteria');
  MCA_CRITERIA.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'crit';
    row.dataset.crit = c.id;
    row.innerHTML = critRowHtml(c);
    const range = row.querySelector('input[type=range]');
    range.addEventListener('input', () => {
      mca.weights[c.id] = +range.value;
      row.querySelector('.w-val').textContent = range.value;
      row.classList.toggle('unused', !+range.value);
      presetSel.value = 'Custom';
      $('#mca-why').innerHTML = '<strong>Custom weighting.</strong> Pick a preset to see a recommended setup for a specific purpose.';
    });
    row.querySelectorAll('[data-k]').forEach((el) => el.addEventListener('change', () => {
      const k = el.dataset.k;
      if (k === 'dir') mca.dirs[c.id] = el.value;
      else mca[k][c.id] = k === 'max' ? Math.max(1, +el.value || c.max) : (+el.value || 0);
    }));
    box.appendChild(row);
  });

  $('#mca-excl').addEventListener('change', (e) => (mca.exclusionKm = Math.max(0, +e.target.value || 0)));
  $('#mca-res').addEventListener('change', (e) => (mca.resolution = +e.target.value));
  $('#mca-run').addEventListener('click', runMca);
  $('#mca-clear').addEventListener('click', clearMca);
  $('#mca-opacity').addEventListener('input', (e) => mcaOverlay && mcaOverlay.setOpacity(+e.target.value));
  applyPreset('Solar park');
}

function clearMca() {
  if (mcaOverlay) map.removeLayer(mcaOverlay);
  mcaOverlay = null;
  mcaSitesLayer.clearLayers();
  mca.result = null;
  $('#mca-results').innerHTML = '';
  updateLegend();
}

const mcaSitesLayer = L.layerGroup().addTo(map);

// Score colour ramp: red (0) → amber (50) → green (100)
const SCORE_RAMP = [[215, 48, 39], [252, 141, 89], [254, 224, 139], [145, 207, 96], [26, 152, 80]];
const scoreColor = (s) => rampColor(SCORE_RAMP, s / 100);

async function runMca() {
  const out = $('#mca-results');
  if (map.getZoom() < MCA_MIN_ZOOM) {
    out.innerHTML = `<p class="hint warn">Zoom in to level ${MCA_MIN_ZOOM} or closer (about district scale) first. Search a place in the Layers tab, then zoom in.</p>`;
    return;
  }
  const active = MCA_CRITERIA.filter((c) => mca.weights[c.id] > 0);
  if (!active.length) { out.innerHTML = '<p class="hint warn">Give at least one criterion a weight above 0.</p>'; return; }
  // Resource thresholds act as hard constraints even when a criterion's weight is 0.
  const constraints = MCA_CRITERIA.filter((c) => c.kind === 'value' && mca.min[c.id] > 0);

  const neededLayers = new Set();
  active.filter((c) => c.kind === 'distance').forEach((c) => c.layers.forEach((l) => neededLayers.add(l)));
  if (mca.exclusionKm > 0) neededLayers.add('settlements');
  const neededParams = new Set([...active, ...constraints].filter((c) => c.kind === 'value').map((c) => c.param));

  $('#mca-run').disabled = true;
  try {
    for (const param of neededParams) {
      out.innerHTML = `<p class="hint">Loading ${esc(RESOURCES[param].label)} (NASA POWER)…</p>`;
      try { await ensureResource(param, map.getBounds()); }
      catch (e) { out.innerHTML = `<p class="hint warn">NASA POWER request failed (${esc(e.message)}). Try again.</p>`; return; }
    }
    for (const id of neededLayers) {
      const st = state[id];
      if (st.def.kind === 'gppd') { if (st.enabled) await enableGPPD(st); continue; }
      out.innerHTML = `<p class="hint">Loading ${esc(st.def.name)}…</p>`;
      await enqueue(st, true);
    }
    out.innerHTML = '<p class="hint">Computing suitability…</p>';
    await new Promise((r) => setTimeout(r, 30));
    computeMca(active, constraints);
  } finally {
    $('#mca-run').disabled = false;
  }
}

function computeMca(active, constraints) {
  const b = map.getBounds();
  const W = b.getWest(), E = b.getEast(), S = b.getSouth(), N = b.getNorth();
  const lat0 = (S + N) / 2;
  const kx = 111.32 * Math.cos(lat0 * Math.PI / 180), ky = 110.57;     // km per degree
  const widthKm = (E - W) * kx, heightKm = (N - S) * ky;
  const cols = mca.resolution;
  const cell = widthKm / cols;
  const rows = Math.max(1, Math.round(heightKm / cell));
  const cellH = heightKm / rows;
  const toXY = ([lon, lat]) => [(lon - W) * kx, (N - lat) * ky];       // km from top-left
  const n = cols * rows;
  const cellLatLng = (i) => {
    const r = Math.floor(i / cols), c = i % cols;
    return L.latLng(N - (r + 0.5) * cellH / ky, W + (c + 0.5) * cell / kx);
  };

  // Feature geometry → sample points (lines densified to half a cell), at most one per half-cell.
  function samplePoints(layerIds, reachKm) {
    const step = cell / 2;
    const seen = new Map();
    const add = (x, y) => {
      if (x < -reachKm || y < -reachKm || x > widthKm + reachKm || y > heightKm + reachKm) return;
      const key = `${Math.floor(x / step)},${Math.floor(y / step)}`;
      if (!seen.has(key)) seen.set(key, [x, y]);
    };
    layerIds.forEach((id) => {
      state[id].features.forEach((f) => {
        const g = f.geometry;
        if (g.type === 'Point') { const [x, y] = toXY(g.coordinates); add(x, y); return; }
        for (let i = 1; i < g.coordinates.length; i++) {
          const [x1, y1] = toXY(g.coordinates[i - 1]), [x2, y2] = toXY(g.coordinates[i]);
          const k = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / step));
          for (let s = 0; s <= k; s++) add(x1 + (x2 - x1) * s / k, y1 + (y2 - y1) * s / k);
        }
      });
    });
    return [...seen.values()];
  }

  // Nearest-sample distance for every cell centre, using a bucket grid for speed.
  function distanceGrid(points, reachKm) {
    const d = new Float32Array(n).fill(Infinity);
    if (!points.length) return d;
    const bs = Math.max(cell * 4, 2);
    const buckets = new Map();
    points.forEach((p) => {
      const k = `${Math.floor(p[0] / bs)},${Math.floor(p[1] / bs)}`;
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(p);
    });
    const maxRing = Math.ceil(reachKm / bs) + 1;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = (c + 0.5) * cell, y = (r + 0.5) * cellH;
        const bx = Math.floor(x / bs), by = Math.floor(y / bs);
        let best = Infinity;
        for (let ring = 0; ring <= maxRing; ring++) {
          if (best < (ring - 1) * bs) break;   // nothing in further rings can be closer
          for (let i = -ring; i <= ring; i++) {
            for (let j = -ring; j <= ring; j++) {
              if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
              const list = buckets.get(`${bx + i},${by + j}`);
              if (!list) continue;
              for (const p of list) {
                const dd = Math.hypot(p[0] - x, p[1] - y);
                if (dd < best) best = dd;
              }
            }
          }
        }
        d[r * cols + c] = best;
      }
    }
    return d;
  }

  // Resource values per cell (shared by scoring and constraints).
  const resourceGrids = {};
  const resourceGrid = (param) => resourceGrids[param] ||= Float32Array.from({ length: n }, (_, i) => {
    const ll = cellLatLng(i);
    const v = sampleResource(param, ll.lat, ll.lng);
    return v == null ? NaN : v;
  });

  const totalW = active.reduce((s, c) => s + mca.weights[c.id], 0);
  const score = new Float32Array(n);
  const parts = {};
  const coverage = {};
  active.forEach((c) => {
    const s = new Float32Array(n);
    let raw;
    if (c.kind === 'value') {
      raw = resourceGrid(c.param);
      const lo = mca.lo[c.id], hi = mca.hi[c.id];
      coverage[c.id] = raw.some((v) => !isNaN(v)) ? 1 : 0;
      for (let i = 0; i < n; i++) s[i] = isNaN(raw[i]) ? 0 : Math.max(0, Math.min(1, (raw[i] - lo) / ((hi - lo) || 1)));
    } else {
      const maxKm = mca.max[c.id];
      const pts = samplePoints(c.layers, maxKm);
      coverage[c.id] = pts.length;
      raw = distanceGrid(pts, maxKm);
      for (let i = 0; i < n; i++) {
        s[i] = mca.dirs[c.id] === 'near' ? Math.max(0, 1 - raw[i] / maxKm) : Math.min(1, raw[i] / maxKm);
      }
    }
    for (let i = 0; i < n; i++) score[i] += s[i] * mca.weights[c.id] / totalW;
    parts[c.id] = { score: s, raw };
  });

  // Hard constraints. 0 = ok, 1 = settlement buffer, 2 = resource below minimum.
  const excluded = new Uint8Array(n);
  if (mca.exclusionKm > 0) {
    const d = distanceGrid(samplePoints(['settlements'], mca.exclusionKm), mca.exclusionKm);
    for (let i = 0; i < n; i++) if (d[i] < mca.exclusionKm) excluded[i] = 1;
  }
  constraints.forEach((c) => {
    const raw = resourceGrid(c.param);
    for (let i = 0; i < n; i++) if (!excluded[i] && raw[i] < mca.min[c.id]) excluded[i] = 2;
  });

  // Render the raster to a canvas → image overlay.
  const cv = document.createElement('canvas');
  cv.width = cols; cv.height = rows;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(cols, rows);
  for (let i = 0; i < n; i++) img.data.set([...scoreColor(score[i] * 100), excluded[i] ? 0 : 255], i * 4);
  ctx.putImageData(img, 0, 0);
  if (mcaOverlay) map.removeLayer(mcaOverlay);
  mcaOverlay = L.imageOverlay(cv.toDataURL(), [[S, W], [N, E]], {
    opacity: +$('#mca-opacity').value, className: 'mca-overlay', interactive: false,
  }).addTo(map);
  mcaOverlay.bringToBack();
  currentBase.bringToBack();

  mca.result = { cols, rows, cell, cellH, W, N, kx, ky, score, parts, excluded, active, cellLatLng };

  // Top sites: best cells, spread apart from each other.
  const order = [...score.keys()].filter((i) => !excluded[i]).sort((a, b) => score[b] - score[a]);
  const sites = [];
  const minSep = Math.max(3, Math.round(cols / 12));
  for (const i of order) {
    const r = Math.floor(i / cols), c = i % cols;
    if (sites.every((s) => Math.max(Math.abs(s.r - r), Math.abs(s.c - c)) >= minSep)) sites.push({ i, r, c });
    if (sites.length >= 5) break;
  }

  mcaSitesLayer.clearLayers();
  sites.forEach((s, k) => {
    L.marker(cellLatLng(s.i), {
      icon: L.divIcon({ className: 'mca-pin', html: `<span>${k + 1}</span>`, iconSize: [24, 24], iconAnchor: [12, 12] }),
    }).addTo(mcaSitesLayer).bindPopup(() => cellBreakdownHtml(s.i, `Candidate site #${k + 1}`));
  });

  // Summary
  const hist = [0, 0, 0, 0, 0];
  order.forEach((i) => hist[Math.min(4, Math.floor(score[i] * 5))]++);
  const histLabels = ['0–20', '20–40', '40–60', '60–80', '80–100'];
  const histMax = Math.max(...hist, 1);
  const cellArea = cell * cellH;
  const exSettle = excluded.reduce((s, v) => s + (v === 1), 0);
  const exRes = excluded.reduce((s, v) => s + (v === 2), 0);
  const preset = $('#mca-preset').value;

  let html = `<p class="hint"><strong>${esc(preset)}</strong> · ${active.length} criteria used ·
    grid ${cols} × ${rows} cells of ≈ ${fmt(cell, 1)} × ${fmt(cellH, 1)} km.</p>`;
  html += `<p class="hint">Excluded: ${fmt(exSettle * cellArea)} km² within ${mca.exclusionKm} km of settlements` +
    (constraints.length ? `, ${fmt(exRes * cellArea)} km² below the resource minimum (${constraints.map((c) => `${CRIT[c.id].label} < ${mca.min[c.id]} ${RESOURCES[c.param].unit}`).join('; ')})` : '') + '.</p>';
  const missing = active.filter((c) => !coverage[c.id]);
  if (missing.length) {
    html += `<p class="hint warn">No data found for: ${missing.map((c) => esc(c.label)).join(', ')}. ${
      missing.some((c) => c.id === 'renewable') ? 'For renewables, also turn on the WRI GPPD renewable layer. ' : ''}Those criteria score 0 (or 100 for “farther is better”) everywhere.</p>`;
  }
  if (active.some((c) => c.kind === 'value')) {
    html += '<p class="hint">Solar and wind values come from NASA POWER at about 50–100 km resolution. They separate regions well but vary little within one district.</p>';
  }
  if (!order.length) html += '<p class="hint warn">Every cell is excluded by the constraints. Relax the minimum resource or the settlement buffer.</p>';
  html += '<h2>Score distribution</h2>' + hist.map((h, k) => `<div class="bar-row"><span class="lbl">${histLabels[k]}</span>
    <span class="bar" style="width:${Math.max(2, (h / histMax) * 140)}px;background:rgb(${scoreColor(k * 20 + 10).join(',')})"></span>
    <span class="val">${fmt(h * cellArea)} km²</span></div>`).join('');

  html += '<h2>Top candidate sites</h2><ol class="mca-sites">' + sites.map((s, k) => {
    const ll = cellLatLng(s.i);
    return `<li data-k="${k}"><strong>#${k + 1} · score ${fmt(score[s.i] * 100)}</strong>
      <span class="sub">${ll.lat.toFixed(4)}, ${ll.lng.toFixed(4)}</span>
      <div class="row"><button class="btn ghost small" data-act="zoom">Show</button><button class="btn ghost small" data-act="site">Proximity report</button></div></li>`;
  }).join('') + '</ol>';
  html += '<p class="hint">Click anywhere on the suitability layer to see that cell\'s score breakdown.</p>';
  html += '<button class="btn ghost small" id="mca-csv">Export grid as CSV</button>';
  $('#mca-results').innerHTML = html;

  $('#mca-results').querySelectorAll('.mca-sites li').forEach((li) => {
    const s = sites[+li.dataset.k];
    li.querySelector('[data-act=zoom]').addEventListener('click', () => {
      map.setView(cellLatLng(s.i), Math.max(map.getZoom(), 11));
      L.popup().setLatLng(cellLatLng(s.i)).setContent(cellBreakdownHtml(s.i, `Candidate site #${+li.dataset.k + 1}`)).openOn(map);
    });
    li.querySelector('[data-act=site]').addEventListener('click', () => runSiteAnalysis(cellLatLng(s.i)));
  });
  $('#mca-csv').addEventListener('click', exportMcaCsv);
  updateLegend();
}

function cellIndexAt(latlng) {
  const R = mca.result;
  if (!R) return -1;
  const x = (latlng.lng - R.W) * R.kx, y = (R.N - latlng.lat) * R.ky;
  const c = Math.floor(x / R.cell), r = Math.floor(y / R.cellH);
  if (c < 0 || r < 0 || c >= R.cols || r >= R.rows) return -1;
  return r * R.cols + c;
}

function rawLabel(c, v) {
  if (c.kind === 'value') return isNaN(v) ? 'n/a' : `${v.toFixed(2)} ${RESOURCES[c.param].unit}`;
  return isFinite(v) ? `${fmt(v, 1)} km` : `> ${mca.max[c.id]} km`;
}

function cellBreakdownHtml(i, title) {
  const R = mca.result;
  const reason = ['', ' <em>(excluded: near settlement)</em>', ' <em>(excluded: resource below minimum)</em>'][R.excluded[i]];
  const rowsHtml = R.active.map((c) => `<tr><td>${esc(c.label)}</td><td>${rawLabel(c, R.parts[c.id].raw[i])}</td>
      <td>${fmt(R.parts[c.id].score[i] * 100)}</td><td>×${mca.weights[c.id]}</td></tr>`).join('');
  return `<strong>${esc(title)}</strong><br>Suitability <strong>${fmt(R.score[i] * 100)}</strong> / 100${reason}
    <table class="popup-table"><tr><td>Criterion</td><td>Value</td><td>Score</td><td>Wt</td></tr>${rowsHtml}</table>`;
}

map.on('click', (e) => {
  if (e.sitePicked || pickingSite || !mcaOverlay || !map.hasLayer(mcaOverlay)) return;
  const i = cellIndexAt(e.latlng);
  if (i < 0) return;
  L.popup().setLatLng(e.latlng).setContent(cellBreakdownHtml(i, 'Grid cell')).openOn(map);
});

function exportMcaCsv() {
  const R = mca.result;
  const head = ['lat', 'lon', 'score', 'excluded', ...R.active.flatMap((c) => [`${c.id}_${c.kind === 'value' ? 'value' : 'km'}`, `${c.id}_score`])];
  const lines = [head.join(',')];
  for (let i = 0; i < R.score.length; i++) {
    const ll = R.cellLatLng(i);
    lines.push([ll.lat.toFixed(5), ll.lng.toFixed(5), (R.score[i] * 100).toFixed(1), R.excluded[i],
      ...R.active.flatMap((c) => {
        const v = R.parts[c.id].raw[i];
        return [isFinite(v) ? v.toFixed(2) : '', (R.parts[c.id].score[i] * 100).toFixed(1)];
      })].join(','));
  }
  download('suitability_grid.csv', lines.join('\n'), 'text/csv');
}

// ---------------------------------------------------------------------------
// Tabs & init
// ---------------------------------------------------------------------------

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

buildLayerPanel();
buildFilters();
buildMcaPanel();
updateLegend();
