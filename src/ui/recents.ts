const REC_KEY = 'vitmap.recent'
const STAR_KEY = 'vitmap.starred'
const MAX_RECENT = 6

function readIds(key: string): string[] {
  try { return JSON.parse(localStorage.getItem(key) ?? '[]') } catch { return [] }
}

function writeIds(key: string, ids: string[]) {
  try { localStorage.setItem(key, JSON.stringify(ids)) } catch { /* storage disabled or full, a nicety, not core */ }
}

export function getRecent(): string[] { return readIds(REC_KEY) }

export function pushRecent(id: string) {
  const ids = readIds(REC_KEY).filter((x) => x !== id)
  ids.unshift(id)
  writeIds(REC_KEY, ids.slice(0, MAX_RECENT))
}

export function getStarred(): string[] { return readIds(STAR_KEY) }
export function isStarred(id: string): boolean { return getStarred().includes(id) }

/** Returns the new starred state. */
export function toggleStar(id: string): boolean {
  const ids = readIds(STAR_KEY)
  const i = ids.indexOf(id)
  if (i >= 0) { ids.splice(i, 1); writeIds(STAR_KEY, ids); return false }
  ids.unshift(id)
  writeIds(STAR_KEY, ids)
  return true
}
