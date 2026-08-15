import type { Campus, Poi } from '../types'
import { openNow } from '../search/hours'
import { humanDistance, humanEta } from '../route/router'
import { nearestAmenities } from '../search/nearest'
import { isStarred, toggleStar } from './recents'

const el = document.getElementById('panel') as HTMLElement

export const REPO = 'https://github.com/rugbedbugg/vit-map'

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

export interface PanelHost {
  campus: Campus
  routeTo(lat: number, lon: number, label: string): void
  routeState(): { active: boolean; eta?: number; metres?: number }
  close(): void
  report(): void
  onRecentsChange(): void
}

let host: PanelHost

export function initPanel(h: PanelHost) {
  host = h
  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    if (t.closest('.p-close')) { hidePanel(); host.close() }
    const r = t.closest('[data-route]') as HTMLElement | null
    if (r) host.routeTo(+r.dataset.lat!, +r.dataset.lon!, r.dataset.label!)
    if (t.closest('[data-report]')) { hidePanel(); host.report() }
    const star = t.closest('[data-star]') as HTMLElement | null
    if (star) {
      const on = toggleStar(star.dataset.id!)
      star.setAttribute('aria-pressed', String(on))
      star.title = on ? 'Unstar this place' : 'Star this place'
      host.onRecentsChange()
    }
  })
}

export function hidePanel() { el.hidden = true }

/** `code` is the OSM id, or "SEED" for a hand-curated place. `id` renders a star toggle. */
function shell(title: string, kind: string, code: string, body: string, id?: string) {
  el.hidden = false
  const star = id ? `<button class="p-star" data-star data-id="${esc(id)}"
      aria-pressed="${isStarred(id)}" title="${isStarred(id) ? 'Unstar this place' : 'Star this place'}">*</button>` : ''
  el.innerHTML = `
    <span class="hud-corner tl" aria-hidden="true"></span>
    <span class="hud-corner tr" aria-hidden="true"></span>
    <span class="hud-corner bl" aria-hidden="true"></span>
    <span class="hud-corner br" aria-hidden="true"></span>
    <div class="p-grip" aria-hidden="true"></div>
    <div class="p-strip">
      <span class="p-strip-label"><span class="blink-dot" aria-hidden="true"></span>${esc(kind)}</span>
      <span class="p-strip-code">${esc(code)}</span>
    </div>
    <div class="p-head">
      <h2>${esc(title)}</h2>
      ${star}
      <button class="p-close" aria-label="Close">&times;</button>
    </div>
    <div class="p-body">${body}</div>`
  el.querySelector('.p-body')!.scrollTop = 0
}

function kv(rows: [string, string | undefined][]) {
  const live = rows.filter(([, v]) => v)
  if (!live.length) return ''
  return `<dl class="kv">${live.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`
}

function hoursRow(spec?: string): string | undefined {
  if (!spec) return undefined
  const st = openNow(spec)
  const badge = st === null ? ''
    : st.open ? ` <span style="color:#55ff55">· open${st.until ? ` till ${st.until}` : ''}</span>`
    : ` <span style="color:#ff5555">· closed${st.next ? ` · opens ${st.next}` : ''}</span>`
  return `${esc(spec)}${badge}`
}

function routeButtons(lat: number, lon: number, label: string) {
  const s = host.routeState()
  return `<div class="p-actions">
    <button data-route data-lat="${lat}" data-lon="${lon}" data-label="${esc(label)}"
      class="${s.active ? 'on' : ''}">${s.active && s.eta != null
        ? `${humanEta(s.eta)} · ${humanDistance(s.metres!)}`
        : 'Route here'}</button>
  </div>`
}

/* ── places ──────────────────────────────────────────────────────────────── */

function nearestRow(np: Poi, metres: number) {
  const colour = host.campus.categories[np.cat]?.color ?? '#8b949e'
  return `<li><span class="dot" style="background:${colour}"></span>
    <span class="p-near-name">${esc(np.name)}</span>
    <span class="p-near-d">${humanDistance(metres)}</span></li>`
}

export function showPoi(p: Poi) {
  const cat = host.campus.categories[p.cat]
  const wheel = p.wheelchair === 'yes' ? 'step-free'
    : p.wheelchair === 'limited' ? 'limited'
    : p.wheelchair === 'no' ? 'not step-free' : undefined
  const near = nearestAmenities(host.campus, p, 3)

  const body = [
    p.image ? `<img class="p-photo" src="${esc(p.image)}" alt="" loading="lazy" onerror="this.remove()">` : '',
    routeButtons(p.lat, p.lon, p.name),
    kv([
      ['Hours', hoursRow(p.hours)],
      ['Access', wheel ? esc(wheel) : undefined],
      ['Type', p.kind ? esc(p.kind.replace(/_/g, ' ')) : undefined],
      ['Floor', p.level ? esc(p.level) : undefined],
      ['Cuisine', p.cuisine ? esc(p.cuisine.replace(/;/g, ', ')) : undefined],
      ['Capacity', p.capacity ? esc(p.capacity) : undefined],
      ['Covered', p.covered ? esc(p.covered) : undefined],
      ['Operator', p.operator ? esc(p.operator) : undefined],
      ['Price', p.price ? esc(p.price) : undefined],
      ['Potable', p.potable === 'no' ? 'no, not drinking water' : undefined],
      ['Lamp', p.lampType ? esc(p.lampType.toUpperCase()) : undefined],
      ['Mounted', p.support ? esc(p.support) : undefined],
      ['Phone', p.phone ? `<a href="tel:${esc(p.phone)}">${esc(p.phone)}</a>` : undefined],
      ['Website', p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url.replace(/^https?:\/\//, '').slice(0, 34))}</a>` : undefined],
      ['Near', p.near ? esc(p.near) : undefined],
      ['Coords', `<span class="mono-coords">${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}</span>`],
    ]),
    p.desc ? `<p class="p-note">${esc(p.desc)}</p>` : '',
    near.length ? `<div class="p-sec">Nearest</div>
      <ul class="p-near">${near.map(({ poi: np, metres }) => nearestRow(np, metres)).join('')}</ul>` : '',
    `<p class="src">${p.src === 'osm'
      ? `OpenStreetMap · <a href="https://www.openstreetmap.org/${esc(p.osm)}" target="_blank" rel="noopener">${esc(p.osm)}</a>`
      : 'Hand-surveyed, verify before relying on it'}</p>`,
  ].join('')

  shell(p.name, cat?.label ?? p.cat, p.osm ?? 'SEED', body, p.id)
}

/* ── about ───────────────────────────────────────────────────────────────── */

export function showAbout(campus: Campus) {
  const body = `
    <div class="p-surveil">
      <img src="/images/campus-aerial.jpg" alt="Aerial view of the VIT Vellore campus" loading="lazy">
      <span class="p-surveil-tag"><span class="blink-dot" aria-hidden="true"></span>SAT-VIEW · CAMPUS</span>
    </div>

    <p class="p-note">Everything here comes from a public source. Where there is 
    no source, the feature is simply absent.</p>

    <div class="p-sec">Map & places</div>
    <p class="p-note">
    Geometry, opening hours and wheelchair tags from
    <a href="https://www.openstreetmap.org/relation/15931944" target="_blank" rel="noopener">OpenStreetMap</a>,
    ODbL.</p>

    <div class="p-sec">Contribute</div>
    <p class="p-note"><b>Know a place that's not marked here?</b> Drop a pin on
    the map, and it opens a ready-to-file issue on GitHub asking for that spot
    to be added. Or map it directly on
    <a href="https://www.openstreetmap.org/relation/15931944" target="_blank" rel="noopener">OpenStreetMap</a>
    and this picks it up on the next build.</p>
    <div class="p-actions">
      <button data-report>Mark a location</button>
    </div>
    <p class="p-note">A faster, in-app way to submit reports (no GitHub detour
    required) is in the works.</p>
    <p class="p-note">Everything else: <a href="${REPO}" target="_blank" rel="noopener">${REPO.replace(/^https?:\/\//, '')}</a>.</p>

    <p class="src">Built ${esc(campus.meta.built)} · ${esc(campus.meta.attribution)}
    · <a href="${REPO}" target="_blank" rel="noopener">source</a></p>`

  shell(campus.meta.name, 'About & sources', 'SYS', body)
}
