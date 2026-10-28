// Build a compact walking graph for an area from OpenStreetMap (Overpass).
// Usage: node scripts/build-graph.mjs <area-id> [--refresh]
// Raw Overpass output is cached in data/raw/<area>.json (gitignored);
// the compact result is written to public/data/<area>.json (committed).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const areaId = process.argv[2] ?? 'bgc'
const refresh = process.argv.includes('--refresh')
const areas = JSON.parse(readFileSync(new URL('../src/areas.json', import.meta.url)))
const area = areas[areaId]
if (!area) throw new Error(`Unknown area "${areaId}". Add it to src/areas.json first.`)

const rawPath = new URL(`../data/raw/${areaId}.json`, import.meta.url).pathname
const outPath = new URL(`../public${area.graph}`, import.meta.url).pathname
const ENDPOINTS = ['https://overpass.kumi.systems/api/interpreter', 'https://overpass-api.de/api/interpreter']

async function fetchRaw() {
  const [w, s, e, n] = area.bbox
  const q = `[out:json][timeout:90];(way["highway"](${s},${w},${n},${e}););out geom;`
  for (let attempt = 0; attempt < 6; attempt++) {
    for (const url of ENDPOINTS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          signal: AbortSignal.timeout(100000),
          headers: {
            'User-Agent': 'fifteen-for-whom/0.1 (github.com/0xjitsu/fifteen-for-whom)',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: 'data=' + encodeURIComponent(q),
        })
        if (res.ok) return await res.text()
      } catch {
        /* try next endpoint */
      }
    }
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt))
  }
  throw new Error('Overpass unavailable')
}

if (refresh || !existsSync(rawPath)) {
  mkdirSync(dirname(rawPath), { recursive: true })
  writeFileSync(rawPath, await fetchRaw())
}
const raw = JSON.parse(readFileSync(rawPath, 'utf8'))

const EXCLUDED = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'busway', 'bridleway',
  'rest_area', 'services', 'cycleway', 'raceway', 'proposed', 'construction',
])
const FOOT_TYPES = new Set(['footway', 'steps', 'pedestrian', 'path', 'corridor'])
// edge flag bits (keep in sync with src/engine.ts)
const F_STEPS = 1
const F_BRIDGE = 2
const F_COVERED = 4
const F_UNSIGNED_GRADE = 8
const F_MAJOR = 16

function walkable(t) {
  if (EXCLUDED.has(t.highway)) return false
  if (t.foot === 'no') return false
  const footOk = ['yes', 'designated', 'permissive'].includes(t.foot)
  if (!footOk && ['no', 'private', 'permit', 'customers', 'golf_cart'].includes(t.access)) return false
  if (t.foot === 'use_sidepath' && !FOOT_TYPES.has(t.highway)) return false
  return true
}

function parseGrade(t) {
  const inc = t.incline
  if (!inc) return null
  if (inc === 'up') return { g: 0.06, assumed: true }
  if (inc === 'down') return { g: -0.06, assumed: true }
  const m = /^(-?\d+(?:\.\d+)?)\s*(%|°)?$/.exec(inc)
  if (!m) return null
  const v = parseFloat(m[1])
  return { g: m[2] === '°' ? Math.tan((v * Math.PI) / 180) : v / 100, assumed: false }
}

const ways = raw.elements.filter((w) => w.type === 'way' && w.tags && walkable(w.tags) && w.nodes?.length >= 2)

// nodes shared by more than one way, plus way endpoints, become graph vertices
const use = new Map()
for (const w of ways) for (const id of w.nodes) use.set(id, (use.get(id) ?? 0) + 1)
const isVertex = (w, i) => i === 0 || i === w.nodes.length - 1 || use.get(w.nodes[i]) > 1

const R = 6371008.8
const rad = Math.PI / 180
function dist(a, b) {
  const dLat = (b.lat - a.lat) * rad
  const dLon = (b.lon - a.lon) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}
const r5 = (x) => Math.round(x * 1e5) / 1e5

const vIndex = new Map()
const nodes = []
const edges = []
function vertex(id, p) {
  if (!vIndex.has(id)) {
    vIndex.set(id, nodes.length / 2)
    nodes.push(r5(p.lon), r5(p.lat))
  }
  return vIndex.get(id)
}

for (const w of ways) {
  const t = w.tags
  let flags = 0
  const bridge = t.bridge && t.bridge !== 'no'
  const footType = FOOT_TYPES.has(t.highway)
  if (t.highway === 'steps' && !t.conveying) flags |= F_STEPS
  if (bridge && t.bridge !== 'viaduct' && t.bridge !== 'cantilever' && footType) flags |= F_BRIDGE
  else if (footType && Number(t.layer) >= 1 && t.highway !== 'steps') flags |= F_BRIDGE
  if (
    t.covered === 'yes' || t.indoor === 'yes' || t.highway === 'corridor' ||
    t.tunnel === 'building_passage' || (t.tunnel === 'yes' && footType)
  ) flags |= F_COVERED
  if (['primary', 'secondary', 'primary_link', 'secondary_link'].includes(t.highway)) flags |= F_MAJOR
  const grade = parseGrade(t)
  let g = 0
  if (grade) {
    g = grade.g
    if (grade.assumed) flags |= F_UNSIGNED_GRADE
  } else if (!(flags & F_STEPS) && ((t.bridge && t.bridge !== 'no') || (t.tunnel && t.tunnel !== 'no' && t.tunnel !== 'building_passage') || Number(t.layer) !== 0 && t.layer !== undefined)) {
    // PLACEHOLDER (no DEM): grade-separated crossings must climb or descend, so assume a 5% ramp,
    // direction unknown (penalised both ways). BGC itself is almost flat.
    g = 0.05
    flags |= F_UNSIGNED_GRADE
  }

  let startI = 0
  for (let i = 1; i < w.nodes.length; i++) {
    if (!isVertex(w, i)) continue
    const pts = w.geometry.slice(startI, i + 1)
    let len = 0
    for (let k = 1; k < pts.length; k++) len += dist(pts[k - 1], pts[k])
    const u = vertex(w.nodes[startI], pts[0])
    const v = vertex(w.nodes[i], pts[pts.length - 1])
    if (u !== v && len > 0) {
      const mid = []
      for (let k = 1; k < pts.length - 1; k++) mid.push(r5(pts[k].lon), r5(pts[k].lat))
      edges.push([u, v, Math.round(len * 10) / 10, flags, Math.round(g * 1000) / 1000, mid])
    }
    startI = i
  }
}

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(
  outPath,
  JSON.stringify({
    area: areaId,
    source: 'OpenStreetMap contributors (ODbL)',
    timestamp: raw.osm3s?.timestamp_osm_base ?? null,
    nodes,
    edges,
  }),
)
console.log(`${areaId}: ${nodes.length / 2} nodes, ${edges.length} edges -> ${outPath}`)
