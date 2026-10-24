import { chromium } from 'playwright-core'

const url = process.argv[2]
const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
})
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
const logs = []
page.on('console', message => logs.push(`${message.type()}: ${message.text().slice(0, 400)}`))
page.on('pageerror', error => logs.push(`pageerror: ${error.message.slice(0, 400)}`))
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(12000)
  const sidebar = await page.locator('nav, aside').first().innerText().catch(() => '')
  await page.screenshot({ path: process.argv[3] ?? 'C:/Project AI/deepseek-harness/mndt-page.png' })
  console.log(JSON.stringify({
    consoleErrors: logs.filter(line => /error|failed|mndt/i.test(line)).slice(0, 8),
    sidebar: sidebar.slice(0, 400),
  }, null, 1))
} catch (error) {
  console.log('ECHEC:', error.message.split('\n')[0])
}
await browser.close()
