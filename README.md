# VIT-CampusMap

![GitHub last commit](https://img.shields.io/github/last-commit/rugbedbugg/VIT-CampusMap?style=for-the-badge&labelColor=000000)
![GitHub repo size](https://img.shields.io/github/repo-size/rugbedbugg/VIT-CampusMap?style=for-the-badge&labelColor=000000)
![Stars](https://img.shields.io/github/stars/rugbedbugg/VIT-CampusMap?style=for-the-badge&labelColor=000000)

Find hostels, canteens, cycle stands, ATMs, and printing at VIT Vellore - with opening hours and instant search. Powered by MapLibre GL, TypeScript, Vite, and OpenStreetMap.

## Status

**Active**

## Features

| Feature | Description |
|---------|-------------|
| Comprehensive POI coverage | 119 places, 118 buildings, 45 paths, 71 roads from OSM |
| Opening hours | Per-venue hours parsed from OSM tags, displayed in local time |
| Walking/cycling routing | 424 nodes, 469 edges from OSM highways, A* pathfinding |
| Fast search | Fuse.js-powered fuzzy search over all places, buildings, paths |
| Recent searches | Persisted local history, quick re-access |
| Wheelchair accessibility | Step-free tags from OSM surfaced in UI |
| Contribution flow | Right-click/long-press to open pre-filled GitHub issue with coordinates |
| Verified rendering | Headless Chrome smoke test catches console errors, failed requests, missing labels, overlapping UI |

## Tech Stack

| Component | Version | Purpose |
|-----------|---------|---------|
| TypeScript | 5.6 | Strict, ES modules |
| Vite | 5 | Dev server, build, HMR |
| MapLibre GL | 4.7 | Vector tile rendering (WebGL) |
| Puppeteer Core | 23 | Headless Chrome verification |
| Fuse.js | - | Fuzzy search (`src/search/engine.ts`) |
| Custom routing | - | A* on OSM-derived graph (`src/route/router.ts`) |

## Data Sources

| What | Source | Count |
|------|--------|-------|
| Places, geometry, opening hours, wheelchair tags | [OpenStreetMap](https://www.openstreetmap.org/relation/15931944) (ODbL) | 119 places, 118 buildings |
| Campus boundary | OpenStreetMap via Nominatim (two disjoint plots) | 2 polygons |
| Paths and roads | OpenStreetMap highways | 45 paths, 71 roads |
| Walking/cycling network | OSM highways → routing graph | 424 nodes, 469 edges |

> Category coverage depends entirely on what is tagged in OSM for our campus. Help improve it by tagging places on [OpenStreetMap](https://www.openstreetmap.org/relation/15931944) - this repo picks up changes on next `npm run fetch`.

## Install / Run

### Prerequisites

| Requirement | Details |
|-------------|---------|
| Node.js | ≥ 18 (`.nvmrc` specifies version) |
| npm | ≥ 9 |

### Development

```bash
npm install
npm run fetch       # Fetch OSM data (Nominatim + Overpass), cached; use --force to refetch
npm run dev         # Runs build:data + vite dev server
```

### Build

| Script | Command | Description |
|--------|---------|-------------|
| `build` | `npm run build:data && vite build` | Production build → dist/ |
| `preview` | `vite preview` | Preview production build |

## Commands / Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `fetch` | `node scripts/fetch-osm.mjs` | Download OSM data (cached) |
| `build:data` | `node scripts/build-data.mjs` | Process raw OSM → app-ready JSON |
| `import:places` | `node scripts/import-places.mjs` | Import curated places |
| `dev` | `npm run build:data && vite` | Full dev server |
| `build` | `npm run build:data && vite build` | Production build |
| `preview` | `vite preview` | Serve dist/ locally |
| `typecheck` | `tsc --noEmit` | TypeScript check only |
| `smoke` | `node scripts/smoke.mjs` | Rebuild data + smoke test |
| `test` | `typecheck && build:data && smoke` | Full CI pipeline |
| `verify` | `node scripts/verify-browser.mjs` | Headless Chrome verification |

### Verification (`npm run verify`)

Drives a throwaway Chrome profile via Puppeteer against a running dev server. Fails on:

- Any console error
- Failed network request
- Missing map label
- Overlapping UI elements

## Project Structure

```
VIT-CampusMap/
├── public/
│   ├── data/
│   │   ├── campus.json       # Campus boundary polygons
│   │   ├── geo.json          # Building/place geometries
│   │   └── graph.json        # Routing graph (nodes/edges)
│   ├── font/                 # DepartureMono PBF glyphs (256-char chunks)
│   ├── fonts/                # DepartureMono-Regular.woff2
│   ├── images/               # campus-aerial.jpg
│   ├── _headers              # Netlify headers
│   ├── 404.html              # Netlify 404
│   ├── icon.svg              # PWA icon
│   ├── manifest.json         # PWA manifest
│   └── robots.txt
├── src/
│   ├── map/
│   │   └── style.ts          # MapLibre style definition
│   ├── route/
│   │   └── router.ts         # A* routing on walking/cycling graph
│   ├── search/
│   │   ├── engine.ts         # Fuse.js search index + query
│   │   ├── hours.ts          # Opening hours formatting
│   │   └── nearest.ts        # Nearest POI search
│   ├── ui/
│   │   ├── palette.ts        # Color scheme
│   │   ├── panel.ts          # Side panel (search, details, about)
│   │   ├── ping.ts           # Map click/long-press handler
│   │   └── recents.ts        # Recent searches persistence
│   ├── main.ts               # App entry: map init, event wiring
│   ├── styles.css            # Global styles (Tailwind-like, no Tailwind)
│   └── types.ts              # Shared TypeScript interfaces
├── scripts/
│   ├── fetch-osm.mjs         # Nominatim + Overpass API fetch
│   ├── build-data.mjs        # Raw OSM → app JSON (geo, graph, campus)
│   ├── import-places.mjs     # Curated places import
│   ├── smoke.mjs             # Build verification (no browser)
│   └── verify-browser.mjs    # Puppeteer headless Chrome test
├── data/
│   └── curated/              # Manual overrides (places.json)
├── docs/                     # Architecture notes (if any)
├── .verify/                  # Puppeteer cache (gitignored)
├── .github/                  # CI workflows
├── dist/                     # Build output (gitignored)
├── node_modules/             # Dependencies (gitignored)
├── package.json
├── tsconfig.json
├── vite.config.ts
└── README.md
```

## Contributing

### Missing on the Map?

1. **Right-click** (desktop) or **long-press** (mobile) the spot
2. Or open **About panel** → **"Mark a location"**
3. Opens a pre-filled GitHub issue with coordinates - no account setup or JSON editing

> A faster in-app submission flow is in progress; the GitHub detour is temporary.

### Prefer to Map It Yourself?

Add directly to [OpenStreetMap](https://www.openstreetmap.org/relation/15931944) - this repo picks it up on next `npm run fetch`. Most physical world data (printers, cycle stands, opening hours, step-free access) belongs in OSM.

### Edge Cases (OSM Won't Accept)

Rare one-offs with no OSM tag go in `data/curated/places.json`:
- Surveyed `lat`/`lon`, or
- `anchor` naming a real OSM feature to sit beside (build resolves position, warns if anchor stops matching)

## Testing

```bash
npm run test
# Runs: typecheck → build:data → smoke
```

| Step | Command | Description |
|------|---------|-------------|
| Typecheck | `tsc --noEmit` | Strict TS |
| Smoke | `node scripts/smoke.mjs` | Rebuilds data, validates JSON structure, checks required fields |
| Verify | `npm run verify` | Headless Chrome E2E (see Commands) |

## License

Code [MIT](LICENSE). Map data © OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright). Font is Departure Mono ([OFL 1.1](https://openfontlicense.org)).

## Links

- **Repo:** https://github.com/rugbedbugg/VIT-CampusMap
- **Live:** https://vit-campusmap.pages.dev
- **Issues:** https://github.com/rugbedbugg/VIT-CampusMap/issues
- **OpenStreetMap Relation:** https://www.openstreetmap.org/relation/15931944
