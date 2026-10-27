// Post-build smoke test: run after `npm run build`.
import { readFileSync, statSync, existsSync } from 'node:fs'

const BASE = 'https://fifteen-for-whom.vercel.app'
const MAX_MP4 = 5 * 1024 * 1024
const errors = []
const fail = (m) => errors.push(m)

const htmlPath = 'dist/index.html'
if (!existsSync(htmlPath)) {
  console.error('smoke: dist/index.html missing (run npm run build first)')
  process.exit(1)
}
const html = readFileSync(htmlPath, 'utf8')

// meta tags: [attribute, name, expected value (string | RegExp)]
const tags = [
  ['property', 'og:title', /./],
  ['property', 'og:description', /./],
  ['property', 'og:image', `${BASE}/og/preview.png`],
  ['property', 'og:video', `${BASE}/og/preview.mp4`],
  ['property', 'og:video:secure_url', `${BASE}/og/preview.mp4`],
  ['property', 'og:video:type', 'video/mp4'],
  ['property', 'og:video:width', /^\d+$/],
  ['property', 'og:video:height', /^\d+$/],
  ['name', 'twitter:card', 'player'],
  ['name', 'twitter:player', `${BASE}/og/player.html`],
  ['name', 'twitter:player:width', /^\d+$/],
  ['name', 'twitter:player:height', /^\d+$/],
]
function meta(attr, name) {
  for (const m of html.matchAll(/<meta\s+[^>]*>/g)) {
    const tag = m[0]
    if (new RegExp(`${attr}="${name}"`).test(tag)) return /content="([^"]*)"/.exec(tag)?.[1]
  }
  return undefined
}
for (const [attr, name, expected] of tags) {
  const v = meta(attr, name)
  if (v === undefined) fail(`missing <meta ${attr}="${name}">`)
  else if (expected instanceof RegExp ? !expected.test(v) : v !== expected) fail(`<meta ${name}> is "${v}", expected ${expected}`)
}
for (const [, name] of tags) {
  const v = meta(name.startsWith('og:') ? 'property' : 'name', name)
  if (v && ['og:image', 'og:video', 'og:video:secure_url', 'twitter:player'].includes(name) && !v.startsWith('https://')) fail(`${name} must be an absolute https URL`)
}

// footer
if (!html.includes('OpenStreetMap contributors')) fail('footer: missing "© OpenStreetMap contributors"')
// the Donate link is hidden until DONATE_URL is set in src/config.ts, and no broken sponsors link may ship
if (html.includes('github.com/sponsors')) fail('footer: broken sponsors link shipped')
if (!/MIT/.test(html)) fail('footer: missing MIT licence mention')

// built assets
for (const f of ['dist/og/preview.png', 'dist/og/preview.mp4', 'dist/og/player.html', 'dist/data/bgc.json']) {
  if (!existsSync(f)) fail(`missing ${f}`)
}

// PNG is 1200x630
if (existsSync('dist/og/preview.png')) {
  const b = readFileSync('dist/og/preview.png')
  const isPng = b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
  const w = b.readUInt32BE(16)
  const h = b.readUInt32BE(20)
  if (!isPng || w !== 1200 || h !== 630) fail(`og/preview.png must be a 1200x630 PNG (got ${isPng ? `${w}x${h}` : 'not a PNG'})`)
}

// MP4: exists, < 5 MB, ISO base media file with an H.264 (avc1) track
if (existsSync('dist/og/preview.mp4')) {
  const size = statSync('dist/og/preview.mp4').size
  if (size >= MAX_MP4) fail(`og/preview.mp4 is ${size} bytes, must be under ${MAX_MP4}`)
  const b = readFileSync('dist/og/preview.mp4')
  if (b.subarray(4, 8).toString('latin1') !== 'ftyp') fail('og/preview.mp4 is not an MP4 (no ftyp box)')
  if (!b.includes(Buffer.from('avc1')) || !b.includes(Buffer.from('avcC'))) fail('og/preview.mp4 is not H.264 (no avc1/avcC)')
  const dims = b.indexOf(Buffer.from('avc1'))
  if (dims > 0) {
    // VisualSampleEntry: 6 reserved + 2 data_ref + 16 pre-defined/reserved, then width, height
    const w = b.readUInt16BE(dims + 4 + 24)
    const h = b.readUInt16BE(dims + 4 + 26)
    if (!((w === 1200 && h === 630) || (w * 9 === h * 16))) fail(`og/preview.mp4 is ${w}x${h}, expected 1200x630 or 16:9`)
  }
}

if (errors.length) {
  console.error('smoke FAILED:\n - ' + errors.join('\n - '))
  process.exit(1)
}
console.log('smoke OK: index.html tags, og assets, MP4 (H.264, <5 MB) and graph all present')
