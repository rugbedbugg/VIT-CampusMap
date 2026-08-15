import type { Campus, Poi } from '../types'
import { metresBetween } from '../route/router'

/** Everyday utility stops: the categories worth surfacing next to *any* place. */
const AMENITY: ReadonlySet<string> = new Set(['cycle', 'atm', 'print', 'laundry', 'health', 'canteen', 'shop'])

export function nearestAmenities(
  campus: Campus,
  from: { id?: string; lat: number; lon: number },
  limit = 3,
): { poi: Poi; metres: number }[] {
  return campus.pois
    .filter((p) => p.id !== from.id && AMENITY.has(p.cat))
    .map((p) => ({ poi: p, metres: metresBetween(from.lat, from.lon, p.lat, p.lon) }))
    .sort((a, b) => a.metres - b.metres)
    .slice(0, limit)
}
