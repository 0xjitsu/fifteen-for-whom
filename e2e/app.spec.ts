import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const SHOTS = 'docs/screenshots'
mkdirSync(SHOTS, { recursive: true })

const PERSONAS = ['child', 'pregnant', 'elderly', 'newcomer']
const BANDS = [5, 10, 15]

type Reach = Record<string, Record<number, string>>

/** Every persona's reach geometry per band, read from the map sources. */
async function reach(page: Page): Promise<Reach> {
  return page.evaluate(async (personas) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map = (window as any).__map
    const out: Record<string, Record<number, string>> = {}
    for (const p of personas) {
      const fc = await map.getSource(`reach-${p}`).getData()
      out[p] = {}
      for (const f of fc.features) out[p][f.properties.band] = JSON.stringify(f.geometry.coordinates)
    }
    return out
  }, PERSONAS)
}

const sig = (r: Reach) => JSON.stringify(r)

async function openMap(page: Page) {
  await page.goto('/')
  await expect(page.locator('.pin')).toBeVisible() // pin is there at the default start straight away
  await page.waitForFunction(
    () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = (window as any).__map
      return m && m.loaded() && m.areTilesLoaded()
    },
    undefined,
    { timeout: 60_000 },
  )
  await expect(page.locator('#loading')).toBeHidden()
}

/** Click a spot slightly off the default start so the click handler really runs. */
async function clickMap(page: Page, dx = 30, dy = -40) {
  const [x, y] = await page.evaluate(
    ([dx, dy]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = (window as any).__map
      const pt = m.project(m.getCenter())
      return [pt.x + dx, pt.y + dy]
    },
    [dx, dy],
  )
  await page.mouse.click(x, y)
  await expect(page.locator('#explain')).toContainText('Share of the streets')
}

async function expectRings(page: Page) {
  const r = await reach(page)
  for (const p of PERSONAS) {
    for (const b of BANDS) {
      expect((JSON.parse(r[p][b]) as unknown[]).length, `${p} ${b} min ring`).toBeGreaterThan(0)
    }
    // bands nest: more time reaches more street
    expect(r[p][15].length).toBeGreaterThan(r[p][10].length)
    expect(r[p][10].length).toBeGreaterThan(r[p][5].length)
  }
  // personas differ from each other
  expect(new Set(PERSONAS.map((p) => r[p][15])).size).toBe(4)

  const layers = await page.evaluate(
    ([personas, bands]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = (window as any).__map
      return (personas as string[]).flatMap((p) => (bands as number[]).map((b) => !!m.getLayer(`reach-${p}-${b}`)))
    },
    [PERSONAS, BANDS],
  )
  expect(layers.length).toBe(12)
  expect(layers.every(Boolean)).toBe(true)
}

async function shootEachPersona(page: Page, prefix: string) {
  for (const p of PERSONAS) {
    for (const q of PERSONAS) await page.locator(`input[data-p="${q}"]`).setChecked(q === p)
    // wait until this persona's rings are actually painted, not just tiles loaded
    await page.waitForFunction((id) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = (window as any).__map
      return m.areTilesLoaded() && m.queryRenderedFeatures({ layers: [`reach-${id}-5`, `reach-${id}-10`, `reach-${id}-15`] }).length > 0
    }, p)
    await page.screenshot({ path: `${SHOTS}/${prefix}-${p}.png` })
  }
}

test('tiles render, then a click draws 5/10/15 min rings for all 4 personas', async ({ page }) => {
  await openMap(page)
  const rendered = await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = (window as any).__map
    return m.queryRenderedFeatures().filter((f: { source: string }) => !f.source.startsWith('reach-')).length
  })
  expect(rendered, 'vector tiles should render features').toBeGreaterThan(50)

  await clickMap(page)
  await expectRings(page)

  await shootEachPersona(page, 'desktop')
})

test.describe('toggles change the isochrone shape', () => {
  for (const [id, label] of [
    ['c-heat', 'Hot day'],
    ['c-rain', 'Rain'],
    ['c-slopes', 'Hills and ramps'],
    ['c-lifts', 'Broken lifts'],
  ] as const) {
    test(label, async ({ page }) => {
      await openMap(page)
      await clickMap(page)
      const before = sig(await reach(page))
      await page.locator(`#${id}`).check()
      await expect.poll(async () => sig(await reach(page))).not.toBe(before)
    })
  }

  test('Avoid uncovered streets is disabled until Rain is on', async ({ page }) => {
    await openMap(page)
    await clickMap(page)
    await expect(page.locator('#c-avoid')).toBeDisabled()
    await page.locator('#c-rain').check()
    await expect(page.locator('#c-avoid')).toBeEnabled()
    const rain = sig(await reach(page))
    await page.locator('#c-avoid').check()
    await expect.poll(async () => sig(await reach(page))).not.toBe(rain)
  })
})

test('page copy, donate link and focus outline', async ({ page }) => {
  await openMap(page)
  await expect(page.getByText('Hot day', { exact: true })).toBeVisible()
  await expect(page.getByText('Hills and ramps', { exact: true })).toBeVisible()
  await expect(page.getByText('5 / 10 / 15 min')).toBeVisible()
  await expect(page.locator('.limits summary')).toBeVisible()
  await page.locator('.limits summary').click()
  await expect(page.locator('.limits p')).toBeVisible()
  await expect(page.locator('#panel')).toContainText('assumptions')
  await expect(page.locator('#donate-wrap')).toBeHidden() // DONATE_URL is empty
  await page.keyboard.press('Tab')
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineStyle)
  expect(outline).not.toBe('none')
  const small = await page.evaluate(
    () => [...document.querySelectorAll('.bands span, footer, .limits p, h2')].filter((e) => parseFloat(getComputedStyle(e).fontSize) < 12).length,
  )
  expect(small).toBe(0)
})

test('layout holds at 390px wide', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  const page = await ctx.newPage()
  await openMap(page)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  const box = await page.locator('#panel').boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  await clickMap(page, 0, -150)
  await expectRings(page)
  await shootEachPersona(page, 'mobile')
  await ctx.close()
})
