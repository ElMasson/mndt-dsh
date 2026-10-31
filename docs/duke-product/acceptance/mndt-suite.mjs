import { chromium } from 'playwright-core'

const identities = ['duke@datanalysis.re', 'gouvernance@datanalysis.re', 'smarion@datanalysis.re']
const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  args: ['--host-resolver-rules=MAP mndt.duke-analytics.com 127.0.0.1'],
})
const report = []
for (const identity of identities) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1400 }, extraHTTPHeaders: { 'x-forwarded-email': identity } })
  const p = await context.newPage()
  let ready = false
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await p.goto('http://mndt.duke-analytics.com:8091/', { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => undefined)
    await p.waitForTimeout(7000)
    const started = p.getByText('Get started', { exact: true })
    if (await started.count() > 0) await started.first().click({ timeout: 5000 }).catch(() => {})
    await p.keyboard.press('Escape').catch(() => {})
    await p.getByText('This morning', { exact: false }).first().click({ timeout: 5000, force: true }).catch(() => {})
    await p.waitForTimeout(4000)
    if (await p.locator('.mndt-collab').count() > 0) { ready = true; break }
  }
  if (!ready) {
    report.push({ identity, chargement: false })
    await context.close()
    continue
  }
  try {
    await p.evaluate(() => { for (const node of document.querySelectorAll('[role="presentation"]')) node.remove() })
    const canvas = await p.locator('body').evaluate(node => getComputedStyle(node).backgroundColor)
    const titleFont = await p.locator('.mndt-channel-title').first().evaluate(node => getComputedStyle(node).fontFamily).catch(() => '')
    const channels = await p.locator('.mndt-channel').count()
    const humans = await p.locator('.mndt-context .mndt-person').count()
    const agents = await p.locator('.mndt-context .mndt-avatar[data-agent="true"]').count()
    await p.getByRole('button', { name: 'Activite' }).first().click({ timeout: 8000, force: true })
    await p.waitForTimeout(1000)
    const activityRows = await p.locator('.mndt-activity .mndt-event-post').count()
    await p.locator('select[aria-label="Filtrer l activite"]').selectOption('humans')
    await p.waitForTimeout(500)
    const humanRows = await p.locator('.mndt-activity .mndt-event-post').count()
    await p.getByText('equipe', { exact: true }).first().click({ timeout: 5000, force: true }).catch(() => {})
    await p.waitForTimeout(800)
    await p.keyboard.press('Control+K')
    await p.waitForTimeout(500)
    await p.locator('.mndt-search-input').fill('reporting')
    await p.waitForTimeout(500)
    const searchHits = await p.locator('.mndt-search-row').count()
    await p.keyboard.press('Escape')
    await p.waitForTimeout(300)
    const mandateRow = p.locator('.mndt-channel').filter({ hasText: 'Reporting marketing' }).first()
    let bandVisible = false
    let contextVisible = false
    let bandText = ''
    if (await mandateRow.count() > 0) {
      await mandateRow.click({ force: true })
      await p.waitForTimeout(900)
      bandVisible = await p.locator('.mndt-mandate-band').isVisible().catch(() => false)
      contextVisible = await p.locator('.mndt-context').isVisible().catch(() => false)
      bandText = await p.locator('.mndt-mandate-band').innerText().catch(() => '')
    }
    report.push({
      identity,
      chargement: true,
      fond: canvas,
      policeTitre: titleFont.split(',')[0].replace(/"/g, ''),
      canaux: channels,
      humainsPanneau: humans,
      agentsPanneau: agents,
      lignesActivite: activityRows,
      lignesHumains: humanRows,
      resultatsRecherche: searchHits,
      bandeauMandat: bandVisible,
      contexteVisible: contextVisible,
      bandeauTexte: bandText.replace(/\n/g, ' | ').slice(0, 140),
    })
  } catch (failure) {
    report.push({ identity, chargement: true, erreur: String(failure).slice(0, 160) })
  }
  await context.close()
}
await browser.close()
console.log(JSON.stringify(report, null, 2))