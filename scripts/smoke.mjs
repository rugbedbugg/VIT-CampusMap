// Headless smoke test of the search index and router.
//   npm run smoke

import { build } from 'esbuild'
import { readFile, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TMP = join(ROOT, 'node_modules/.cache/smoke.mjs')

let failures = 0
const ok = (cond, label, detail = '') => {
  if (cond) console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`)
  else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

await build({
  entryPoints: [join(ROOT, 'src/search/engine.ts')],
  bundle: true, format: 'esm', platform: 'node', outfile: TMP, logLevel: 'silent',
})
const { SearchIndex } = await import(pathToFileURL(TMP).href + `?t=${Date.now()}`)

const ROUTER_TMP = join(ROOT, 'node_modules/.cache/smoke-router.mjs')
await build({
  entryPoints: [join(ROOT, 'src/route/router.ts')],
  bundle: true, format: 'esm', platform: 'node', outfile: ROUTER_TMP, logLevel: 'silent',
})
const { Router, humanEta } = await import(pathToFileURL(ROUTER_TMP).href + `?t=${Date.now()}`)

const campus = JSON.parse(await readFile(join(ROOT, 'public/data/campus.json'), 'utf8'))
const graph = JSON.parse(await readFile(join(ROOT, 'public/data/graph.json'), 'utf8'))

/* ── search ──────────────────────────────────────────────────────────────── */

console.log('\nsearch')
const index = new SearchIndex(campus, { onLayer: () => {}, onAction: () => {} })
console.log(`  ${index.docs.length} documents indexed`)

const top = (q) => index.search(q)[0]
const titles = (q, n = 3) => index.search(q).slice(0, n).map((h) => h.title)

// Only assert on a category if this campus's OSM data actually has some.
for (const cat of ['atm', 'cycle', 'print', 'library']) {
  if (!campus.meta.counts[cat]) continue
  ok(index.search(cat).some((h) => h.cat === cat || h.kind === 'layer'),
     `${cat} -> ${cat} layer/place`, top(cat)?.title)
}
ok(titles('cycle parking').some((t) => /[Cc]ycle/.test(t)), 'cycle parking', titles('cycle parking').join(' / '))
ok(index.search('library').length > 0, 'library', titles('library').join(' / '))
ok(index.search('hostel').length > 0, 'hostel', titles('hostel').join(' / '))

console.log('\n  latency')
for (const q of ['m', 'library', 'lecture hall', 'water cooler', 'a']) {
  const t0 = performance.now()
  for (let i = 0; i < 50; i++) index.search(q)
  const per = (performance.now() - t0) / 50
  ok(per < 12, `"${q}" ${per.toFixed(2)}ms/query`)
}

/* ── routing ─────────────────────────────────────────────────────────────── */

console.log('\nrouting')
const router = new Router(graph)
const find = (n) => campus.pois.find((p) => p.name === n)

const pairs = [
  // OSM renames campus features without notice (A Hostel became "B Block" etc.
  // in Aug 2026), so route between landmarks likely to keep their names.
  ["Men's Hostel Indoor Stadium", 'Anna Auditorium'],
  ['EV Periyar Library', 'CDMM Building'],
  ['DC Bakery', 'Main Building'],
]
for (const [a, b] of pairs) {
  const A = find(a), B = find(b)
  if (!A || !B) { ok(false, `${a} -> ${b}`, 'POI missing'); continue }
  const walk = router.route(A, B, 'foot')
  const bike = router.route(A, B, 'bike')
  if (!walk || !bike) {
    ok(false, `${a} -> ${b}`, `no route on ${!walk && !bike ? 'either profile' : !walk ? 'foot' : 'bike'}`)
    continue
  }
  const straight = Math.hypot((A.lat - B.lat) * 111320, (A.lon - B.lon) * 99000)
  const detour = walk.metres / Math.max(straight, 1)
  ok(detour > 0.95 && detour < 3.5 && bike.seconds < walk.seconds,
     `${a} -> ${b}`,
     `${walk.metres}m walk ${humanEta(walk.seconds)} / cycle ${humanEta(bike.seconds)} (detour ${detour.toFixed(2)}x)`)
}

// Every pinned POI must be reachable on both profiles.
const centre = { lat: campus.meta.center[1], lon: campus.meta.center[0] }
const pinned = campus.pois.filter((p) => campus.categories[p.cat]?.pin)
for (const profile of ['foot', 'bike']) {
  const bad = pinned.filter((p) => !router.route(centre, p, profile))
  ok(bad.length === 0, `all ${pinned.length} pinned POIs reachable by ${profile}`,
     bad.length ? `${bad.length} unreachable, e.g. ${bad.slice(0, 3).map((p) => p.name).join(', ')}` : '')
}

const t0 = performance.now()
for (let i = 0; i < 30; i++) router.route(centre, pinned[i % pinned.length], 'foot')
ok((performance.now() - t0) / 30 < 40, `route latency ${((performance.now() - t0) / 30).toFixed(1)}ms`)

/* ── map style ───────────────────────────────────────────────────────────── */

console.log('\nmap style')
const STYLE_TMP = join(ROOT, 'node_modules/.cache/smoke-style.mjs')
await build({
  entryPoints: [join(ROOT, 'src/map/style.ts')],
  bundle: true, format: 'esm', platform: 'node', outfile: STYLE_TMP, logLevel: 'silent',
  external: ['maplibre-gl'],
})
const { buildStyle } = await import(pathToFileURL(STYLE_TMP).href + `?t=${Date.now()}`)
const { validateStyleMin } = await import('@maplibre/maplibre-gl-style-spec')

const geo = JSON.parse(await readFile(join(ROOT, 'public/data/geo.json'), 'utf8'))
{
  const style = buildStyle(geo, campus)
  const errors = validateStyleMin(style)
  ok(errors.length === 0, `style validates (${style.layers.length} layers)`,
     errors.map((e) => e.message).join(' | '))

  const missing = style.layers.filter((l) => l.source && !style.sources[l.source]).map((l) => l.id)
  ok(missing.length === 0, 'every layer has a source', missing.join(', '))

  const bad = JSON.stringify(style).match(/"(?:[a-z-]*color)":\s*(null|"undefined")/g)
  ok(!bad, 'no undefined colours', bad?.join(', ') ?? '')
}

/* ── DOM contract ────────────────────────────────────────────────────────── */

// Every id the TypeScript reaches for must exist in index.html.
console.log('\ndom')
const html = await readFile(join(ROOT, 'index.html'), 'utf8')
const present = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))

const srcDir = join(ROOT, 'src')
const walk = async (dir) => {
  const out = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...await walk(p))
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

const wanted = new Map() // id -> file
for (const file of await walk(srcDir)) {
  const code = await readFile(file, 'utf8')
  for (const m of code.matchAll(/getElementById\(\s*['"]([^'"]+)['"]/g)) {
    if (!wanted.has(m[1])) wanted.set(m[1], file.replace(ROOT + '/', ''))
  }
  for (const m of code.matchAll(/querySelector(?:All)?\(\s*['"]#([A-Za-z0-9_-]+)['"]/g)) {
    if (!wanted.has(m[1])) wanted.set(m[1], file.replace(ROOT + '/', ''))
  }
}

// Elements the app creates at runtime rather than declaring in the markup.
const RUNTIME_IDS = new Set(['route-badge'])

const orphans = [...wanted].filter(([id]) => !present.has(id) && !RUNTIME_IDS.has(id))
ok(orphans.length === 0, `all ${wanted.size} referenced ids exist in index.html`,
   orphans.map(([id, f]) => `#${id} (${f})`).join(', '))

await rm(TMP, { force: true })
await rm(ROUTER_TMP, { force: true })
await rm(STYLE_TMP, { force: true })

console.log(failures ? `\n${failures} failure(s)\n` : '\nall good\n')
process.exit(failures ? 1 : 0)
