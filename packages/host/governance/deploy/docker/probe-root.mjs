const root = await fetch('http://governance-authority-1:8787/', {
  headers: { 'x-auth-request-email': 'stephane@duke-analytics.com' },
})
console.log('racine avec identite proxy:', root.status, (await root.text()).slice(0, 180))

const anonymous = await fetch('http://governance-authority-1:8787/')
console.log('racine sans identite:', anonymous.status)
