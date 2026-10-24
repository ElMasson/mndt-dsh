import { chromium } from 'playwright-core'

const url = process.argv[2]
const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
})
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(9000)
  const governor = page.getByRole('button', { name: /governance/i })
  if (await governor.count()) {
    await governor.first().click()
  } else {
    await page.getByText('Governance', { exact: false }).first().click()
  }
  await page.waitForTimeout(2500)
  const rights = page.getByRole('button', { name: /^rights$/i })
  if (await rights.count()) {
    await rights.first().click()
    await page.waitForTimeout(3500)
  }
  const pills = await page.locator('.gov-pill').allTextContents()
  const rows = await page.locator('.gov-table tbody tr, table tbody tr').allInnerTexts()
  const body = await page.locator('.gov').innerText()
  await page.screenshot({ path: 'C:/Project AI/deepseek-harness/gov-team.png' })
  console.log(JSON.stringify({
    pills,
    rows: rows.slice(0, 6),
    hasIdentity: body.includes('datanalysis.re'),
    hasOwner: body.includes('owner'),
    hasViewer: body.includes('viewer'),
    hasLive: /Live table/i.test(body),
  }, null, 1))
} catch (error) {
  console.log('ECHEC:', error.message.split('\n')[0])
}
await browser.close()
