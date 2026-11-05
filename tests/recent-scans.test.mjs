import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

let server
let RecentScans
let OverviewPage

before(async () => {
  // Use the existing Vite JSX pipeline to test the real components in Node.
  server = await createServer({
    configFile: false,
    plugins: [react()],
    server: { middlewareMode: true, hmr: false },
    logLevel: 'error'
  })
  ;({ RecentScans } = await server.ssrLoadModule(
    '/src/renderer/src/features/overview/RecentScans.tsx'
  ))
  ;({ OverviewPage } = await server.ssrLoadModule('/src/renderer/src/pages/OverviewPage.tsx'))
})

after(async () => {
  await server?.close()
})

function renderScans(scans) {
  return renderToStaticMarkup(createElement(RecentScans, { scans }))
}

// Test fixtures only: these records are never imported by the application.
function scan(id, completedAt, overrides = {}) {
  return {
    id,
    path: `C:\\Test fixtures\\${id}`,
    completedAt,
    totalBytes: 12_500_000_000,
    fileCount: 12_345,
    ...overrides
  }
}

test('empty state explains where completed scans will appear without fabricated entries or actions', () => {
  const html = renderScans([])
  assert.match(html, /Recent Scans/)
  assert.match(html, /No scans yet/)
  assert.match(html, /Completed scans will appear here/)
  assert.doesNotMatch(html, /<ol\b|<li\b|<button\b|<a\b/)
})

test('populated state displays location, local completion time, decimal GB and grouped file counts', () => {
  const completedAt = new Date(2026, 10, 5, 14, 30).toISOString()
  const html = renderScans([scan('documents', completedAt)])
  assert.ok(html.includes('C:\\Test fixtures\\documents'))
  assert.ok(html.includes(completedAt))
  assert.match(html, /<time\b/)
  assert.match(html, /Nov 5, 2026, 14:30/)
  assert.match(html, /Analyzed/)
  assert.match(html, /12\.5 GB/)
  assert.match(html, /Files/)
  assert.match(html, /12,345/)
  assert.doesNotMatch(html, /No scans yet|<button\b|<a\b/)
})

test('renders only the five newest scans without mutating the supplied summaries', () => {
  const scans = Object.freeze(
    [2, 0, 5, 1, 4, 3].map((index) =>
      Object.freeze(scan(`entry-${index}`, `2026-11-05T0${index}:00:00Z`))
    )
  )
  const html = renderScans(scans)
  assert.equal((html.match(/<li\b/g) ?? []).length, 5)
  assert.match(html, /Showing latest 5/)
  assert.doesNotMatch(html, /entry-0/)
  for (let index = 5; index > 1; index--) {
    assert.ok(html.indexOf(`entry-${index}`) < html.indexOf(`entry-${index - 1}`))
  }
  assert.deepEqual(
    scans.map(({ id }) => id),
    ['entry-2', 'entry-0', 'entry-5', 'entry-1', 'entry-4', 'entry-3']
  )
})

test('compares timestamps by actual completion time, including timezone offsets', () => {
  const html = renderScans([
    scan('earlier', '2026-11-05T11:00:00+02:00'),
    scan('later', '2026-11-05T10:00:00Z')
  ])
  assert.ok(html.indexOf('later') < html.indexOf('earlier'))
})

test('preserves unusual paths as escaped text and displays zero sizes and file counts', () => {
  const html = renderScans([
    scan('unusual', '2026-11-05T10:00:00Z', {
      path: 'D:\\Архів & notes\\<img src=x onerror=alert(1)>',
      totalBytes: 0,
      fileCount: 0
    })
  ])
  assert.match(html, /Архів &amp; notes/)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.doesNotMatch(html, /<img\b/)
  assert.match(html, /0 GB/)
  assert.match(html, /<dd[^>]*>0<\/dd>/)
})

test('Overview defaults to the empty state and keeps Scan Folder disabled', () => {
  const html = renderToStaticMarkup(createElement(OverviewPage))
  assert.match(html, /No scans yet/)
  assert.doesNotMatch(html, /<ol\b|Test fixtures/)
  assert.match(html, /<button\b[^>]*aria-pressed="false"[^>]*>[\s\S]*?Demo scans/)
  assert.match(html, /<button\b[^>]*disabled=""[^>]*>[\s\S]*?Scan Folder/)
})
