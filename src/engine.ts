// Pure walking-isochrone engine: no DOM, no map library. Used by the browser app
// and by scripts/render-preview.mjs (bundled with esbuild).

// edge flag bits (keep in sync with scripts/build-graph.mjs)
export const F_STEPS = 1
export const F_BRIDGE = 2
export const F_COVERED = 4
export const F_UNSIGNED_GRADE = 8
export const F_MAJOR = 16

export interface RawGraph {
  area: string
  source: string
  timestamp: string | null
  nodes: number[] // lon, lat pairs
  edges: [number, number, number, number, number, number[]][] // u, v, metres, flags, grade, interior lon/lat pairs
}

export interface Graph {
  n: number
  lon: Float64Array
  lat: Float64Array
  eu: Int32Array
  ev: Int32Array
  len: Float64Array
  flags: Int32Array
  grade: Float64Array
  /** polyline per edge, flat lon/lat from u to v */
  geom: Float64Array[]
  /** adjacency: for node i, edge ids at adjStart[i]..adjStart[i+1] */
  adjStart: Int32Array
  adjEdge: Int32Array
  degree: Int32Array
  /** true for vertices in the largest connected component (valid click targets) */
  main: Uint8Array
}

export interface Conditions {
  heat: boolean
  rain: boolean
  /** with rain: strongly prefer covered segments */
  rainAvoidUncovered: boolean
  slopes: boolean
  /** lifts at footbridges / stations are out of order: steps and footbridges are blocked for those who need lifts */
  brokenLifts: boolean
}

export const NO_CONDITIONS: Conditions = {
  heat: false,
  rain: false,
  rainAvoidUncovered: false,
  slopes: false,
  brokenLifts: false,
}

export interface Persona {
  id: string
  name: string
  color: string
  /** free-flow walking speed on flat ground, m/s */
  speed: number
  /** 1 = average sensitivity to heat */
  heatSens: number
  /** multiplies the grade fed into the Tobler function */
  slopeSens: number
  /** blocked by steps / footbridges when lifts are broken (strollers, mobility, pregnancy) */
  needsLift: boolean
  /** multiplies speed (newcomer: hesitation, checking the map) */
  wayfindingFactor: number
  /** seconds lost at every junction with 3+ ways (newcomer deciding where to go) */
  junctionPenalty: number
}

// ASSUMPTION: every speed, sensitivity and penalty below is an assumption chosen by the
// author, not a measured or cited value. They are rough averages for illustration; real
// people vary a lot. No source is claimed. Change them in one place, here.
export const PERSONAS: Persona[] = [
  { id: 'child', name: 'Child', color: '#f2a93b', speed: 1.0, heatSens: 1.2, slopeSens: 1.0, needsLift: true, wayfindingFactor: 1, junctionPenalty: 0 },
  { id: 'pregnant', name: 'Pregnant woman', color: '#e0457b', speed: 1.1, heatSens: 1.4, slopeSens: 1.3, needsLift: true, wayfindingFactor: 1, junctionPenalty: 0 },
  { id: 'elderly', name: 'Elderly person', color: '#7b61ff', speed: 0.9, heatSens: 1.5, slopeSens: 1.5, needsLift: true, wayfindingFactor: 1, junctionPenalty: 0 },
  { id: 'newcomer', name: 'Newcomer', color: '#14a3a8', speed: 1.33, heatSens: 1.0, slopeSens: 1.0, needsLift: false, wayfindingFactor: 0.85, junctionPenalty: 8 },
]

/** Reference: fit adult, no conditions. Not drawn, only used for comparison. */
export const FIT_ADULT: Persona = {
  id: 'adult', name: 'Fit adult', color: '#888', speed: 1.33, heatSens: 1, slopeSens: 1, needsLift: false, wayfindingFactor: 1, junctionPenalty: 0,
}

export const BAND_MINUTES = [5, 10, 15]

export function buildGraph(raw: RawGraph): Graph {
  const n = raw.nodes.length / 2
  const m = raw.edges.length
  const lon = new Float64Array(n)
  const lat = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    lon[i] = raw.nodes[2 * i]
    lat[i] = raw.nodes[2 * i + 1]
  }
  const eu = new Int32Array(m)
  const ev = new Int32Array(m)
  const len = new Float64Array(m)
  const flags = new Int32Array(m)
  const grade = new Float64Array(m)
  const geom: Float64Array[] = []
  const degree = new Int32Array(n)
  raw.edges.forEach(([u, v, l, f, g, mid], i) => {
    eu[i] = u
    ev[i] = v
    len[i] = l
    flags[i] = f
    grade[i] = g
    degree[u]++
    degree[v]++
    const pts = new Float64Array(4 + mid.length)
    pts[0] = lon[u]
    pts[1] = lat[u]
    pts.set(mid, 2)
    pts[pts.length - 2] = lon[v]
    pts[pts.length - 1] = lat[v]
    geom.push(pts)
  })
  const adjStart = new Int32Array(n + 1)
  for (let i = 0; i < n; i++) adjStart[i + 1] = adjStart[i] + degree[i]
  const adjEdge = new Int32Array(adjStart[n])
  const fill = adjStart.slice(0, n)
  for (let e = 0; e < m; e++) {
    adjEdge[fill[eu[e]]++] = e
    adjEdge[fill[ev[e]]++] = e
  }

  // largest connected component
  const comp = new Int32Array(n).fill(-1)
  const sizes: number[] = []
  const stack: number[] = []
  for (let s = 0; s < n; s++) {
    if (comp[s] >= 0) continue
    const id = sizes.length
    let size = 0
    comp[s] = id
    stack.push(s)
    while (stack.length) {
      const x = stack.pop() as number
      size++
      for (let k = adjStart[x]; k < adjStart[x + 1]; k++) {
        const e = adjEdge[k]
        const y = eu[e] === x ? ev[e] : eu[e]
        if (comp[y] < 0) {
          comp[y] = id
          stack.push(y)
        }
      }
    }
    sizes.push(size)
  }
  let best = 0
  sizes.forEach((s, i) => {
    if (s > sizes[best]) best = i
  })
  const main = new Uint8Array(n)
  for (let i = 0; i < n; i++) main[i] = comp[i] === best ? 1 : 0

  return { n, lon, lat, eu, ev, len, flags, grade, geom, adjStart, adjEdge, degree, main }
}

/** Nearest vertex of the main network to a lon/lat, with its distance in metres. */
export function snap(g: Graph, lon: number, lat: number): { node: number; metres: number } {
  const kx = 111320 * Math.cos((lat * Math.PI) / 180)
  const ky = 110574
  let best = -1
  let bd = Infinity
  for (let i = 0; i < g.n; i++) {
    if (!g.main[i]) continue
    const dx = (g.lon[i] - lon) * kx
    const dy = (g.lat[i] - lat) * ky
    const d = dx * dx + dy * dy
    if (d < bd) {
      bd = d
      best = i
    }
  }
  return { node: best, metres: Math.sqrt(bd) }
}

/** Tobler's hiking function (Tobler 1993, hiking speeds; applied here to urban walking as an ASSUMPTION), relative to flat ground (1 = flat speed). */
export function toblerFactor(grade: number): number {
  const flat = Math.exp(-3.5 * 0.05)
  return Math.min(1, Math.exp(-3.5 * Math.abs(grade + 0.05)) / flat)
}

export interface EdgeCosts {
  fwd: Float64Array // seconds u -> v (Infinity = blocked)
  bwd: Float64Array // seconds v -> u
}

export function edgeCosts(g: Graph, p: Persona, c: Conditions): EdgeCosts {
  const m = g.len.length
  const fwd = new Float64Array(m)
  const bwd = new Float64Array(m)
  for (let e = 0; e < m; e++) {
    const f = g.flags[e]
    const steps = (f & F_STEPS) !== 0
    const bridge = (f & F_BRIDGE) !== 0
    const covered = (f & F_COVERED) !== 0
    if (c.brokenLifts && p.needsLift && (steps || bridge)) {
      fwd[e] = bwd[e] = Infinity
      continue
    }
    let mult = p.wayfindingFactor
    // ASSUMPTION (all factors in this function): not from a cited source.
    if (steps) mult *= 0.5 // climbing stairs is slow for everyone
    if (c.heat) mult *= 1 - (covered ? 0.06 : 0.18) * p.heatSens
    if (c.rain) {
      mult *= covered ? 1 : 0.85
      if (c.rainAvoidUncovered && !covered) mult *= 0.55 // detour cost for staying dry
    }
    const base = g.len[e] / (p.speed * mult)
    let tf = base
    let tb = base
    if (c.slopes && !steps) {
      const gr = g.grade[e] * p.slopeSens
      if (f & F_UNSIGNED_GRADE) {
        const w = 1 / Math.min(toblerFactor(gr), toblerFactor(-gr)) // uphill in one direction, unknown: use worse case
        tf *= w
        tb *= w
      } else {
        tf /= toblerFactor(gr)
        tb /= toblerFactor(-gr)
      }
    }
    fwd[e] = tf
    bwd[e] = tb
  }
  return { fwd, bwd }
}

class MinHeap {
  private keys: number[] = []
  private vals: number[] = []
  get size() {
    return this.keys.length
  }
  push(k: number, v: number) {
    const ks = this.keys
    const vs = this.vals
    let i = ks.length
    ks.push(k)
    vs.push(v)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (ks[p] <= k) break
      ks[i] = ks[p]
      vs[i] = vs[p]
      i = p
    }
    ks[i] = k
    vs[i] = v
  }
  pop(): [number, number] {
    const ks = this.keys
    const vs = this.vals
    const k0 = ks[0]
    const v0 = vs[0]
    const k = ks.pop() as number
    const v = vs.pop() as number
    const n = ks.length
    if (n > 0) {
      let i = 0
      for (;;) {
        let c = 2 * i + 1
        if (c >= n) break
        if (c + 1 < n && ks[c + 1] < ks[c]) c++
        if (ks[c] >= k) break
        ks[i] = ks[c]
        vs[i] = vs[c]
        i = c
      }
      ks[i] = k
      vs[i] = v
    }
    return [k0, v0]
  }
}

/** Dijkstra from `source`; returns arrival time in seconds per vertex (Infinity = unreached within maxSec). */
export function dijkstra(g: Graph, costs: EdgeCosts, p: Persona, source: number, maxSec: number): Float64Array {
  const time = new Float64Array(g.n).fill(Infinity)
  time[source] = 0
  const heap = new MinHeap()
  heap.push(0, source)
  while (heap.size) {
    const [t, x] = heap.pop()
    if (t > time[x]) continue
    for (let k = g.adjStart[x]; k < g.adjStart[x + 1]; k++) {
      const e = g.adjEdge[k]
      const forward = g.eu[e] === x
      const y = forward ? g.ev[e] : g.eu[e]
      let w = forward ? costs.fwd[e] : costs.bwd[e]
      if (w === Infinity) continue
      if (p.junctionPenalty && g.degree[y] >= 3) w += p.junctionPenalty
      const nt = t + w
      if (nt < time[y] && nt <= maxSec) {
        time[y] = nt
        heap.push(nt, y)
      }
    }
  }
  return time
}

export interface Reach {
  /** per band (same order as BAND_MINUTES): flat lon/lat polylines reachable within that many minutes */
  lines: number[][][]
  /** metres of street reachable within each band */
  metres: number[]
}

function segMetres(pts: ArrayLike<number>): number {
  let d = 0
  for (let i = 2; i < pts.length; i += 2) {
    const kx = 111320 * Math.cos((pts[i + 1] * Math.PI) / 180)
    d += Math.hypot((pts[i] - pts[i - 2]) * kx, (pts[i + 1] - pts[i - 1]) * 110574)
  }
  return d
}

/** Sub-polyline between fractions a..b (0..1) of the polyline's length. */
function slice(pts: Float64Array, a: number, b: number): number[] {
  if (a <= 0 && b >= 1) return Array.from(pts)
  const total = segMetres(pts)
  const lo = a * total
  const hi = b * total
  const out: number[] = []
  let acc = 0
  for (let i = 2; i < pts.length; i += 2) {
    const x0 = pts[i - 2], y0 = pts[i - 1], x1 = pts[i], y1 = pts[i + 1]
    const kx = 111320 * Math.cos((y0 * Math.PI) / 180)
    const l = Math.hypot((x1 - x0) * kx, (y1 - y0) * 110574)
    const s = acc
    const e = acc + l
    acc = e
    if (e <= lo || s >= hi || l === 0) continue
    const t0 = Math.max(0, (lo - s) / l)
    const t1 = Math.min(1, (hi - s) / l)
    if (out.length === 0) out.push(x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0)
    out.push(x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1)
  }
  return out
}

/** Street pieces reachable from the computed arrival times within each band. */
export function reach(g: Graph, time: Float64Array, costs: EdgeCosts, minutes: number[] = BAND_MINUTES): Reach {
  const lines: number[][][] = minutes.map(() => [])
  const metres = minutes.map(() => 0)
  minutes.forEach((min, bi) => {
    const T = min * 60
    for (let e = 0; e < g.len.length; e++) {
      const u = g.eu[e]
      const v = g.ev[e]
      const fu = time[u] < T && costs.fwd[e] < Infinity ? (T - time[u]) / costs.fwd[e] : 0
      const fv = time[v] < T && costs.bwd[e] < Infinity ? (T - time[v]) / costs.bwd[e] : 0
      if (fu <= 0 && fv <= 0) continue
      if (fu >= 1 || fv >= 1 || fu + fv >= 1) {
        lines[bi].push(Array.from(g.geom[e]))
        metres[bi] += g.len[e]
      } else {
        if (fu > 0) lines[bi].push(slice(g.geom[e], 0, fu))
        if (fv > 0) lines[bi].push(slice(g.geom[e], 1 - fv, 1))
        metres[bi] += (fu + fv) * g.len[e]
      }
    }
  })
  return { lines, metres }
}

export interface PersonaResult {
  persona: Persona
  time: Float64Array
  costs: EdgeCosts
  reach: Reach
}

export function isochrones(g: Graph, source: number, personas: Persona[], c: Conditions): PersonaResult[] {
  const maxSec = Math.max(...BAND_MINUTES) * 60
  return personas.map((persona) => {
    const costs = edgeCosts(g, persona, c)
    const time = dijkstra(g, costs, persona, source, maxSec)
    return { persona, time, costs, reach: reach(g, time, costs) }
  })
}

/** Metres of street a fit adult (no conditions) reaches in the longest band, for comparison. */
export function adultBaseline(g: Graph, source: number): number {
  const costs = edgeCosts(g, FIT_ADULT, NO_CONDITIONS)
  const time = dijkstra(g, costs, FIT_ADULT, source, Math.max(...BAND_MINUTES) * 60)
  const r = reach(g, time, costs, [BAND_MINUTES[BAND_MINUTES.length - 1]])
  return r.metres[0]
}
