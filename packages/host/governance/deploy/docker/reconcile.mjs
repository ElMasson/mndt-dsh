const base = 'http://governance-authority-1:8787'
const owner = 'stephane@duke-analytics.com'
const viewer = 'sara@duke-analytics.com'
const headers = { 'content-type': 'application/json', 'x-auth-request-email': owner }

const bootstrap = await fetch(`${base}/governance/bootstrap`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ user: owner, role: 'owner' }),
})
console.log('bootstrap:', bootstrap.status, (await bootstrap.text()).slice(0, 110))

const grant = await fetch(`${base}/governance/grant`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ actor: owner, subject: viewer, role: 'viewer' }),
})
console.log('grant:', grant.status, (await grant.text()).slice(0, 110))

const escalation = await fetch(`${base}/governance/grant`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-auth-request-email': viewer },
  body: JSON.stringify({ actor: viewer, subject: viewer, role: 'admin' }),
})
console.log('escalade par le viewer:', escalation.status, (await escalation.text()).slice(0, 110))

const snapshot = await fetch(`${base}/governance/snapshot`, { headers })
console.log('snapshot:', snapshot.status, (await snapshot.text()).slice(0, 160))
