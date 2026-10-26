import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import './style.css'
import areas from './areas.json'
import {
  BAND_MINUTES,
  PERSONAS,
  adultBaseline,
  buildGraph,
  isochrones,
  snap,
  type Conditions,
  type Graph,
  type RawGraph,
} from './engine'

interface Area {
  name: string
  center: [number, number]
  zoom: number
  bbox: [number, number, number, number]
  graph: string
  start: [number, number]
}

const areaId = new URLSearchParams(location.search).get('area') ?? 'bgc'
const area = (areas as unknown as Record<string, Area>)[areaId] ?? (areas as unknown as Record<string, Area>).bgc
const MAX_SNAP_M = 250
const OPACITY = [0.95, 0.55, 0.3] // 5, 10, 15 min

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
$('area-name').textContent = area.name

const visible = new Set(PERSONAS.map((p) => p.id))
const cond = (): Conditions => ({
  heat: $<HTMLInputElement>('c-heat').checked,
  rain: $<HTMLInputElement>('c-rain').checked,
  rainAvoidUncovered: $<HTMLInputElement>('c-avoid').checked,
  slopes: $<HTMLInputElement>('c-slopes').checked,
  brokenLifts: $<HTMLInputElement>('c-lifts').checked,
})

// legend
const legend = $('legend')
for (const p of PERSONAS) {
  const li = document.createElement('li')
  li.innerHTML = `<label><input type="checkbox" checked data-p="${p.id}" /><span class="swatch" style="background:${p.color}"></span>${p.name}</label><span class="km" id="km-${p.id}"></span>`
  legend.appendChild(li)
}

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/positron',
  center: area.center,
  zoom: area.zoom,
  maxBounds: [
    [area.bbox[0] - 0.05, area.bbox[1] - 0.05],
    [area.bbox[2] + 0.05, area.bbox[3] + 0.05],
  ],
  attributionControl: { compact: true, customAttribution: '© OpenStreetMap contributors' },
})
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')

let graph: Graph | null = null
let origin: [number, number] = area.start
let marker: maplibregl.Marker | null = null
const emptyFC = { type: 'FeatureCollection' as const, features: [] }

function setupLayers() {
  PERSONAS.forEach((p, pi) => {
    map.addSource(`reach-${p.id}`, { type: 'geojson', data: emptyFC })
    const offset = (pi - (PERSONAS.length - 1) / 2) * 2.6
    // draw 15 min first so shorter bands sit on top
    ;[2, 1, 0].forEach((bi) => {
      map.addLayer({
        id: `reach-${p.id}-${BAND_MINUTES[bi]}`,
        type: 'line',
        source: `reach-${p.id}`,
        filter: ['==', ['get', 'band'], BAND_MINUTES[bi]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': p.color, 'line-width': 2.6, 'line-offset': offset, 'line-opacity': OPACITY[bi] },
      })
    })
  })
}

function render() {
  if (!graph) return
  const { node, metres } = snap(graph, origin[0], origin[1])
  const explain = $('explain')
  if (metres > MAX_SNAP_M) {
    explain.textContent = 'No walkable street near that point. Try a spot closer to a street or path.'
    return
  }
  const c = cond()
  const results = isochrones(graph, node, PERSONAS, c)
  const base = adultBaseline(graph, node)
  const last = BAND_MINUTES.length - 1
  const parts: string[] = []
  for (const r of results) {
    const src = map.getSource(`reach-${r.persona.id}`) as maplibregl.GeoJSONSource | undefined
    src?.setData({
      type: 'FeatureCollection',
      features: BAND_MINUTES.map((band, bi) => ({
        type: 'Feature',
        properties: { band },
        geometry: { type: 'MultiLineString', coordinates: r.reach.lines[bi].map(pairs) },
      })),
    })
    const m = r.reach.metres[last]
    const pct = base > 0 ? Math.round((100 * m) / base) : 0
    $(`km-${r.persona.id}`).textContent = `${pct}%`
    parts.push(`${r.persona.name.toLowerCase()} ${pct}%`)
  }
  const on = Object.entries(c).filter(([k, v]) => v && k !== 'rainAvoidUncovered').length
  explain.textContent =
    `In 15 minutes from here, compared with a fit adult on a dry, flat day (100% of the streets): ${parts.join(', ')}.` +
    (on ? '' : ' Turn on conditions to see who is hit hardest.')
  marker?.setLngLat([graph.lon[node], graph.lat[node]])
}

function pairs(flat: number[]): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i < flat.length; i += 2) out.push([flat[i], flat[i + 1]])
  return out
}

map.on('load', async () => {
  setupLayers()
  marker = new maplibregl.Marker({ color: '#14202b' }).setLngLat(origin).addTo(map)
  const res = await fetch(area.graph)
  graph = buildGraph((await res.json()) as RawGraph)
  render()
})

map.on('click', (e: maplibregl.MapMouseEvent) => {
  origin = [e.lngLat.lng, e.lngLat.lat]
  $('hint').style.display = 'none'
  render()
})

for (const id of ['c-heat', 'c-rain', 'c-avoid', 'c-slopes', 'c-lifts']) $(id).addEventListener('change', render)
$('c-avoid').addEventListener('change', () => {
  if ($<HTMLInputElement>('c-avoid').checked) $<HTMLInputElement>('c-rain').checked = true
  render()
})
legend.addEventListener('change', (ev) => {
  const t = ev.target as HTMLInputElement
  const id = t.dataset.p
  if (!id) return
  if (t.checked) visible.add(id)
  else visible.delete(id)
  for (const band of BAND_MINUTES) {
    map.setLayoutProperty(`reach-${id}-${band}`, 'visibility', t.checked ? 'visible' : 'none')
  }
})
