// Re-runnable Overpass/Nominatim fetch. Writes data/raw/*.json.
//   node scripts/fetch-osm.mjs            # fetch anything missing
//   node scripts/fetch-osm.mjs --force    # refetch everything
//
// Data (c) OpenStreetMap contributors, ODbL.

import { writeFile, readFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RAW = join(ROOT, 'data/raw')

// VIT Vellore campus: OSM relation 15931944.
export const CAMPUS_OSM_ID = 'R15931944'
// Padded ~300m past the wall for gates and adjoining paths.
export const BBOX = '12.9634,79.1484,12.9805,79.1720'

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
]

const QUERIES = {
  pois: `[out:json][timeout:180][bbox:${BBOX}];
(
  nwr["amenity"];
  nwr["shop"];
  nwr["building"]["name"];
  nwr["office"];
  nwr["leisure"];
  nwr["tourism"];
  nwr["healthcare"];
  nwr["emergency"];
  nwr["man_made"];
  nwr["indoor"]["name"];
  nwr["room"]["name"];
  node["highway"="street_lamp"];
);
out center tags;`,

  buildings: `[out:json][timeout:180][bbox:${BBOX}];
(way["building"];);
out geom tags;`,

  highways: `[out:json][timeout:180][bbox:${BBOX}];
(way["highway"];);
out geom tags;`,

  land: `[out:json][timeout:180][bbox:${BBOX}];
(
  way["natural"];
  way["landuse"];
  way["waterway"];
  relation["natural"="water"];
  way["barrier"="wall"];
  way["barrier"="fence"];
);
out geom tags;`,
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Overpass mirrors reject requests with no User-Agent.
const UA = 'vit-map/0.1 (campus map; +https://github.com/rugbedbugg/vit-map)'

async function overpass(query, name) {
  let lastErr
  for (let attempt = 0; attempt < 6; attempt++) {
    const endpoint = ENDPOINTS[attempt % ENDPOINTS.length]
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        body: query,
        headers: { 'User-Agent': UA, 'Content-Type': 'text/plain;charset=UTF-8' },
      })
      const text = await res.text()
      // Overpass reports runtime errors as an HTML page with a 200 status.
      if (!text.startsWith('{')) throw new Error(`non-JSON from ${endpoint}: ${text.slice(0, 160)}`)
      const json = JSON.parse(text)
      if (!Array.isArray(json.elements)) throw new Error('missing elements[]')
      return json
    } catch (err) {
      lastErr = err
      const wait = 5000 * (attempt + 1)
      console.warn(`  ${name}: attempt ${attempt + 1} failed (${err.message.slice(0, 80)}), retrying in ${wait / 1000}s`)
      await sleep(wait)
    }
  }
  throw new Error(`${name}: all attempts failed — ${lastErr?.message}`)
}

// Boundary comes from Nominatim (ready-merged Polygon/MultiPolygon) rather
// than stitching the relation's member ways by hand.
async function fetchBoundary() {
  const url = `https://nominatim.openstreetmap.org/lookup?osm_ids=${CAMPUS_OSM_ID}&format=json&polygon_geojson=1`
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`boundary: Nominatim HTTP ${res.status}`)
  const [hit] = await res.json()
  if (!hit?.geojson) throw new Error(`boundary: no result for ${CAMPUS_OSM_ID}`)
  const { type, coordinates } = hit.geojson
  const polygons = type === 'Polygon' ? [coordinates[0]]
    : type === 'MultiPolygon' ? coordinates.map((poly) => poly[0])
    : (() => { throw new Error(`boundary: unexpected geometry type ${type}`) })()
  return { name: hit.display_name?.split(',')[0] ?? 'Campus', polygons }
}

async function main() {
  const force = process.argv.includes('--force')
  await mkdir(RAW, { recursive: true })

  const boundaryPath = join(RAW, 'boundary.json')
  if (!force && existsSync(boundaryPath)) {
    const n = JSON.parse(await readFile(boundaryPath, 'utf8')).polygons.length
    console.log(`= boundary: cached (${n} polygon(s)) — use --force to refetch`)
  } else {
    console.log('> boundary: fetching…')
    const boundary = await fetchBoundary()
    await writeFile(boundaryPath, JSON.stringify(boundary))
    console.log(`  boundary: ${boundary.polygons.length} polygon(s)`)
    await sleep(1000) // Nominatim's usage policy asks for max 1 req/s
  }

  for (const [name, query] of Object.entries(QUERIES)) {
    const path = join(RAW, `${name}.json`)
    if (!force && existsSync(path)) {
      const n = JSON.parse(await readFile(path, 'utf8')).elements.length
      console.log(`= ${name}: cached (${n} elements) — use --force to refetch`)
      continue
    }
    console.log(`> ${name}: fetching…`)
    const json = await overpass(query, name)
    await writeFile(path, JSON.stringify(json))
    console.log(`  ${name}: ${json.elements.length} elements`)
    await sleep(2000) // be polite to a free public API
  }
  console.log('\nDone. Run `npm run build:data` to regenerate public/data.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
