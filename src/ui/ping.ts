import maplibregl from 'maplibre-gl'

/** Radar ping at the focused search result, with a coordinate readout. */
let marker: maplibregl.Marker | null = null

function buildEl(lat: number, lon: number): HTMLElement {
  const el = document.createElement('div')
  el.className = 'ping-marker'
  el.innerHTML = `
    <span class="ping-ring" aria-hidden="true"></span>
    <span class="ping-ring" aria-hidden="true"></span>
    <span class="ping-ring" aria-hidden="true"></span>
    <span class="ping-dot" aria-hidden="true"></span>
    <span class="ping-coords">${lat.toFixed(6)}, ${lon.toFixed(6)}</span>`
  return el
}

export function showPing(map: maplibregl.Map, lat: number, lon: number) {
  hidePing()
  marker = new maplibregl.Marker({ element: buildEl(lat, lon), anchor: 'center' })
    .setLngLat([lon, lat])
    .addTo(map)
}

export function hidePing() {
  marker?.remove()
  marker = null
}

/** Plain marker for a manually-picked route start point. */
let originMarker: maplibregl.Marker | null = null

export function showOrigin(map: maplibregl.Map, lat: number, lon: number) {
  hideOrigin()
  const el = document.createElement('div')
  el.className = 'origin-marker'
  el.innerHTML = '<span class="origin-dot" aria-hidden="true"></span>'
  originMarker = new maplibregl.Marker({ element: el, anchor: 'center' })
    .setLngLat([lon, lat])
    .addTo(map)
}

export function hideOrigin() {
  originMarker?.remove()
  originMarker = null
}
