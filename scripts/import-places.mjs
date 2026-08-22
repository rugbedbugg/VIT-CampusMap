// Scrapes vit.ac.in for place candidates and merges everything that can be
// placed without invention into data/curated/places.json.
//
// A candidate becomes a curated row only when its normalised name matches a
// real OSM feature to anchor beside (or it carries surveyed coordinates).
// Everything else is logged and skipped; the campus philosophy is "nothing
// invented", so a name without a location never reaches the map.
//
//   node scripts/import-places.mjs           # apply
//   node scripts/import-places.mjs --dry     # report only

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CURATED_FILE = join(ROOT, 'data/curated/places.json')
const RAW = join(ROOT, 'data/raw')
const DRY = process.argv.includes('--dry')

const PAGES = [
  'https://vit.ac.in/schools',
  'https://vit.ac.in/campuslife/hostels',
  'https://vit.ac.in/campuslife/healthservices',
  'https://vit.ac.in/guest-house',
]

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const slug = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'VIT-CampusMap importer (+https://github.com/rugbedbugg/VIT-CampusMap)',
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

function toLines(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&#8217;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#8211;/g, '-')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

/* ── candidate extraction ──────────────────────────────────────────────── */
//
// Schools page renders a flat list ("School of … (ACRONYM)") between the
// "List of Schools" heading and the next section. Prose pages are scanned
// for a few well-known facility names worth having if OSM ever lacks them.

const FACILITY_PHRASES = [
  { re: /\bVIT Health Centre\b/i, name: 'Health Centre', cat: 'health' },
  { re: /\bFood Court\b/, name: 'Food Court', cat: 'canteen' },
  { re: /\bGuest House\b/i, name: 'VIT Guest House', cat: 'academic' },
]

// Where scraped names have no OSM twin, common campus knowledge can still
// anchor them to the building they live in. Keyed by acronym or normalised
// name -> EXACT OSM feature name. Static hints win over the scraped
// infrastructure pages below, so only keep entries here that are certain.
const ANCHOR_HINTS = {
  scope: 'Silver Jubilee Tower',
  score: 'Technology Tower',
  sense: 'Technology Tower',
  select: 'Technology Tower',
  sas: 'Technology Tower',
  ssl: 'Technology Tower',
  vaial: 'Perl Research Park',
  sbst: 'Sir M Visvesvaraya Block',
}

function resolveHint(c) {
  const keys = [norm(c.name), ...c.aliases.map((a) => norm(a))]
  for (const k of keys) {
    const anchor = ANCHOR_HINTS[k]
    if (anchor) return anchor
  }
  return undefined
}

/* ── infrastructure pages ──────────────────────────────────────────────── */
//
// vit.ac.in/about/infrastructure/<building> pages name the schools a
// building houses, both in prose ("houses 4 schools: SELECT, SENSE…")
// and in per-floor Department columns. Counting uppercase acronym mentions
// per page and keeping the strongest building turns those pages into
// school→building anchors without hand-maintaining them.

const INFRA_INDEX = 'https://vit.ac.in/about/infrastructure'

// Page slug -> EXACT OSM feature name. Slugs not listed here have no twin
// in OSM to anchor against yet (cbmr, almudailar-block).
const INFRA_SLUG_OSM = {
  'main-building': 'Main Building',
  'silver-jubilee-tower': 'Silver Jubilee Tower',
  'technology-tower': 'Technology Tower',
  'sirmvishveshvaraiya-building': 'Sir M Visvesvaraya Block',
  'gdnaidu-block': 'G.D Naidu Block',
  'cdmm-building': 'CDMM Building',
  'prp-block': 'Perl Research Park',
}

const INFRA_MIN_MENTIONS = 5

async function scrapeInfraAssignments(acronyms) {
  const out = new Map() // acronym -> { anchor, count }
  let urls = []
  try {
    const index = await fetchText(INFRA_INDEX)
    urls = [...new Set(
      [...index.matchAll(/href=["']([^"']*\/about\/infrastructure\/[a-z0-9\-]+)["']/gi)]
        .map((m) => m[1].replace(/^https?:\/\/vit\.ac\.in/, '')),
    )]
  } catch (e) {
    console.error(`! ${INFRA_INDEX}: ${e.message}: no infra anchors scraped`)
    return out
  }

  for (const path of urls) {
    const osmName = INFRA_SLUG_OSM[path.split('/').pop()]
    if (!osmName) continue
    try {
      const text = toLines(await fetchText(`https://vit.ac.in${path}`)).join('\n')
      for (const ac of acronyms) {
        const n = text.match(new RegExp(`\\b${ac}\\b`, 'g'))?.length ?? 0
        if (n < INFRA_MIN_MENTIONS) continue
        const cur = out.get(ac)
        if (!cur || n > cur.count) out.set(ac, { anchor: osmName, count: n })
      }
    } catch (e) {
      console.error(`! ${path}: ${e.message}: skipping building page`)
    }
  }
  return out
}

function collectCandidates(url, lines) {
  const out = []
  if (url.endsWith('/schools')) {
    let inList = false
    for (const line of lines) {
      if (/^list of schools$/i.test(line)) { inList = true; continue }
      if (inList && /^co-po-pso/i.test(line)) break
      if (!inList) continue
      const m = /^(.+?)\s*\(([^()]+)\)$/.exec(line)
      const name = m ? m[1] : line
      if (!/^(?:VIT\s+)?(?:.*\b)?School of /.test(name) && !/^VIT Business School/i.test(name)) continue
      out.push({ name, aliases: m ? [m[2]] : [], cat: 'academic', source: url })
    }
  } else {
    const text = lines.join('\n')
    for (const p of FACILITY_PHRASES) {
      if (p.re.test(text)) out.push({ name: p.name, aliases: [], cat: p.cat, source: url })
    }
  }
  return out
}

/* ── OSM inventory ─────────────────────────────────────────────────────── */

async function osmAnchors() {
  const map = new Map() // normalised name -> display name of an OSM feature
  for (const f of ['pois', 'buildings', 'land']) {
    const path = join(RAW, `${f}.json`)
    if (!existsSync(path)) continue
    const j = JSON.parse(await readFile(path, 'utf8'))
    for (const el of j.elements || []) {
      const t = el.tags || {}
      if (!t.name) continue
      for (const k of ['name', 'alt_name', 'name:en']) {
        if (t[k] && !map.has(norm(t[k]))) map.set(norm(t[k]), t.name)
      }
    }
  }
  return map
}

/* ── main ──────────────────────────────────────────────────────────────── */

const added = []
const skipped = []

async function main() {
  const curated = existsSync(CURATED_FILE)
    ? JSON.parse(await readFile(CURATED_FILE, 'utf8'))
    : { _readme: 'Places OpenStreetMap does not carry yet.', _source: 'survey', _schema: {}, items: [] }
  const items = curated.items ?? (curated.items = [])

  const anchors = await osmAnchors()
  const curatedNames = new Set(items.map((p) => norm(p.name)))
  const curatedIds = new Set(items.map((p) => p.id))

  const pages = []
  for (const url of PAGES) {
    try {
      pages.push([url, toLines(await fetchText(url))])
    } catch (e) {
      console.error(`! ${url}: ${e.message}: skipping source`)
    }
  }

  const seen = new Set()
  const cands = []
  for (const [url, lines] of pages) {
    for (const c of collectCandidates(url, lines)) {
      const key = norm(c.name)
      if (!seen.has(key)) { seen.add(key); cands.push(c) }
    }
  }

  // School acronyms worth looking for on the infrastructure pages.
  const acronyms = new Set(Object.keys(ANCHOR_HINTS).filter((k) => /^[a-z0-9\-]+$/.test(k)))
  for (const c of cands) for (const a of c.aliases) if (/^[A-Z0-9][A-Z0-9\-]+$/.test(a)) acronyms.add(a)
  const infra = await scrapeInfraAssignments([...acronyms])
  if (infra.size) {
    console.log(`infra      ${[...infra].map(([ac, v]) => `${ac}->${v.anchor}`).join(' ')}`)
  }

  for (const c of cands) {
    const key = norm(c.name)

    if (anchors.has(key)) { skipped.push([c.name, 'already in OSM']); continue }
    if (curatedNames.has(key)) { skipped.push([c.name, 'already curated']); continue }

    const aliasHit = c.aliases.map((a) => infra.get(a)).find(Boolean)
    const anchor = anchors.get(key) ?? resolveHint(c) ?? aliasHit?.anchor
    if (!anchor) {
      skipped.push([c.name, 'no location known (not in OSM, no coordinates, no hint)'])
      continue
    }

    const id = slug(c.name)
    if (curatedIds.has(id)) { skipped.push([c.name, 'id collision']); continue }

    curatedIds.add(id)
    curatedNames.add(key)
    const item = {
      id,
      name: c.name,
      cat: c.cat,
      anchor,
      ...(c.aliases.length ? { aliases: c.aliases } : {}),
    }
    if (!DRY) items.push(item)
    added.push(item)
  }

  if (!DRY && added.length) {
    await writeFile(CURATED_FILE, JSON.stringify(curated, null, 2) + '\n')
  }

  console.log(`sources    ${pages.length}/${PAGES.length} scraped`)
  console.log(`added      ${added.length}`)
  for (const p of added) console.log(`  + ${p.name} -> ${p.anchor}${p.aliases?.length ? ` (${p.aliases.join(', ')})` : ''}`)
  console.log(`skipped    ${skipped.length}`)
  for (const [name, why] of skipped) console.log(`  - ${name}: ${why}`)
  if (DRY) console.log('dry run    nothing written')
}

main().catch((e) => { console.error(e); process.exit(1) })
