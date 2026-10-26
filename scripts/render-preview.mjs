// Renders public/og/preview.mp4 (H.264) and public/og/preview.png from the committed BGC graph,
// using the same engine as the app. Run manually: npm run preview-video  (needs ffmpeg).
// Frames are drawn with @napi-rs/canvas, so no browser is needed.
import { readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { createCanvas, GlobalFonts } from '@napi-rs/canvas'

const root = fileURLToPath(new URL('..', import.meta.url))
const tmp = `${root}data/render`
rmSync(tmp, { recursive: true, force: true })
mkdirSync(`${tmp}/frames`, { recursive: true })

await build({ entryPoints: [`${root}src/engine.ts`], bundle: true, format: 'esm', outfile: `${tmp}/engine.mjs`, logLevel: 'error' })
const E = await import(`${tmp}/engine.mjs`)

const areas = JSON.parse(readFileSync(`${root}src/areas.json`, 'utf8'))
const area = areas.bgc
const g = E.buildGraph(JSON.parse(readFileSync(`${root}public${area.graph}`, 'utf8')))
const { node } = E.snap(g, area.start[0], area.start[1])

const W = 1200
const H = 630
const FPS = 24
const SECONDS = 7
const ORIGIN_PX = [780, 330]
const PX_PER_M = 0.33
const kx = 111320 * Math.cos((g.lat[node] * Math.PI) / 180)
const ky = 110574
const px = (lon) => ORIGIN_PX[0] + (lon - g.lon[node]) * kx * PX_PER_M
const py = (lat) => ORIGIN_PX[1] - (lat - g.lat[node]) * ky * PX_PER_M

const family = GlobalFonts.families.some((f) => f.family === 'DejaVu Sans') ? 'DejaVu Sans' : 'sans-serif'

// per-persona arrival times (no conditions)
const runs = E.PERSONAS.map((p) => {
  const costs = E.edgeCosts(g, p, E.NO_CONDITIONS)
  return { p, costs, time: E.dijkstra(g, costs, p, node, 15 * 60) }
})
const baseline = E.adultBaseline(g, node)
const final = runs.map((r) => Math.round((100 * E.reach(g, r.time, r.costs, [15]).metres[0]) / baseline))

// static street layer
const street = createCanvas(W, H)
{
  const c = street.getContext('2d')
  c.fillStyle = '#0f1b26'
  c.fillRect(0, 0, W, H)
  c.strokeStyle = '#27394a'
  c.lineWidth = 1
  c.beginPath()
  for (const pts of g.geom) {
    c.moveTo(px(pts[0]), py(pts[1]))
    for (let i = 2; i < pts.length; i += 2) c.lineTo(px(pts[i]), py(pts[i + 1]))
  }
  c.stroke()
}

function frame(i) {
  const cv = createCanvas(W, H)
  const c = cv.getContext('2d')
  c.drawImage(street, 0, 0)
  const total = FPS * SECONDS
  const grow0 = Math.round(0.5 * FPS)
  const grow1 = Math.round(5.7 * FPS)
  const k = Math.min(1, Math.max(0, (i - grow0) / (grow1 - grow0)))
  const minutes = i >= total - 1 ? 15 : 15 * k

  if (minutes > 0.05) {
    c.lineCap = 'round'
    c.lineJoin = 'round'
    // widest reach first, thicker line: the smaller reaches read as nested cores
    const order = runs.map((_, i) => i).sort((a, b) => final[b] - final[a])
    order.forEach((idx, rank) => {
      const r = runs[idx]
      const off = 0
      const lines = E.reach(g, r.time, r.costs, [minutes]).lines[0]
      c.strokeStyle = r.p.color
      c.lineWidth = 7 - rank * 1.6
      c.globalAlpha = 0.95
      c.beginPath()
      for (const pts of lines) {
        c.moveTo(px(pts[0]) + off, py(pts[1]) + off)
        for (let j = 2; j < pts.length; j += 2) c.lineTo(px(pts[j]) + off, py(pts[j + 1]) + off)
      }
      c.stroke()
    })
    c.globalAlpha = 1
  }
  // origin
  c.fillStyle = '#fff'
  c.beginPath()
  c.arc(ORIGIN_PX[0], ORIGIN_PX[1], 7, 0, Math.PI * 2)
  c.fill()

  // text panel
  const grad = c.createLinearGradient(0, 0, 520, 0)
  grad.addColorStop(0, 'rgba(15,27,38,0.97)')
  grad.addColorStop(0.8, 'rgba(15,27,38,0.9)')
  grad.addColorStop(1, 'rgba(15,27,38,0)')
  c.fillStyle = grad
  c.fillRect(0, 0, 520, H)
  c.fillStyle = '#fff'
  c.font = `bold 54px "${family}"`
  c.fillText('15 minutes,', 48, 120)
  c.fillText('but for whom?', 48, 184)
  c.font = `22px "${family}"`
  c.fillStyle = '#b8c7d4'
  c.fillText('Walking reach from one point in BGC,', 48, 232)
  c.fillText('by who is walking.', 48, 262)
  E.PERSONAS.forEach((p, idx) => {
    const y = 330 + idx * 48
    c.fillStyle = p.color
    c.beginPath()
    c.arc(60, y - 8, 10, 0, Math.PI * 2)
    c.fill()
    c.fillStyle = '#fff'
    c.font = `26px "${family}"`
    c.fillText(p.name, 84, y)
    if (minutes >= 14.99) {
      c.fillStyle = '#b8c7d4'
      c.textAlign = 'right'
      c.fillText(`${final[idx]}%`, 440, y)
      c.textAlign = 'left'
    }
  })
  c.fillStyle = '#fff'
  c.font = `bold 46px "${family}"`
  c.fillText(`${Math.round(minutes)} min`, 48, 575)
  c.font = `16px "${family}"`
  c.fillStyle = '#7f94a6'
  c.fillText('© OpenStreetMap contributors · fifteen-for-whom.vercel.app', 640, 612)
  return cv
}

const total = FPS * SECONDS
for (let i = 0; i < total; i++) {
  writeFileSync(`${tmp}/frames/${String(i).padStart(4, '0')}.png`, frame(i).toBuffer('image/png'))
}
writeFileSync(`${root}public/og/preview.png`, frame(total - 1).toBuffer('image/png'))

execFileSync(
  'ffmpeg',
  [
    '-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', `${tmp}/frames/%04d.png`,
    '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-crf', '28', '-preset', 'slow',
    '-movflags', '+faststart', `${root}public/og/preview.mp4`,
  ],
  { stdio: 'inherit' },
)
rmSync(tmp, { recursive: true, force: true })
console.log('final % of fit-adult reach (child, pregnant, elderly, newcomer):', final.join(', '))
