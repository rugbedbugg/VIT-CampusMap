// Turns data/raw/*.json + data/curated/*.json into public/data/{campus,geo,graph}.json
//   node scripts/build-data.mjs

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RAW = join(ROOT, 'data/raw')
const CURATED = join(ROOT, 'data/curated')
const OUT = join(ROOT, 'public/data')

const warnings = []
const warn = (m) => warnings.push(m)

/* ── categories ─────────────────────────────────────────────────────────── */
// First classify() match wins. `pin` = always-labelled marker.
// Colors are the IBM 5153 (CGA) 16-color set, matching the UI and basemap.
export const CATEGORIES = {
  lecture:  { label: 'Auditoria & halls', color: '#ffff55', pin: true },
  academic: { label: 'Classes & labs',    color: '#5555ff', pin: true },
  hostel:   { label: 'Hostels',           color: '#ff55ff', pin: true },
  mess:     { label: 'Messes',            color: '#00aa00', pin: true },
  canteen:  { label: 'Canteens',          color: '#aa5500', pin: true },
  library:  { label: 'Library & Study',   color: '#55ffff', pin: true },
  shop:     { label: 'Shops',             color: '#00aaaa', pin: false },
  print:    { label: 'Printing',          color: '#aa0000', pin: false },
  atm:      { label: 'ATMs & banks',      color: '#555555', pin: false },
  cycle:    { label: 'Cycle parking',     color: '#ffffff', pin: false },
  laundry:  { label: 'Laundry',           color: '#aa00aa', pin: false },
  health:   { label: 'Health',            color: '#ff5555', pin: false },
  sports:   { label: 'Sports',            color: '#55ff55', pin: false },
  transport:{ label: 'Parking',           color: '#5555ff', pin: false },
  green:    { label: 'Parks',             color: '#55ff55', pin: false },
  'mens-hostel':   { label: "Boys' hostels",   color: '#ff55ff', pin: true },
  'womens-hostel': { label: "Girls' hostels",  color: '#aa00aa', pin: true },
}

// VIT segregates its halls of residence. The ladies' side either says so
// outright ("Hall of Residence for Girls 5", "LH-A") or is named after a
// woman ("Jhansi Rani Block", "Suu Kyi Block"), names that would otherwise
// fall through to 'academic' via their Block suffix.
const WOMENS_HOSTEL = /\b(ladies|women|girls?)\b|\bLH\b|jhansi\s*rani|suu\s*kyi|mother\s*teresa|ida\s*scudder|kalpana\s*chawla|helen\s*keller/i
const MENS_HOSTEL = /\b(boys?|men|male)\b/i

function hostelCat(name) {
  if (WOMENS_HOSTEL.test(name)) return 'womens-hostel'
  if (MENS_HOSTEL.test(name)) return 'mens-hostel'
  // Every single-lettered block on campus ("B Block", "J Block"), and the
  // annexes hanging off them, is on the men's side; anything else we cannot
  // vouch for keeps the generic bucket. Two exceptions are handled by
  // HOSTEL_ID_OVERRIDES below, since names alone cannot tell them apart.
  if (/^[a-z]\s*(block|hostel|annexe?)$/i.test(name.trim())) return 'mens-hostel'
  return 'hostel'
}

// There are TWO M Blocks and TWO N Blocks on campus: a pair beside Kalpana
// Chawla Ground that belongs to the ladies' side, and the regular northern
// pair that is men's. Only the OSM ids tell them apart.
const HOSTEL_ID_OVERRIDES = {
  r20992887: 'womens-hostel', // M Block by Kalpana Chawla Ground
  w370766286: 'womens-hostel', // N Block by Kalpana Chawla Ground
  r21109571: 'mens-hostel', // M Block, north side
  r21109570: 'mens-hostel', // N Block, north side
  w1540238549: 'mens-hostel', // M Annexe, north side
}

const catFor = (el, t) => HOSTEL_ID_OVERRIDES[`${el.type[0]}${el.id}`] ?? classify(t)

function classify(t) {
  const name = t.name || ''
  const { amenity: a, shop: s, leisure: l, office: o, healthcare: h, tourism: tr, building: b } = t
  const lu = t.landuse

  // Every hall of residence is mapped as a named plot rather than a building,
  // so without this the whole hostel side of campus is invisible.
  if (lu === 'residential' && (t.residential === 'hostel' || /^Hall of Residence/i.test(name))) {
    return hostelCat(name)
  }

  // Ladies' hostels are named blocks; catch them before the Block suffix
  // sends them to 'academic'.
  if (WOMENS_HOSTEL.test(name) && /\b(block|hostel|bhawan|hall)\b/i.test(name)) {
    return 'womens-hostel'
  }

  // Bare lettered blocks ("M Block", "B Annexe") are hostels even though
  // Block/Annexe would trip the academic keyword match below.
  if (/^[a-z]\s*(block|hostel|annexe?)$/i.test(name.trim())) return hostelCat(name)

  // "Lecture Hall Complex Office Staff" is an indoor office, not a lecture hall
  // or anything else this map indexes — drop it rather than mis-bucket it.
  if (/\b(office|staff|store|pantry|toilet)\b/i.test(name) && t.indoor) return null

  if (/^Lecture Hall\b/i.test(name) || /Lecture Hall Complex/i.test(name) ||
      /^Tutorial Block/i.test(name) || a === 'lecture_hall') return 'lecture'
  if (a === 'theatre' || a === 'cinema' || a === 'conference_centre' || /Auditorium$/i.test(name)) return 'lecture'

  if (/\bMess\b/i.test(name) || a === 'canteen') return 'mess'
  if (/\bCanteen\b/i.test(name)) return 'canteen'
  if (a === 'restaurant' || a === 'fast_food' || a === 'cafe' || a === 'ice_cream' ||
      a === 'food_court' || s === 'bakery') return 'canteen'

  if (a === 'library' || a === 'classroom' || t.room === 'classroom') return 'library'

  if (a === 'atm' || a === 'bank' || a === 'bureau_de_change') return 'atm'
  if (a === 'bicycle_parking' || a === 'bicycle_repair_station' || s === 'bicycle') return 'cycle'
  if (s === 'laundry' || s === 'dry_cleaning' || a === 'laundry' || /Laundry/i.test(name)) return 'laundry'
  if (s === 'copyshop' || a === 'printer' || /\b(xerox|photocopy|printout|print)\b/i.test(name)) return 'print'
  if (a === 'vending_machine') return 'canteen'

  if (a === 'hospital' || a === 'clinic' || a === 'doctors' || a === 'pharmacy' ||
      a === 'dentist' || a === 'veterinary' || h) return 'health'

  if (a === 'parking' || a === 'fuel' || a === 'charging_station' || a === 'bus_station' ||
      a === 'taxi' || a === 'bicycle_rental' || a === 'car_rental') return 'transport'

  if (l === 'pitch' || l === 'sports_centre' || l === 'fitness_centre' || l === 'swimming_pool' ||
      l === 'track' || l === 'playground' || l === 'stadium' || l === 'bleachers' ||
      /\bGym\b/i.test(name)) return 'sports'
  if (l === 'park' || l === 'garden' || l === 'nature_reserve') return 'green'

  if (s || a === 'marketplace') return 'shop'

  if (/^Hall\s*\d|^Hall\d/i.test(name) || tr === 'hostel' || b === 'dormitory' ||
      a === 'dormitory' || /Hostel|Bhawan/i.test(name)) return hostelCat(name)

  if (o === 'university' || o === 'research' || a === 'university' || a === 'research_institute' ||
      a === 'college' || a === 'school' || o === 'educational_institution' ||
      /\b(Department|Dept|Laboratory|Lab|Centre|Center|Institute|Academy|Facility|Building|Block|Complex|Wing|Tower|Annexe|Research)\b/i.test(name)) {
    return 'academic'
  }

  if (lu === 'retail' || lu === 'commercial') return 'shop'
  if (lu === 'recreation_ground') return 'sports'
  if (lu === 'orchard' || lu === 'plant_nursery' || lu === 'forest' || lu === 'meadow') return 'green'
  if (lu === 'residential') return hostelCat(name)
  return null
}

/* ── geo helpers ────────────────────────────────────────────────────────── */

const R = 6371008.8
const rad = (d) => (d * Math.PI) / 180

function haversine(aLat, aLon, bLat, bLon) {
  const dLat = rad(bLat - aLat)
  const dLon = rad(bLon - aLon)
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

function centroid(geometry) {
  // Area-weighted centroid for closed rings, mean otherwise. Keeps labels
  // inside L-shaped buildings far better than a bbox centre does.
  const g = geometry.filter(Boolean)
  if (g.length < 3) {
    const lat = g.reduce((s, p) => s + p.lat, 0) / g.length
    const lon = g.reduce((s, p) => s + p.lon, 0) / g.length
    return [lon, lat]
  }
  let a = 0, cx = 0, cy = 0
  for (let i = 0; i < g.length - 1; i++) {
    const p = g[i], q = g[i + 1]
    const f = p.lon * q.lat - q.lon * p.lat
    a += f
    cx += (p.lon + q.lon) * f
    cy += (p.lat + q.lat) * f
  }
  if (Math.abs(a) < 1e-12) {
    const lat = g.reduce((s, p) => s + p.lat, 0) / g.length
    const lon = g.reduce((s, p) => s + p.lon, 0) / g.length
    return [lon, lat]
  }
  a *= 0.5
  return [cx / (6 * a), cy / (6 * a)]
}

function pointInRing(lon, lat, ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1]
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function imageOf(t) {
  if (t.image) return t.image
  if (t.wikimedia_commons?.startsWith('File:')) {
    return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(t.wikimedia_commons.slice(5))}`
  }
  return undefined
}

const readRaw = async (n) => JSON.parse(await readFile(join(RAW, `${n}.json`), 'utf8'))

/* ── main ───────────────────────────────────────────────────────────────── */

async function main() {
  for (const f of ['boundary', 'pois', 'buildings', 'highways', 'land']) {
    if (!existsSync(join(RAW, `${f}.json`))) {
      console.error(`missing data/raw/${f}.json — run \`npm run fetch\` first`)
      process.exit(1)
    }
  }

  const [boundary, pois, buildings, highways, land] = await Promise.all(
    ['boundary', 'pois', 'buildings', 'highways', 'land'].map(readRaw),
  )

  /* boundary — used to drop everything outside campus. One or more disjoint
     polygons (VIT Vellore's OSM boundary is two separate plots), so a point
     counts as "in campus" if it falls inside any of them. */
  if (!boundary.polygons?.length) throw new Error('boundary.json has no polygons')
  const inCampus = (lon, lat) => boundary.polygons.some((ring) => pointInRing(lon, lat, ring))

  /* ── POIs from OSM ────────────────────────────────────────────────────── */
  const byId = new Map()
  // Named land polygons carry the halls of residence, the markets and the
  // grounds — none of which exist as buildings or amenity nodes.
  const sources = [...pois.elements, ...buildings.elements, ...land.elements]

  for (const el of sources) {
    const t = el.tags || {}
    if (!t.name) continue

    let lon, lat
    if (el.type === 'node') { lon = el.lon; lat = el.lat }
    else if (el.center) { lon = el.center.lon; lat = el.center.lat }
    else if (el.geometry?.length) { [lon, lat] = centroid(el.geometry) }
    else continue
    if (!inCampus(lon, lat)) continue

    const cat = catFor(el, t)
    if (!cat) continue

    const id = `${el.type[0]}${el.id}`
    if (byId.has(id)) continue

    // Nobody on campus says "Hall of Residence 4" — shorten for display.
    let display = t.name
    const aliases = []
    const long = /^Hall of Residence(?: for (Girls|Boys))? (\d+)$/i.exec(t.name)
    if (t.alt_name && /^(Hall|GH)\s*\d/i.test(t.alt_name)) display = t.alt_name
    else if (long) {
      const n = long[2]
      display = long[1] ? `Girls Hostel ${n}` : `Hall ${n}`
      // The girls' halls are numbered in their own series in OSM, but everyone
      // on campus still calls them "Hall 6" and "GH6".
      if (long[1]) aliases.push(`Hall ${n}`, `GH${n}`, `GH ${n}`)
    }

    // The same real place is often a node (the amenity) inside a way (the
    // building). Prefer the amenity node, drop the duplicate footprint.
    byId.set(id, {
      id,
      name: display,
      cat,
      lon: +lon.toFixed(6),
      lat: +lat.toFixed(6),
      src: 'osm',
      osm: `${el.type}/${el.id}`,
      ...(display !== t.name ? { alt: t.name }
          : t['name:en'] && t['name:en'] !== t.name ? { alt: t['name:en'] } : {}),
      ...(aliases.length ? { aliases } : {}),
      ...(t.opening_hours ? { hours: t.opening_hours } : {}),
      ...(t.wheelchair ? { wheelchair: t.wheelchair } : {}),
      ...(t.phone || t['contact:phone'] ? { phone: t.phone || t['contact:phone'] } : {}),
      ...(t.website || t['contact:website'] ? { url: t.website || t['contact:website'] } : {}),
      ...(t.cuisine ? { cuisine: t.cuisine } : {}),
      ...(t.capacity ? { capacity: t.capacity } : {}),
      ...(t.covered ? { covered: t.covered } : {}),
      ...(t.operator ? { operator: t.operator } : {}),
      ...(t.description ? { desc: t.description } : {}),
      ...(t.level ? { level: t.level } : {}),
      ...(imageOf(t) ? { image: imageOf(t) } : {}),
      kind: t.amenity || t.shop || t.leisure || t.office || t.healthcare ||
            t.tourism || t.man_made || t.building || undefined,
    })
  }

  // Unnamed but useful: cycle parking, water, ATMs, vending, benches.
  const UNNAMED_OK = new Set(['bicycle_parking', 'drinking_water', 'atm',
                              'vending_machine', 'water_point', 'bicycle_repair_station'])
  for (const el of pois.elements) {
    const t = el.tags || {}
    if (t.name) continue
    const isLamp = t.highway === 'street_lamp' || t.man_made === 'street_lamp'
    if (!isLamp && !UNNAMED_OK.has(t.amenity) && t.man_made !== 'water_tap') continue
    const lon = el.type === 'node' ? el.lon : el.center?.lon
    const lat = el.type === 'node' ? el.lat : el.center?.lat
    if (lon == null || !inCampus(lon, lat)) continue
    const cat = classify(t)
    if (!cat) continue
    const id = `${el.type[0]}${el.id}`
    const label = { bicycle_parking: 'Cycle parking', drinking_water: 'Drinking water',
      atm: 'ATM', vending_machine: 'Vending machine',
      water_point: 'Water point', bicycle_repair_station: 'Cycle repair' }[t.amenity] ||
      (isLamp ? 'Street light' : t.man_made === 'water_tap' ? 'Water tap' : 'Facility')
    byId.set(id, {
      id, name: label, cat, unnamed: true,
      lon: +lon.toFixed(6), lat: +lat.toFixed(6),
      src: 'osm', osm: `${el.type}/${el.id}`,
      ...(t.opening_hours ? { hours: t.opening_hours } : {}),
      ...(t.wheelchair ? { wheelchair: t.wheelchair } : {}),
      ...(t.capacity ? { capacity: t.capacity } : {}),
      ...(t.covered ? { covered: t.covered } : {}),
      ...(t.drinking_water === 'no' ? { potable: 'no' } : {}),
      ...(t.lamp_type ? { lampType: t.lamp_type } : {}),
      ...(t.support ? { support: t.support } : {}),
      kind: t.amenity || t.man_made || t.highway,
    })
  }

  /* ── curated overlay ──────────────────────────────────────────────────── */
  const curated = {}
  if (existsSync(CURATED)) {
    for (const f of (await readdir(CURATED)).filter((f) => f.endsWith('.json'))) {
      curated[f.replace(/\.json$/, '')] = JSON.parse(await readFile(join(CURATED, f), 'utf8'))
    }
  }

  // Anchor lookup: normalised name -> POI. Used to place curated records.
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const anchors = new Map()
  for (const p of byId.values()) {
    const k = norm(p.name)
    // Prefer named, pin-worthy features as anchors over generic footprints.
    if (!anchors.has(k) || CATEGORIES[p.cat]?.pin) anchors.set(k, p)
  }

  function resolveAnchor(anchor, who) {
    if (!anchor) return null
    const hit = anchors.get(norm(anchor))
    if (!hit) { warn(`unresolved anchor "${anchor}" (from ${who})`); return null }
    return hit
  }

  let curatedCount = 0
  for (const p of curated.places?.items ?? []) {
    // Once OSM gains a feature we hand-added, the curated row is dead weight
    // and shows up as a doubled pin. Drop it and say so, loudly.
    if (anchors.has(norm(p.name))) {
      warn(`curated "${p.name}" now exists in OSM — delete it from places.json`)
      continue
    }
    if (p.lat != null && p.lon != null) {
      if (!inCampus(p.lon, p.lat)) { warn(`curated "${p.id}" is outside the campus boundary`); continue }
      const { anchor, ...rest } = p
      void anchor
      byId.set(p.id, { ...rest, lat: +(+p.lat).toFixed(6), lon: +(+p.lon).toFixed(6), src: 'seed' })
      curatedCount++
      continue
    }
    const a = resolveAnchor(p.anchor, `places/${p.id}`)
    if (!a) continue
    // Deterministic jitter so several records on one anchor do not stack.
    const seed = [...p.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)
    const ang = (seed % 360) * (Math.PI / 180)
    const dist = 8 + (seed % 11) // 8–18 m off the anchor
    const dLat = (dist * Math.cos(ang)) / 111320
    const dLon = (dist * Math.sin(ang)) / (111320 * Math.cos(rad(a.lat)))
    byId.set(p.id, {
      ...p,
      lat: +(a.lat + dLat).toFixed(6),
      lon: +(a.lon + dLon).toFixed(6),
      src: 'seed',
      near: a.name,
    })
    curatedCount++
  }

  // Curated places can themselves be anchors for later entries in the file.
  for (const p of byId.values()) {
    const k = norm(p.name)
    if (!anchors.has(k) || CATEGORIES[p.cat]?.pin) anchors.set(k, p)
  }

  // The same facility is often mapped twice — once as a node, once as the room
  // or building around it. Same name at the same spot is one place.
  const atPoint = new Map()
  for (const p of [...byId.values()]) {
    const k = `${norm(p.name)}@${p.lat.toFixed(5)},${p.lon.toFixed(5)}`
    const hit = atPoint.get(k)
    if (!hit) { atPoint.set(k, p); continue }
    // Keep whichever record carries more detail.
    const score = (x) => Object.keys(x).length + (x.unnamed ? -5 : 0)
    if (score(p) > score(hit)) { byId.delete(hit.id); atPoint.set(k, p) } else { byId.delete(p.id) }
  }

  const poiList = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))

  /* ── GeoJSON layers ───────────────────────────────────────────────────── */
  const fc = (features) => ({ type: 'FeatureCollection', features })
  const lineOf = (el, props) => ({
    type: 'Feature',
    properties: props,
    geometry: { type: 'LineString', coordinates: el.geometry.map((p) => [+p.lon.toFixed(6), +p.lat.toFixed(6)]) },
  })
  const polyOf = (el, props) => {
    const c = el.geometry.map((p) => [+p.lon.toFixed(6), +p.lat.toFixed(6)])
    const first = c[0], last = c[c.length - 1]
    if (first[0] !== last[0] || first[1] !== last[1]) c.push(first)
    return { type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [c] } }
  }
  const touchesCampus = (el) => el.geometry?.some((p) => inCampus(p.lon, p.lat))

  const buildingF = []
  for (const el of buildings.elements) {
    if (!el.geometry || el.geometry.length < 3 || !touchesCampus(el)) continue
    const t = el.tags || {}
    const cat = t.name ? catFor(el, t) : null
    buildingF.push(polyOf(el, {
      name: t.name || '',
      cat: cat || '',
      levels: +(t['building:levels'] || 0) || 0,
    }))
  }

  const PATH_KINDS = new Set(['footway', 'path', 'pedestrian', 'steps', 'cycleway', 'track', 'corridor'])
  const pathF = [], roadF = []
  for (const el of highways.elements) {
    if (!el.geometry || el.geometry.length < 2 || !touchesCampus(el)) continue
    const t = el.tags || {}
    const hw = t.highway
    const props = { name: t.name || '', hw, lit: t.lit || '', surface: t.surface || '' }
    if (PATH_KINDS.has(hw)) pathF.push(lineOf(el, props))
    else roadF.push(lineOf(el, props))
  }

  // Hand-supplied road/path geometry OSM doesn't have yet. Visual only, does
  // not feed the routing graph below.
  for (const r of curated.roads?.items ?? []) {
    if (!Array.isArray(r.coords) || r.coords.length < 2) {
      warn(`curated road "${r.id}" needs at least 2 coords`); continue
    }
    const coords = r.coords.map(([lat, lon]) => [+(+lon).toFixed(6), +(+lat).toFixed(6)])
    if (!coords.some(([lon, lat]) => inCampus(lon, lat))) {
      warn(`curated road "${r.id}" has no coordinates inside the campus boundary`)
    }
    const feature = {
      type: 'Feature',
      properties: { name: r.name || '', hw: r.hw || '', lit: '', surface: '' },
      geometry: { type: 'LineString', coordinates: coords },
    }
    if (PATH_KINDS.has(r.hw)) pathF.push(feature)
    else roadF.push(feature)
  }

  const greenF = [], waterF = [], waterLineF = [], wallF = []
  for (const el of land.elements) {
    if (!el.geometry || !touchesCampus(el)) continue
    const t = el.tags || {}
    if (t.waterway) { waterLineF.push(lineOf(el, { kind: t.waterway })); continue }
    if (t.barrier) { wallF.push(lineOf(el, { kind: t.barrier })); continue }
    if (el.geometry.length < 3) continue
    if (t.natural === 'water') { waterF.push(polyOf(el, { kind: 'water' })); continue }
    const g = t.landuse || t.natural
    if (['forest', 'wood', 'grass', 'grassland', 'recreation_ground', 'orchard',
         'plant_nursery', 'meadow', 'scrub', 'village_green'].includes(g)) {
      greenF.push(polyOf(el, { kind: g }))
    }
  }
  // Sports pitches read as green space on the map.
  for (const el of pois.elements) {
    const t = el.tags || {}
    if (!['pitch', 'track', 'playground', 'garden', 'park'].includes(t.leisure)) continue
    if (!el.geometry || el.geometry.length < 3 || !touchesCampus(el)) continue
    greenF.push(polyOf(el, { kind: t.leisure }))
  }

  const geo = {
    boundary: fc(boundary.polygons.map((ring) => ({
      type: 'Feature',
      properties: { name: boundary.name || 'Campus' },
      geometry: { type: 'Polygon', coordinates: [ring] },
    }))),
    green: fc(greenF),
    water: fc(waterF),
    waterway: fc(waterLineF),
    wall: fc(wallF),
    roads: fc(roadF),
    paths: fc(pathF),
    buildings: fc(buildingF),
  }

  /* ── routing graph ────────────────────────────────────────────────────── */
  // OSM `out geom` gives coordinates but not node ids, so topology comes from
  // exact coordinate identity — shared nodes serialise to identical lat/lon.
  const key = (lat, lon) => `${lat.toFixed(7)},${lon.toFixed(7)}`
  const nodeIndex = new Map()
  const nodeLat = [], nodeLon = []
  const getNode = (lat, lon) => {
    const k = key(lat, lon)
    let i = nodeIndex.get(k)
    if (i === undefined) {
      i = nodeLat.length
      nodeIndex.set(k, i)
      nodeLat.push(+lat.toFixed(6))
      nodeLon.push(+lon.toFixed(6))
    }
    return i
  }

  // Edge cost model. Cost is in seconds; ETA falls straight out of the search.
  const WALK = 1.35 // m/s — ~4.9 km/h, a normal campus walking pace
  const BIKE = 4.2  // m/s — ~15 km/h on open road

  function speeds(t) {
    const hw = t.highway
    // Steps and indoor corridors are passable by bike only on foot, pushing it.
    // Modelling them as forbidden instead would strand any building whose
    // nearest network node is a corridor — you can always walk the last stretch.
    if (hw === 'steps') return { foot: WALK * 0.45, bike: 0.6, dismount: true }
    if (hw === 'corridor') return { foot: WALK * 0.85, bike: 0.9, indoor: true }
    if (hw === 'cycleway') return { foot: WALK, bike: BIKE }
    if (hw === 'footway' || hw === 'pedestrian' || hw === 'path') {
      const bikeOk = t.bicycle !== 'no'
      return { foot: WALK, bike: bikeOk ? BIKE * 0.72 : 0 }
    }
    if (hw === 'track') return { foot: WALK * 0.9, bike: BIKE * 0.6 }
    if (hw === 'service' || hw === 'living_street' || hw === 'residential' ||
        hw === 'unclassified') return { foot: WALK, bike: BIKE }
    if (hw === 'tertiary' || hw === 'secondary' || hw === 'tertiary_link') {
      return { foot: WALK * 0.95, bike: BIKE }
    }
    if (hw === 'trunk' || hw === 'primary' || hw === 'trunk_link' || hw === 'motorway') {
      // Fast road with no footway tagged — walkable but unpleasant, so penalise.
      if (t.foot === 'no') return { foot: 0, bike: BIKE }
      return { foot: WALK * 0.6, bike: BIKE * 0.9 }
    }
    return { foot: WALK, bike: BIKE * 0.8 }
  }

  const edges = [] // [a, b, metres, footSec, bikeSec, flags]
  const FLAG_STEPS = 1, FLAG_INDOOR = 2, FLAG_LIT = 4, FLAG_SHORTCUT = 8

  for (const el of highways.elements) {
    if (!el.geometry || el.geometry.length < 2) continue
    const t = el.tags || {}
    if (t.access === 'private' || t.access === 'no') continue
    if (!el.geometry.some((p) => inCampus(p.lon, p.lat))) continue

    const sp = speeds(t)
    let flags = 0
    if (sp.dismount) flags |= FLAG_STEPS
    if (sp.indoor) flags |= FLAG_INDOOR
    if (t.lit === 'yes') flags |= FLAG_LIT
    // "Shortcut": an unpaved desire line — the trodden paths students actually use.
    if ((t.highway === 'path' || t.highway === 'track') &&
        !['paved', 'asphalt', 'concrete', 'paving_stones'].includes(t.surface)) {
      flags |= FLAG_SHORTCUT
    }

    for (let i = 0; i < el.geometry.length - 1; i++) {
      const p = el.geometry[i], q = el.geometry[i + 1]
      const a = getNode(p.lat, p.lon), b = getNode(q.lat, q.lon)
      if (a === b) continue
      const m = haversine(p.lat, p.lon, q.lat, q.lon)
      if (m < 0.05) continue
      // -1 means "this profile cannot use this edge". Keep two decimals: an
      // integer round would send every edge under ~2 m to zero, and a zero-cost
      // edge is indistinguishable from a forbidden one.
      const round2 = (x) => Math.round(x * 100) / 100
      const footSec = sp.foot > 0 ? round2(m / sp.foot) : -1
      const bikeSec = sp.bike > 0 ? round2(m / sp.bike) : -1
      edges.push([a, b, Math.round(m * 10) / 10, footSec, bikeSec, flags])
    }
  }

  // Largest connected component only — stray disconnected stubs make routing
  // fail in ways that look like bugs to the user.
  const adj = Array.from({ length: nodeLat.length }, () => [])
  edges.forEach(([a, b], i) => { adj[a].push(i); adj[b].push(i) })
  const comp = new Int32Array(nodeLat.length).fill(-1)
  let best = -1, bestSize = 0
  for (let s = 0, c = 0; s < nodeLat.length; s++) {
    if (comp[s] !== -1) continue
    let size = 0
    const stack = [s]
    comp[s] = c
    while (stack.length) {
      const n = stack.pop(); size++
      for (const ei of adj[n]) {
        const e = edges[ei]
        const o = e[0] === n ? e[1] : e[0]
        if (comp[o] === -1) { comp[o] = c; stack.push(o) }
      }
    }
    if (size > bestSize) { bestSize = size; best = c }
    c++
  }

  const remap = new Int32Array(nodeLat.length).fill(-1)
  const gLat = [], gLon = []
  for (let i = 0; i < nodeLat.length; i++) {
    if (comp[i] !== best) continue
    remap[i] = gLat.length
    gLat.push(nodeLat[i]); gLon.push(nodeLon[i])
  }
  const gEdges = []
  for (const [a, b, m, f, k, fl] of edges) {
    if (comp[a] !== best) continue
    gEdges.push([remap[a], remap[b], m, f, k, fl])
  }

  const graph = {
    note: 'Costs are seconds; -1 = that profile cannot use the edge. flags: 1=steps 2=indoor 4=lit 8=unpaved-shortcut',
    lat: gLat, lon: gLon, edges: gEdges,
    dropped: nodeLat.length - gLat.length,
  }

  /* ── output ───────────────────────────────────────────────────────────── */
  const counts = {}
  for (const p of poiList) counts[p.cat] = (counts[p.cat] || 0) + 1

  // `roads` is geo data, not POI metadata, so it belongs in geo.json above,
  // not spread onto campus.json alongside places.json's raw contents.
  const { roads, ...curatedForCampus } = curated
  void roads

  const campus = {
    meta: {
      name: 'VIT Vellore',
      built: new Date().toISOString().slice(0, 10),
      center: [79.1606601, 12.9697498],
      attribution: '© OpenStreetMap contributors (ODbL)',
      counts,
    },
    categories: CATEGORIES,
    pois: poiList,
    ...curatedForCampus,
  }

  await mkdir(OUT, { recursive: true })
  await writeFile(join(OUT, 'campus.json'), JSON.stringify(campus))
  await writeFile(join(OUT, 'geo.json'), JSON.stringify(geo))
  await writeFile(join(OUT, 'graph.json'), JSON.stringify(graph))

  const kb = (o) => (JSON.stringify(o).length / 1024).toFixed(0) + ' kB'
  console.log(`pois       ${poiList.length} (${poiList.length - curatedCount} osm + ${curatedCount} curated)`)
  console.log(`  ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  ')}`)
  console.log(`geo        ${buildingF.length} buildings, ${pathF.length} paths, ${roadF.length} roads, ${greenF.length} green`)
  console.log(`graph      ${gLat.length} nodes, ${gEdges.length} edges (${graph.dropped} off-network nodes dropped)`)
  for (const k of Object.keys(curated)) {
    console.log(`curated    ${k}: ${curated[k]?.items?.length ?? 0} items`)
  }
  console.log(`output     campus ${kb(campus)}, geo ${kb(geo)}, graph ${kb(graph)}`)
  if (warnings.length) {
    console.log(`\n${warnings.length} warning(s):`)
    for (const w of [...new Set(warnings)].slice(0, 25)) console.log(`  ! ${w}`)
  }
}

export { classify, hostelCat }

// Only auto-build when run directly; importers reuse the classifier above.
const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invoked) main().catch((e) => { console.error(e); process.exit(1) })
