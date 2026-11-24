#!/usr/bin/env node
/**
 * Generates the README media from the real app (no mock-ups):
 *   docs/images/collab.gif   two users typing into the same document, side by side
 *   docs/images/editor.png   the editor with comments + presence
 *   docs/images/replay.png   time travel over the op log
 *   docs/images/grafana.png  the cluster dashboard (if Grafana is running)
 *
 *   node scripts/capture.mjs [--base http://localhost:5173] [--grafana http://localhost:3000] [--channel msedge]
 *   (--grafana-from / --grafana-to: epoch ms window to show, e.g. a chaos run)
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { PNG } from 'pngjs'
import gifenc from 'gifenc'

const { GIFEncoder, quantize, applyPalette } = gifenc
const args = process.argv.slice(2)
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d)
const BASE = opt('base', 'http://localhost:5173')
const GRAFANA = opt('grafana', '')
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs/images')
fs.mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ channel: opt('channel', process.env.PW_CHANNEL || undefined) })
// Desktop layout (>900 CSS px) rendered at 0.8x so the side-by-side GIF stays compact.
const W = 940
const H = 690
const DSF = 0.8
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function guest() {
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DSF })
  const page = await context.newPage()
  await page.goto(`${BASE}/login`)
  await page.getByRole('button', { name: /guest/i }).click()
  await page.getByRole('heading', { name: 'Documents', exact: true }).waitFor()
  return page
}

// ------------------------------------------------------------------ two users, side by side
const alice = await guest()
const bob = await guest()
await alice.getByRole('button', { name: 'New document' }).click()
await alice.waitForURL(/\/d\//)
await alice.getByLabel('Document title').fill('Launch plan')
await alice.getByLabel('Document title').press('Enter')
const docId = alice.url().split('/d/')[1]
const { link } = await (await alice.request.post(`${BASE}/api/docs/${docId}/links`, { data: { role: 'editor' } })).json()
await bob.goto(`${BASE}/join/${link.token}`)
await bob.waitForURL(/\/d\//)
const saved = (p) => p.waitForFunction(() => document.querySelector('.save-indicator')?.textContent?.includes('All changes saved'))
for (const p of [alice, bob]) await saved(p)
await bob
  .locator('.toast')
  .waitFor({ state: 'detached', timeout: 8000 })
  .catch(() => {})

const ed = (p) => p.getByRole('textbox', { name: 'Document body' })
await ed(alice).click()
await alice.keyboard.type('Launch plan', { delay: 10 })
await alice.getByLabel('Text style').selectOption('h1')
await alice.keyboard.press('End')
await alice.keyboard.press('Enter')
await sleep(300)

/** Composite both browser windows into one RGBA frame. */
async function frame() {
  const [a, b] = await Promise.all([alice.screenshot(), bob.screenshot()])
  const pa = PNG.sync.read(a)
  const pb = PNG.sync.read(b)
  const gap = 12
  const width = pa.width + gap + pb.width
  const height = Math.min(pa.height, pb.height)
  const out = new Uint8Array(width * height * 4).fill(236)
  for (let y = 0; y < height; y++) {
    out.set(pa.data.subarray(y * pa.width * 4, (y + 1) * pa.width * 4), y * width * 4)
    out.set(pb.data.subarray(y * pb.width * 4, (y + 1) * pb.width * 4), (y * width + pa.width + gap) * 4)
  }
  return { data: out, width, height }
}

const frames = []
// Alice starts her line; Bob opens a new line below it (after a non-empty paragraph, so the
// split is unambiguous), then both type concurrently.
const aliceText = 'Goals: ship real-time editing to every customer by Q3.'
const bobText = 'Risks: offline edits must merge without conflicts.'
await alice.keyboard.type(aliceText.slice(0, 7))
await sleep(300)
const focusEnd = (p) => p.evaluate(() => document.querySelector('.ProseMirror').editor.commands.focus('end'))
await focusEnd(bob)
await bob.keyboard.press('Enter')
await sleep(300)
frames.push(await frame())
for (let i = 0; i < Math.max(aliceText.length - 7, bobText.length); i += 2) {
  if (i + 7 < aliceText.length) await alice.keyboard.type(aliceText.slice(i + 7, i + 9))
  if (i < bobText.length) await bob.keyboard.type(bobText.slice(i, i + 2))
  if (i % 4 === 0) frames.push(await frame())
}
await sleep(400)
for (let i = 0; i < 6; i++) frames.push(await frame()) // hold the final frame

const first = frames[0]
const palette = quantize(frames[Math.floor(frames.length / 2)].data, 256)
const gif = GIFEncoder()
for (const [i, f] of frames.entries()) {
  gif.writeFrame(applyPalette(f.data, palette), f.width, f.height, {
    palette: i === 0 ? palette : undefined,
    delay: i >= frames.length - 6 ? 300 : 90,
  })
}
gif.finish()
fs.writeFileSync(path.join(OUT, 'collab.gif'), gif.bytes())
console.log(`collab.gif: ${frames.length} frames, ${first.width}x${first.height}, ${(gif.bytes().length / 1e6).toFixed(2)} MB`)

// ------------------------------------------------------------------ editor with comments
const wide = await browser.newContext({
  viewport: { width: 1440, height: 860 },
  deviceScaleFactor: 1,
  storageState: await alice.context().storageState(),
})
const main = await wide.newPage()
await main.goto(`${BASE}/d/${docId}`)
await saved(main)
await focusEnd(main)
await main.keyboard.press('Enter')
await main.keyboard.type('Owner: platform team. Status: on track.')
await main.keyboard.press('Control+Shift+ArrowLeft')
await main.keyboard.press('Control+Shift+ArrowLeft')
await main.keyboard.press('Control+Shift+ArrowLeft')
await main.getByRole('button', { name: 'Comment', exact: true }).click()
await main.getByPlaceholder('Add a comment…').fill('Can we confirm with the load-test results first?')
await main.locator('.composer').getByRole('button', { name: 'Comment' }).click()
await bob.locator('.comment-mark').waitFor()
await bob.getByRole('button', { name: 'Comments' }).click()
await bob.locator('.thread').first().click()
await bob.locator('.thread textarea').fill('Yes: p99 was 46 ms with 500 clients.')
await bob.locator('.thread').getByRole('button', { name: 'Reply' }).click()
// Posting a comment already opened the panel on this page.
await main.locator('.thread').getByText('p99 was 46 ms').waitFor()
await main.locator('.thread').first().click()
await sleep(500)
await main.screenshot({ path: path.join(OUT, 'editor.png') })
console.log('editor.png')

// ------------------------------------------------------------------ time travel
await main.getByRole('button', { name: 'History' }).click()
await main.getByRole('button', { name: /Replay editing history/ }).click()
const slider = main.getByLabel('Position in history')
await slider.waitFor()
const max = Number(await slider.getAttribute('max'))
await slider.fill(String(Math.round(max * 0.55)))
await sleep(600)
await main.screenshot({ path: path.join(OUT, 'replay.png') })
console.log('replay.png')

// ------------------------------------------------------------------ grafana
if (GRAFANA) {
  const g = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })
  const from = opt('grafana-from', 'now-10m')
  const to = opt('grafana-to', 'now')
  await g.goto(`${GRAFANA}/d/collabdocs/collabdocs-cluster?orgId=1&from=${from}&to=${to}&kiosk&theme=light`)
  await g.waitForLoadState('networkidle')
  await sleep(2500)
  await g.screenshot({ path: path.join(OUT, 'grafana.png') })
  console.log('grafana.png')
}

await browser.close()
