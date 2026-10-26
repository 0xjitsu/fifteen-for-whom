# 15 minutes, but for whom?

A free, public-good civic map. The usual "15-minute city" map assumes a fit adult. This one shows how far a **child**, a **pregnant woman**, an **elderly person** and a **newcomer** can actually walk in 5, 10 and 15 minutes from a point you click, and how heat, rain, slopes and broken lifts change that.

First area: **BGC, Taguig (Metro Manila)**. Live at <https://fifteen-for-whom.vercel.app>.

Inspired by Francesco Procacci's map (Python workflow) shared by Milan Janosov.

## Run it

```bash
npm install
npm run dev       # local dev server
npm run lint      # tsc --noEmit + eslint
npm run build     # static site into dist/
npm run smoke     # checks dist/: link-preview tags, PNG, MP4 (H.264, < 5 MB), graph
scripts/check-live.sh https://fifteen-for-whom.vercel.app   # same checks against a deployment
```

No API keys, no paid services. Everything runs in the browser; the street graph is a committed static file (`public/data/bgc.json`, ~330 kB, ~90 kB gzipped).

## Method

1. **Graph.** `scripts/build-graph.mjs` downloads every `highway=*` way in the area's bounding box from the Overpass API, drops what pedestrians cannot use (motorways, trunk roads, busways, cycleways, `foot=no`, private/permit access) and splits ways at shared nodes into edges. Each edge stores its length, its geometry and flags: steps, footbridge, covered, major road, grade.
2. **Cost per edge** (`src/engine.ts`, `edgeCosts`): `time = length / (speed × multipliers)`, where the multipliers depend on the persona and the toggled conditions (below). Edges can be blocked.
3. **Isochrone.** Dijkstra from the street vertex nearest the click (within 250 m), on the client. A piece of street counts as reached in N minutes if the walker arrives at one end with time left; partial edges are cut at the exact distance. The map draws the reachable streets for 5, 10 and 15 minutes (opacity falls with time) and each persona gets its own colour and a small line offset so overlaps stay readable.
4. **Reading the numbers.** The sidebar shows each persona's 15-minute reach as a percentage of the street length a fit adult (1.33 m/s, dry, flat, nothing blocked) reaches from the same point.

### Personas (defaults, all in `PERSONAS` in `src/engine.ts`)

| Persona | Speed | Extra |
|---|---|---|
| Fit adult (reference, not drawn) | 1.33 m/s | |
| Child | 1.0 m/s | Heat sensitivity ×1.2; needs lifts (strollers/small children on stairs) |
| Pregnant woman | 1.1 m/s | Heat ×1.4, slope ×1.3; needs lifts |
| Elderly person | 0.9 m/s | Heat ×1.5, slope ×1.5; needs lifts |
| Newcomer | 1.33 m/s × 0.85 | Wayfinding penalty: 15% slower plus 8 s at every junction with 3 or more ways |

Sources behind the defaults (rounded; these are population averages, not individual limits):

- Adult comfortable walking speed ~1.3–1.4 m/s: Bohannon, *Age and Ageing* 1997 (comfortable gait speed); the US Manual on Uniform Traffic Control Devices uses 1.2 m/s (3.5–4 ft/s) as a conservative design speed.
- Elderly ~0.9–1.0 m/s and below 0.8 m/s for people with mobility limits: Bohannon & Andrews 2011 (normative gait speed meta-analysis).
- Children ~1.0–1.2 m/s depending on age in pedestrian-safety literature; the low end is used because the map assumes walking *with* a younger child. No single source is cited for this value.
- Pregnancy: late-pregnancy gait studies report slower walking, in the order of 10–15% below non-pregnant; 1.1 m/s is used. No single source is cited for this value.
- Heat and rain multipliers and wayfinding penalties have no single citable value; they are **assumptions** chosen to be plausible and visible, and are easy to change.
- Tobler's hiking function: Tobler, W. (1993), *Three presentations on geographical analysis and modeling*, NCGIA Technical Report 93-1.

These references were written from memory and not re-checked against the papers in this build: verify before quoting them.

### Conditions

| Toggle | Effect |
|---|---|
| **Heat** | Speed × (1 − 0.18 × heat sensitivity) on uncovered edges, × (1 − 0.06 × sensitivity) on covered ones |
| **Rain** | Speed × 0.85 on uncovered edges, unchanged on covered ones |
| …**avoid uncovered** | Extra ×0.55 on uncovered edges (stand-in for detouring to stay dry) |
| **Slopes** | Tobler's function, speed ∝ exp(−3.5·\|grade + 0.05\|), relative to flat, with persona slope sensitivity multiplying the grade |
| **Broken lifts** | Steps and footbridges are blocked for personas that need lifts (child with stroller, pregnant, elderly). The newcomer is unaffected. |

Steps are always slow (×0.5 speed) for everyone, even with lifts working.

## Data sources

- Streets, steps, bridges, `covered`, `incline`: **© OpenStreetMap contributors**, ODbL, via the Overpass API (`overpass.kumi.systems`, `overpass-api.de`). The committed extract records the OSM timestamp.
- Base map: [OpenFreeMap](https://openfreemap.org) (free, no key), © OpenMapTiles, data © OpenStreetMap contributors.
- No elevation data is used (see limitations).

## Limitations (please read)

- **Slopes are a placeholder.** No DEM is bundled. Only OSM `incline` tags are used; where a bridge, flyover or tunnel has none, a 5% ramp of unknown direction is assumed and penalised both ways. BGC is nearly flat, so the slope toggle changes the result only slightly. A real DEM (e.g. Copernicus/SRTM sampled at build time) is the obvious next step.
- **Covered walkways are under-mapped in OSM.** Only `covered=yes`, `indoor=yes`, corridors and tunnels/building passages count as covered. BGC has many covered walks and mall connections that are not tagged, so heat and rain effects are probably overstated.
- **Lifts and escalators.** OSM has no status for broken lifts. The toggle is a what-if: all steps and footbridges are blocked for the personas that need lifts. Lifts that exist are not modelled individually.
- **Crossings and traffic.** Crossing waits, signals and unsafe crossings are not modelled. Streets with `sidewalk=no` are still walkable.
- **Private estates.** Paths with private or permit-only access are excluded; open malls and plazas may be missing or present depending on tagging.
- Personas are averages. Real people vary far more than these four numbers.
- The coverage box is small; clicks near the edge see a truncated network.
- Not tested on real devices or in a real browser in this build, only type-checked, built and smoke-tested; the engine was exercised on the real data in Node.

## Link preview

`public/og/preview.mp4` (1200×630, H.264, ~0.3 MB, 7 s) shows the isochrones growing for each persona. `public/og/preview.png` is the 1200×630 fallback and `public/og/player.html` is the `twitter:player` page. Regenerate all three after changing the engine or graph:

```bash
npm run preview-video   # needs ffmpeg; renders frames with @napi-rs/canvas
```

The head tags in `index.html` use absolute `https://fifteen-for-whom.vercel.app` URLs; update them if the domain changes.

## Add a new area

1. Add an entry to `src/areas.json`:
   ```json
   "komoro": {
     "name": "Komoro, Nagano",
     "center": [138.4267, 36.3275],
     "zoom": 15,
     "bbox": [138.41, 36.315, 138.445, 36.34],
     "graph": "/data/komoro.json",
     "start": [138.4267, 36.3275]
   }
   ```
   (`bbox` is `[west, south, east, north]`; keep it small, about 2 km × 2.5 km, to stay fast.)
2. `node scripts/build-graph.mjs komoro` (add `--refresh` to re-download from Overpass; raw output is cached in the gitignored `data/raw/`).
3. Commit `public/data/komoro.json`. Open the site with `?area=komoro`.
4. Tune the persona or condition constants in `src/engine.ts` if local conditions (e.g. snow) need different assumptions.

## Support

Free to use. If it helps you, consider a donation: [Sponsor 0xjitsu](https://github.com/sponsors/0xjitsu) <!-- TODO: placeholder until the donation account is chosen -->

## License

MIT, see [LICENSE](LICENSE). Map data © OpenStreetMap contributors (ODbL).
