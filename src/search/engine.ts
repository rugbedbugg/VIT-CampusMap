import type { Campus, Poi } from '../types'
import { openNow } from './hours'

/* ── documents ───────────────────────────────────────────────────────────── */

export type Kind = 'place' | 'layer' | 'action' | 'hint'

export interface Doc {
  kind: Kind
  id: string
  title: string
  sub: string
  /** Everything matchable, lowercase, space-joined. Built once. */
  hay: string
  /** Tokens given prefix-match priority: the name words, codes, aliases. */
  keys: string[]
  cat?: string
  lat?: number
  lon?: number
  poi?: Poi
  hours?: string
  /** Nudges ties: higher wins. */
  boost: number
  run?: () => void
}

export interface Hit extends Doc {
  score: number
  /** Character indices in `title` that matched, for highlighting. */
  marks: number[]
}

const lower = (s: string) => s.toLowerCase()
const words = (s: string) => lower(s).split(/[^a-z0-9]+/).filter(Boolean)

/* ── scoring ─────────────────────────────────────────────────────────────── */

/** fzf-style subsequence match. Left-anchored and word-start matches score higher. */
function fuzzy(needle: string, hay: string): { score: number; at: number[] } | null {
  if (!needle) return { score: 0, at: [] }
  const n = needle.length, h = hay.length
  if (n > h) return null

  const at: number[] = []
  let score = 0
  let hi = 0
  let streak = 0

  for (let ni = 0; ni < n; ni++) {
    const c = needle[ni]!
    let found = -1
    while (hi < h) {
      if (hay[hi] === c) { found = hi; break }
      hi++
    }
    if (found === -1) return null

    let bonus = 1
    const prev = found > 0 ? hay[found - 1]! : ' '
    if (found === 0) bonus += 8
    else if (prev === ' ' || prev === '-' || prev === '/') bonus += 6
    else if (prev >= '0' && prev <= '9' && !(c >= '0' && c <= '9')) bonus += 2

    streak = at.length && at[at.length - 1] === found - 1 ? streak + 1 : 0
    bonus += Math.min(streak * 3, 12)

    score += bonus
    at.push(found)
    hi = found + 1
  }

  // Prefer shorter haystacks and matches that start early.
  score -= Math.min(at[0]! * 0.4, 12)
  score -= Math.min(h * 0.02, 6)
  return { score, at }
}

function scoreDoc(doc: Doc, q: string, qWords: string[]): Hit | null {
  // 1. Exact / prefix on a key token, the strongest signal by far.
  let best = -1
  let marks: number[] = []

  for (const k of doc.keys) {
    if (k === q) { best = Math.max(best, 1000); break }
    if (k.startsWith(q)) best = Math.max(best, 700 - (k.length - q.length))
  }

  // 2. Title fuzzy.
  const t = fuzzy(q, lower(doc.title))
  if (t) {
    const s = 300 + t.score
    if (s > best) { best = s; marks = t.at }
  }

  // 3. Every query word must appear somewhere, order-independent.
  if (best < 0 && qWords.length > 1) {
    let all = true
    let sum = 0
    for (const w of qWords) {
      const i = doc.hay.indexOf(w)
      if (i === -1) { all = false; break }
      sum += 40 - Math.min(i * 0.05, 20)
    }
    if (all) best = sum
  }

  // 4. Last resort: substring anywhere in the haystack.
  if (best < 0) {
    const i = doc.hay.indexOf(q)
    if (i === -1) return null
    best = 30 - Math.min(i * 0.05, 20)
  }

  return { ...doc, score: best + doc.boost, marks }
}

/* ── index ───────────────────────────────────────────────────────────────── */

export class SearchIndex {
  readonly docs: Doc[] = []

  constructor(campus: Campus, hooks: {
    onLayer: (cat: string) => void
    onAction: (id: string) => void
  }) {
    for (const p of campus.pois) {
      // 23 identical "Street light" rows would drown the results. The layer
      // entry below still makes them reachable by name.
      if (p.cat === 'light') continue
      const alias = ALIASES[p.cat] ?? []
      // "Lecture Hall 20" should be reachable as L20, LH20, l 20.
      const short = /^Lecture Hall (\d+)$/.exec(p.name)
      // Whole-phrase keys as well as word keys: "hall 6" has to match Girls
      // Hostel 6 exactly, or Lecture Hall 6 wins it on a contiguous title match.
      const keys = [
        lower(p.name), ...words(p.name), ...alias,
        ...(p.aliases ?? []).flatMap((x) => [lower(x), ...words(x)]),
      ]
      if (short) keys.push(`l${short[1]}`, `lh${short[1]}`, short[1]!)
      const hallNo = /^Hall ?(\d+)/.exec(p.name)
      if (hallNo) keys.push(`h${hallNo[1]}`)

      this.docs.push({
        kind: 'place',
        id: p.id,
        title: p.name,
        sub: [campus.categories[p.cat]?.label, p.near ? `near ${p.near}` : '', p.operator ?? '']
          .filter(Boolean).join(' · '),
        hay: lower([p.name, p.alt, ...(p.aliases ?? []), p.cat, campus.categories[p.cat]?.label,
                    p.kind, p.operator, p.cuisine, p.desc, p.near, ...alias].filter(Boolean).join(' ')),
        keys,
        cat: p.cat,
        lat: p.lat, lon: p.lon,
        poi: p,
        hours: p.hours,
        boost: (p.unnamed ? -30 : 0) + (campus.categories[p.cat]?.pin ? 12 : 0),
      })
    }

    for (const [cat, meta] of Object.entries(campus.categories)) {
      const n = campus.meta.counts[cat] ?? 0
      if (!n) continue
      this.docs.push({
        kind: 'layer',
        id: `layer:${cat}`,
        title: meta.label,
        sub: `Show all ${n} on the map`,
        hay: lower([cat, meta.label, ...(ALIASES[cat] ?? [])].join(' ')),
        keys: [cat, ...words(meta.label), ...(ALIASES[cat] ?? [])],
        cat,
        boost: 8,
        run: () => hooks.onLayer(cat),
      })
    }

    for (const a of ACTIONS) {
      this.docs.push({
        kind: 'action',
        id: `do:${a.id}`,
        title: a.title,
        sub: a.sub,
        hay: lower([a.title, a.sub, a.words].join(' ')),
        keys: words(a.title + ' ' + a.words),
        boost: 2,
        run: () => hooks.onAction(a.id),
      })
    }
  }

  search(raw: string, limit = 40): Hit[] {
    const q = lower(raw.trim())
    if (!q) return []
    const qWords = words(q)

    const out: Hit[] = []
    for (const doc of this.docs) {
      const hit = scoreDoc(doc, q, qWords)
      if (hit) out.push(hit)
    }
    out.sort((a, b) => b.score - a.score || a.title.length - b.title.length)

    // "open now" nudge: among close scores, prefer somewhere you can actually go.
    const top = out.slice(0, limit)
    for (const h of top) {
      const st = openNow(h.hours)
      if (st?.open) h.score += 3
    }
    top.sort((a, b) => b.score - a.score)
    return top
  }

  /** Suggestions for the empty state: real things that exist in this data. */
  examples(): string[] {
    return ['cycle parking', 'atm', 'printing', 'library', 'hostel']
  }
}

/* ── vocabulary ──────────────────────────────────────────────────────────── */

/** Words a student would actually type for each category. */
const ALIASES: Record<string, string[]> = {
  lecture: ['auditorium', 'audi', 'lecture', 'class', 'hall'],
  academic: ['dept', 'department', 'lab', 'building', 'office'],
  hostel: ['hostel', 'hostels', 'hall', 'room', 'wing', 'block'],
  mess: ['mess', 'food', 'khana', 'meal', 'breakfast', 'lunch', 'dinner'],
  canteen: ['canteen', 'cafe', 'coffee', 'food', 'eat', 'restaurant', 'snack', 'chai', 'tea', 'juice', 'vending', 'machine', 'chips'],
  library: ['library', 'study', 'read', 'books', 'quiet', 'classroom'],
  shop: ['shop', 'store', 'buy', 'grocery', 'market', 'stationery'],
  print: ['print', 'printer', 'printout', 'xerox', 'photocopy', 'copy', 'scan', 'binding'],
  atm: ['atm', 'cash', 'money', 'bank', 'withdraw'],
  cycle: ['cycle', 'cycles', 'bike', 'bicycle', 'parking', 'stand', 'puncture', 'repair'],
  laundry: ['laundry', 'wash', 'washing', 'dhobi', 'clothes', 'iron', 'dryclean'],
  health: ['health', 'doctor', 'hospital', 'clinic', 'medical', 'pharmacy', 'medicine', 'emergency', 'counselling'],
  sports: ['sports', 'gym', 'ground', 'court', 'field', 'pool', 'swim', 'run', 'track', 'play'],
  transport: ['parking', 'car', 'vehicle', 'bus', 'fuel', 'petrol', 'auto', 'taxi', 'charging'],
  green: ['park', 'garden', 'green', 'lawn'],
}

const ACTIONS = [
  { id: 'layers-all', title: 'Show every layer', sub: 'Turn all categories on', words: 'all layers everything show' },
  { id: 'layers-none', title: 'Hide every layer', sub: 'Clear the map', words: 'none clear hide reset layers' },
  { id: 'clear-route', title: 'Clear route', sub: 'Remove the drawn path', words: 'route clear cancel remove path' },
  { id: 'about', title: 'About & data sources', sub: 'Where every number comes from', words: 'about data source credit osm attribution help' },
  { id: 'report', title: 'Report a missing place', sub: 'Drop a pin and open an issue', words: 'missing add report wrong hall lecture hostel contribute fix pin' },
]
