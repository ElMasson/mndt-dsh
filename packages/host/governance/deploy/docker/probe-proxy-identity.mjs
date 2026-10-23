const base = 'http://governance-authority-1:8787'
const withHeader = await fetch(`${base}/governance/snapshot`, {
  headers: { 'x-auth-request-email': 'stephane@duke-analytics.com' },
})
console.log('avec en-tete proxy:', withHeader.status, (await withHeader.text()).slice(0, 140))
const anonymous = await fetch(`${base}/governance/snapshot`)
console.log('sans en-tete:', anonymous.status, (await anonymous.text()).slice(0, 80))
const badToken = await fetch(`${base}/governance/snapshot`, {
  headers: { authorization: 'Bearer faux', 'x-auth-request-email': 'stephane@duke-analytics.com' },
})
console.log('jeton faux + en-tete:', badToken.status)
const grant = await fetch(`${base}/governance/grant`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-auth-request-email': 'stephane@duke-analytics.com' },
  body: JSON.stringify({ actor: 'stephane@duke-analytics.com', subject: 'sara@duke-analytics.com', role: 'viewer' }),
})
console.log('grant par identite proxy:', grant.status, (await grant.text()).slice(0, 120))
