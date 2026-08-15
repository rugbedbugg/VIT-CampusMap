import './styles.css'
import maplibregl from 'maplibre-gl'
import type { Campus, Graph, Poi, Profile } from './types'
import { buildStyle } from './map/style'
import { Router, humanEta, humanDistance } from './route/router'
import { SearchIndex, type Hit } from './search/engine'
import { openNow } from './search/hours'
import { nearestAmenities } from './search/nearest'
import { initPalette, openPalette } from './ui/palette'
import { initPanel, showAbout, showPoi, hidePanel } from './ui/panel'
import { showPing, hidePing, showOrigin } from './ui/ping'
import { getRecent, getStarred, pushRecent } from './ui/recents'

const boot = document.getElementById('boot')!
const base = import.meta.env.BASE_URL

async function json<T>(path: string): Promise<T> {
  const res = await fetch(`${base}data/${path}`)
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
  return res.json() as Promise<T>
}

async function start() {
  const [campus, geo, graphData] = await Promise.all([
    json<Campus>('campus.json'),
    json<Record<string, GeoJSON.FeatureCollection>>('geo.json'),
    json<Graph>('graph.json'),
  ])

  const router = new Router(graphData)
  const byId = new Map(campus.pois.map((p) => [p.id, p]))
  const catColour = (cat: string) => campus.categories[cat]?.color ?? '#8b949e'

  /* ── map ──────────────────────────────────────────────────────────────── */

  const map = new maplibregl.Map({
    container: 'map',
    style: buildStyle(geo, campus, base),
    center: campus.meta.center,
    zoom: 15.1,
    minZoom: 13,
    maxZoom: 19.5,
    maxBounds: [[79.1484, 12.9634], [79.1720, 12.9805]],
    // Attribution lives in the page footer instead, same ODbL credit, one place.
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
  })
  map.touchZoomRotate.disableRotation()
  // Handle for scripts/verify-browser.mjs and for poking at the map in devtools.
  ;(window as unknown as { __map: maplibregl.Map }).__map = map
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right')

  // Live cursor fix, HUD-style. Freezes on the last position once the
  // pointer leaves the map rather than snapping back to campus centre.
  const hudCorners = `<span class="hud-corner tl" aria-hidden="true"></span>
    <span class="hud-corner tr" aria-hidden="true"></span>
    <span class="hud-corner bl" aria-hidden="true"></span>
    <span class="hud-corner br" aria-hidden="true"></span>`

  const coordsEl = document.getElementById('hud-coords')!
  coordsEl.innerHTML = `${hudCorners}
    <span class="hc-top"><span class="blink-dot" aria-hidden="true"></span>FIX</span>
    <span class="hc-val"></span>`
  const coordsVal = coordsEl.querySelector('.hc-val')!
  let fix = map.getCenter()
  function paintCoords() {
    coordsVal.textContent = `${fix.lat.toFixed(5)}N ${fix.lng.toFixed(5)}E · Z${map.getZoom().toFixed(1)}`
  }
  map.on('mousemove', (e) => { fix = e.lngLat; paintCoords() })
  map.on('move', paintCoords)
  paintCoords()

  // Campus status dossier: everything here is a straight count off the
  // loaded data, refreshed periodically so "open now" doesn't go stale.
  const statsBox = document.createElement('div')
  statsBox.id = 'stats-box'
  statsBox.innerHTML = `${hudCorners}
    <span class="hc-top"><span class="blink-dot" aria-hidden="true"></span>STATUS</span>
    <span class="s-line"></span>
    <span class="s-line accent"></span>`
  document.body.append(statsBox)
  const statsLines = statsBox.querySelectorAll<HTMLElement>('.s-line')
  function paintStats() {
    const buildings = geo.buildings?.features.length ?? 0
    const openNowCount = campus.pois.filter((p) => openNow(p.hours)?.open).length
    statsLines[0]!.textContent = `${campus.pois.length} places · ${buildings} buildings`
    statsLines[1]!.textContent = `${openNowCount} open now`
  }
  paintStats()
  setInterval(paintStats, 60_000)

  // Starred + recently viewed places, local to this browser only.
  const recentBox = document.createElement('div')
  recentBox.id = 'recent-box'
  recentBox.hidden = true
  document.body.append(recentBox)

  function recentRow(p: Poi, starred: boolean) {
    return `<button class="rec-row" data-focus="${p.id}">
      <span class="dot" style="background:${catColour(p.cat)}"></span>
      <span class="rec-name">${escapeHtml(p.name)}</span>
      ${starred ? '<span class="rec-star" aria-hidden="true">*</span>' : ''}
    </button>`
  }

  function paintRecents() {
    const starredIds = getStarred()
    const starredPois = starredIds.map((id) => byId.get(id)).filter((p): p is Poi => !!p)
    const recentPois = getRecent()
      .filter((id) => !starredIds.includes(id))
      .map((id) => byId.get(id))
      .filter((p): p is Poi => !!p)

    if (!starredPois.length && !recentPois.length) { recentBox.hidden = true; return }

    recentBox.hidden = false
    recentBox.innerHTML = `${hudCorners}
      <span class="hc-top"><span class="blink-dot" aria-hidden="true"></span>LOG</span>
      <div class="rec-list">
        ${starredPois.map((p) => recentRow(p, true)).join('')}
        ${recentPois.map((p) => recentRow(p, false)).join('')}
      </div>`
  }
  recentBox.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest('[data-focus]') as HTMLElement | null
    const p = row ? byId.get(row.dataset.focus!) : undefined
    if (p) focusPoi(p)
  })
  paintRecents()

  // First-visit hint. Dismisses itself on the first sign of interaction so
  // it never nags a returning visitor or lingers past the point of use.
  const ONBOARD_KEY = 'vitmap.onboarded'
  function isOnboarded(): boolean {
    try { return localStorage.getItem(ONBOARD_KEY) === '1' } catch { return true }
  }
  function setOnboarded() {
    try { localStorage.setItem(ONBOARD_KEY, '1') } catch { /* storage disabled, a nicety, not core */ }
  }

  const onboardHint = document.createElement('div')
  onboardHint.id = 'onboard-hint'
  onboardHint.hidden = true
  onboardHint.innerHTML = `${hudCorners}
    <div class="oh-body">
      <span class="hc-top"><span class="blink-dot" aria-hidden="true"></span>First time on the ground here</span>
      <ul class="oh-tips">
        <li><kbd>CTRL+SHIFT+F</kbd> locate any place</li>
        <li>right-click or long-press the map to report one that's missing</li>
      </ul>
    </div>
    <button class="oh-close" type="button" aria-label="Dismiss">&times;</button>`
  document.body.append(onboardHint)

  function dismissOnboard() {
    if (onboardHint.hidden) return
    onboardHint.hidden = true
    setOnboarded()
  }
  onboardHint.querySelector('.oh-close')!.addEventListener('click', dismissOnboard)

  function showOnboard() {
    if (isOnboarded()) return
    onboardHint.hidden = false
    document.addEventListener('pointerdown', dismissOnboard, { once: true, capture: true })
    document.addEventListener('keydown', dismissOnboard, { once: true, capture: true })
  }

  /* ── layer state ──────────────────────────────────────────────────────── */

  // Everything on by default: a student looking for a printer should not
  // have to discover a layer toggle first.
  const active = new Set(Object.keys(campus.categories).filter((c) => campus.meta.counts[c]))
  let focusId: string | null = null

  function poiFeatures(): GeoJSON.FeatureCollection {
    return {
      type: 'FeatureCollection',
      features: campus.pois
        .filter((p) => active.has(p.cat) || p.id === focusId)
        .map((p) => ({
          type: 'Feature' as const,
          id: p.id,
          properties: {
            id: p.id,
            name: p.name,
            cat: p.cat,
            color: catColour(p.cat),
            // `pin` = important enough to label from low zoom. `named` lets
            // everything else pick up a label once you are zoomed right in.
            pin: !!campus.categories[p.cat]?.pin && !p.unnamed,
            named: !p.unnamed,
            focus: p.id === focusId,
          },
          geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] },
        })),
    }
  }

  function refreshPois() {
    ;(map.getSource('pois') as maplibregl.GeoJSONSource | undefined)?.setData(poiFeatures())
    // Tint building footprints belonging to visible categories.
    if (map.getLayer('building-cat')) {
      map.setFilter('building-cat', ['all',
        ['!=', ['get', 'cat'], ''],
        ['in', ['get', 'cat'], ['literal', [...active]]],
      ])
    }
    paintChips()
  }

  /* ── layer chips ──────────────────────────────────────────────────────── */

  const rail = document.getElementById('layers')!
  const cats = Object.entries(campus.categories)
    .filter(([c]) => campus.meta.counts[c])
    .sort((a, b) => (campus.meta.counts[b[0]] ?? 0) - (campus.meta.counts[a[0]] ?? 0))

  const chipBox = document.getElementById('layer-chips')!
  const layersBtn = document.getElementById('layers-btn')!

  function paintRail() {
    chipBox.innerHTML = cats.map(([c, meta]) =>
      `<button class="chip" data-cat="${c}" aria-pressed="false" style="color:${catColour(c)}"
         title="${meta.label} · ${campus.meta.counts[c]}">
         <span class="dot"></span><span class="chip-label">${meta.label}</span><span class="n">${campus.meta.counts[c]}</span>
       </button>`).join('')
    paintChips()
  }
  paintRail()

  function paintChips() {
    chipBox.querySelectorAll<HTMLElement>('.chip').forEach((c) =>
      c.setAttribute('aria-pressed', String(active.has(c.dataset.cat!))))
    layersBtn.querySelector('.n')!.textContent = `${active.size}`
    layersBtn.setAttribute('aria-label', `Layers: ${active.size} of ${cats.length} shown`)
  }

  rail.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    if (t.closest('.layers-close')) { closeLayers(); return }
    if (t.closest('[data-all]')) { cats.forEach(([c]) => active.add(c)); refreshPois(); return }
    if (t.closest('[data-none]')) { active.clear(); refreshPois(); return }
    const chip = t.closest('.chip') as HTMLElement | null
    if (!chip) return
    const c = chip.dataset.cat!
    active.has(c) ? active.delete(c) : active.add(c)
    refreshPois()
  })

  // The sheet only exists on narrow screens; on desktop the chips are always
  // laid out in the dock and the button is hidden.
  const scrim = document.createElement('div')
  scrim.id = 'layers-scrim'
  scrim.hidden = true
  document.body.append(scrim)

  function openLayers() {
    rail.classList.add('open')
    scrim.hidden = false
    layersBtn.setAttribute('aria-expanded', 'true')
  }
  function closeLayers() {
    rail.classList.remove('open')
    scrim.hidden = true
    layersBtn.setAttribute('aria-expanded', 'false')
  }
  layersBtn.addEventListener('click', () =>
    rail.classList.contains('open') ? closeLayers() : openLayers())
  scrim.addEventListener('click', closeLayers)

  /* ── routing ──────────────────────────────────────────────────────────── */

  let profile: Profile = 'foot'
  let origin: { lat: number; lon: number; label: string } | null = null
  let target: { lat: number; lon: number; label: string } | null = null
  /** Metrics of the last successful route, so the panel button can show the ETA. */
  let lastRoute: { seconds: number; metres: number } | null = null

  const badge = document.createElement('div')
  badge.id = 'route-badge'
  badge.hidden = true
  document.body.append(badge)

  function clearRoute() {
    target = null
    lastRoute = null
    badge.hidden = true
    ;(map.getSource('route') as maplibregl.GeoJSONSource | undefined)
      ?.setData({ type: 'FeatureCollection', features: [] })
  }

  function drawRoute() {
    if (!target) return
    const from = origin ?? campusCentreNode()
    const r = router.route(from, target, profile)
    const src = map.getSource('route') as maplibregl.GeoJSONSource | undefined

    if (!r) {
      lastRoute = null
      badge.hidden = false
      badge.innerHTML = `${hudCorners}
        <div class="top"><span>No path found on the mapped network</span></div>
        <button class="x" data-clear aria-label="Clear route">&times;</button>`
      src?.setData({ type: 'FeatureCollection', features: [] })
      return
    }
    lastRoute = { seconds: r.seconds, metres: r.metres }

    src?.setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: r.coords } }],
    })

    const notes = [
      r.steps ? 'steps' : '',
      r.unpaved ? 'unpaved shortcut' : '',
      r.indoor ? 'indoor corridor' : '',
    ].filter(Boolean).join(' · ')

    const fromLabel = `from <button class="link" data-pick-origin>${origin ? 'your start' : 'campus centre'}</button>`

    badge.hidden = false
    badge.innerHTML = `${hudCorners}
      <div class="top">
        <span class="eta">${humanEta(r.seconds)}</span>
        <span>${humanDistance(r.metres)}</span>
        <span class="mode">
          <button data-mode="foot" class="${profile === 'foot' ? 'on' : ''}">walk</button>
          <button data-mode="bike" class="${profile === 'bike' ? 'on' : ''}">cycle</button>
        </span>
      </div>
      <span class="via">${fromLabel} · to ${escapeHtml(target.label)}${notes ? ` · ${notes}` : ''}</span>
      <button class="x" data-clear aria-label="Clear route">&times;</button>`

    map.fitBounds(bounds(r.coords), { padding: { top: 80, bottom: 110, left: 60, right: 380 }, maxZoom: 17.5 })
  }

  badge.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    if (t.dataset.clear !== undefined) { clearRoute(); return }
    if (t.dataset.mode) { profile = t.dataset.mode as Profile; drawRoute() }
    if (t.dataset.pickOrigin !== undefined && target) startPicking('origin', originPrompt(target.label))
  })

  function campusCentreNode() {
    return { lat: campus.meta.center[1], lon: campus.meta.center[0], label: 'campus centre' }
  }

  function routeTo(lat: number, lon: number, label: string) {
    target = { lat, lon, label }
    drawRoute()
    if (!origin) startPicking('origin', originPrompt(label))
  }

  /* ── map picking ──────────────────────────────────────────────────────── */

  const REPO = 'https://github.com/rugbedbugg/vit-map'
  type PickMode = 'report' | 'origin'
  let pickMode: PickMode | null = null

  const pickBar = document.createElement('div')
  pickBar.id = 'pick-bar'
  pickBar.hidden = true
  document.body.append(pickBar)

  function originPrompt(destLabel: string) {
    return `From <span class="pick-cursor" aria-hidden="true"></span> to <b>${escapeHtml(destLabel)}</b>`
  }

  function startPicking(mode: PickMode, prompt: string) {
    pickMode = mode
    map.getCanvas().style.cursor = 'crosshair'
    dossier.hidden = true
    pickBar.hidden = false
    pickBar.innerHTML = `${hudCorners}
      <span class="blink-dot" aria-hidden="true"></span>
      <span>${prompt}</span>
      <button class="x" data-cancel>abort</button>`
  }

  function stopPicking() {
    pickMode = null
    map.getCanvas().style.cursor = ''
    pickBar.hidden = true
  }

  pickBar.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).dataset.cancel !== undefined) stopPicking()
  })

  function setOriginAt(lat: number, lon: number) {
    stopPicking()
    origin = { lat, lon, label: 'your start' }
    showOrigin(map, lat, lon)
    drawRoute()
  }

  function reportAt(lat: number, lon: number) {
    stopPicking()
    const ll = `${lat.toFixed(7)}, ${lon.toFixed(7)}`
    const title = `Missing place at ${lat.toFixed(5)}, ${lon.toFixed(5)}`
    const body = [
      `**Coordinates:** ${ll}`,
      '',
      '**Name:** <!-- e.g. Hall 4, Lecture Hall 9, GH1 -->',
      '**What is it:** <!-- hostel / mess / canteen / lecture hall / water cooler / … -->',
      '',
      '---',
      'Even better: add it straight to OpenStreetMap and it lands here on the next',
      `build, plus every other map app: https://www.openstreetmap.org/edit#map=19/${lat.toFixed(5)}/${lon.toFixed(5)}`,
      '',
      'Please only report a spot you have actually stood at or can point to on the',
      'satellite layer. Do not copy coordinates out of Google Maps. This dataset is',
      'ODbL and Google-derived data cannot be redistributed or pushed upstream.',
    ].join('\n')
    window.open(
      `${REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`,
      '_blank', 'noopener',
    )
  }

  // Desktop: right-click. Phones have no right-click and iOS Safari does not
  // reliably fire contextmenu on a canvas, so long-press is wired by hand.
  map.on('contextmenu', (e) => { reportAt(e.lngLat.lat, e.lngLat.lng) })

  let holdTimer: ReturnType<typeof setTimeout> | undefined
  let holdFrom: { x: number; y: number } | null = null
  const cancelHold = () => { clearTimeout(holdTimer); holdFrom = null }

  map.on('touchstart', (e) => {
    // One finger only: two is a pinch, and panning must not trigger it.
    if (e.points.length !== 1) { cancelHold(); return }
    holdFrom = { x: e.point.x, y: e.point.y }
    const { lat, lng } = e.lngLat
    holdTimer = setTimeout(() => {
      if (!holdFrom) return
      cancelHold()
      if (navigator.vibrate) navigator.vibrate(12)
      reportAt(lat, lng)
    }, 550)
  })
  map.on('touchmove', (e) => {
    if (!holdFrom) return
    // A few pixels of drift is a held finger; more than that is a pan.
    if (Math.hypot(e.point.x - holdFrom.x, e.point.y - holdFrom.y) > 10) cancelHold()
  })
  map.on('touchend', cancelHold)
  map.on('touchcancel', cancelHold)
  map.on('movestart', cancelHold)

  /* ── selection ────────────────────────────────────────────────────────── */

  /** Nudge the map so the focused point is not hidden by the panel or sheet. */
  function panelOffset(): [number, number] {
    return window.matchMedia('(max-width: 760px)').matches ? [0, -110] : [-140, 0]
  }

  function focusPoi(p: Poi, zoom = 17.4) {
    focusId = p.id
    refreshPois()
    map.easeTo({
      center: [p.lon, p.lat],
      zoom: Math.max(map.getZoom(), zoom),
      duration: 520,
      offset: panelOffset(),
    })
    showPoi(p)
    showPing(map, p.lat, p.lon)
    pushRecent(p.id)
    paintRecents()
    dossier.hidden = true
  }

  function clearFocus() {
    focusId = null
    refreshPois()
    hidePing()
  }

  map.on('click', (e) => {
    if (!pickMode) return
    e.preventDefault()
    if (pickMode === 'origin') setOriginAt(e.lngLat.lat, e.lngLat.lng)
    else reportAt(e.lngLat.lat, e.lngLat.lng)
  })

  // Lamps are drawn as a glow instead of a dot, so they need their own hit
  // targets. `lamp-hit` is a transparent circle sized for a fingertip.
  const CLICKABLE = ['poi-dot', 'lamp-hit', 'poi-label', 'poi-label-minor', 'poi-label-generic']

  for (const layer of CLICKABLE) {
    map.on('click', layer, (e) => {
      if (pickMode) return
      const id = e.features?.[0]?.properties?.id as string | undefined
      const p = id ? byId.get(id) : undefined
      if (p) focusPoi(p)
    })
    map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer' })
    map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = '' })
  }

  /* ── hover dossier ────────────────────────────────────────────────────── */

  // Touch devices fire synthetic hover events on tap, which would leave a
  // dossier stuck open with no pointer around to dismiss it.
  const canHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches

  const dossier = document.createElement('div')
  dossier.id = 'hover-dossier'
  dossier.hidden = true
  document.body.append(dossier)

  function positionDossier(x: number, y: number) {
    const pad = 16, w = 220, h = 90
    const left = x + w + pad > window.innerWidth ? x - w - pad : x + pad
    const top = y + h + pad > window.innerHeight ? y - h - pad : y + pad
    dossier.style.left = `${left}px`
    dossier.style.top = `${top}px`
  }

  function paintDossier(p: Poi, x: number, y: number) {
    const cat = campus.categories[p.cat]
    const st = openNow(p.hours)
    const status = st?.open ? `<span class="d-status open">open${st.until ? ` · ${st.until}` : ''}</span>`
      : st && !st.open ? '<span class="d-status shut">closed</span>' : ''
    const near = nearestAmenities(campus, p, 1)[0]
    const nearLine = near ? `<span class="d-near">→ ${escapeHtml(near.poi.name)} · ${humanDistance(near.metres)}</span>` : ''
    dossier.innerHTML = `${hudCorners}
      <span class="d-top">
        <span class="blink-dot" aria-hidden="true"></span>
        <span class="d-cat" style="color:${catColour(p.cat)}">${escapeHtml(cat?.label ?? '')}</span>
      </span>
      <span class="d-name">${escapeHtml(p.name)}</span>
      ${status}
      ${nearLine}`
    dossier.hidden = false
    positionDossier(x, y)
  }

  if (canHover) {
    for (const layer of CLICKABLE) {
      map.on('mousemove', layer, (e) => {
        if (pickMode) return
        const id = e.features?.[0]?.properties?.id as string | undefined
        const p = id ? byId.get(id) : undefined
        if (p) paintDossier(p, e.originalEvent.clientX, e.originalEvent.clientY)
      })
      map.on('mouseleave', layer, () => { dossier.hidden = true })
    }
  }

  /* ── search ───────────────────────────────────────────────────────────── */

  const index = new SearchIndex(campus, {
    onLayer: (cat) => {
      active.has(cat) && active.size === 1 ? active.clear() : active.add(cat)
      refreshPois()
    },
    onAction: (id) => {
      if (id === 'layers-all') { cats.forEach(([c]) => active.add(c)); refreshPois() }
      if (id === 'layers-none') { active.clear(); refreshPois() }
      if (id === 'clear-route') clearRoute()
      if (id === 'about') showAbout(campus)
      if (id === 'report') startPicking('report', 'Tap the map where the place is')
    },
  })

  function openHit(hit: Hit) {
    if (hit.run) { hit.run(); return }
    if (hit.kind === 'place' && hit.poi) { focusPoi(hit.poi); return }
  }

  initPanel({
    campus,
    routeTo,
    routeState: () => ({
      active: !!target,
      eta: lastRoute?.seconds,
      metres: lastRoute?.metres,
    }),
    close: clearFocus,
    report: () => startPicking('report', 'Tap the map where the place is'),
    onRecentsChange: () => paintRecents(),
  })

  initPalette({
    index,
    campus,
    open: openHit,
    routeTo: (hit) => { if (hit.lat != null) routeTo(hit.lat, hit.lon!, hit.title) },
  })

  /* ── chrome ───────────────────────────────────────────────────────────── */

  document.getElementById('brand-btn')!.addEventListener('click', () => showAbout(campus))
  document.getElementById('brand-btn')!.title = `${campus.pois.length} places, click for sources`

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !document.getElementById('palette')!.hidden) return
    if (rail.classList.contains('open')) { closeLayers(); return }
    hidePanel(); clearFocus()
  })

  // A style or asset failure otherwise leaves the boot overlay up forever, which
  // reads as "the site never loads" with nothing on screen to explain it.
  const bootTimer = setTimeout(() => {
    if (boot.classList.contains('gone')) return
    boot.className = 'err'
    boot.textContent = 'The map did not finish loading. Check the browser console, and please open an issue on the repo.'
  }, 12_000)

  map.on('error', (e) => {
    // Missing glyphs and the odd tile error are survivable; a style error is not.
    console.error('[map]', e.error?.message ?? e)
  })

  map.on('load', () => {
    clearTimeout(bootTimer)
    refreshPois()
    boot.classList.add('gone')
    // Deep link: ?q=… opens the palette pre-filled, ?id=… focuses a place.
    const params = new URLSearchParams(location.search)
    const id = params.get('id')
    const q = params.get('q')
    if (id && byId.has(id)) focusPoi(byId.get(id)!)
    else if (q) openPalette(q)
    else showOnboard()
  })
}

function bounds(coords: [number, number][]): [[number, number], [number, number]] {
  let w = 180, s = 90, e = -180, n = -90
  for (const [lon, lat] of coords) {
    w = Math.min(w, lon); e = Math.max(e, lon)
    s = Math.min(s, lat); n = Math.max(n, lat)
  }
  return [[w, s], [e, n]]
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

start().catch((err) => {
  console.error(err)
  boot.className = 'err'
  boot.textContent = `Could not load campus data: ${err.message}. Run \`npm run build:data\` and reload.`
})
