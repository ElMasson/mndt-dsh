// A tiny OpenID Connect provider used only to rehearse the sign-in chain.
// It never sees a real credential: the authorization endpoint approves at once,
// which is exactly what a test needs and exactly what production must never do.
import { createSign, generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'

const PORT = Number(process.env.PORT ?? 9000)
const ISSUER = process.env.ISSUER ?? `http://localhost:${PORT}`
const CLIENT_ID = process.env.CLIENT_ID ?? 'test-client'
const EMAIL = process.env.EMAIL ?? 'duke@datanalysis.re'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig', alg: 'RS256' }

/** @param value - JSON payload. @returns a base64url segment. */
const segment = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')

/** @param claims - token claims. @returns a signed compact JWT. */
function sign(claims) {
  const head = segment({ alg: 'RS256', typ: 'JWT', kid: 'test-key' })
  const body = segment(claims)
  const signature = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey, 'base64url')
  return `${head}.${body}.${signature}`
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', ISSUER)
  if (url.pathname === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true }))
    return
  }
  if (url.pathname === '/.well-known/openid-configuration') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
      userinfo_endpoint: `${ISSUER}/userinfo`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      scopes_supported: ['openid', 'email', 'profile'],
    }))
    return
  }
  if (url.pathname === '/jwks') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ keys: [jwk] }))
    return
  }
  if (url.pathname === '/authorize') {
    const redirect = url.searchParams.get('redirect_uri')
    if (redirect === null) {
      response.writeHead(400).end('redirect_uri missing')
      return
    }
    const target = new URL(redirect)
    target.searchParams.set('code', 'test-code')
    const state = url.searchParams.get('state')
    if (state !== null) target.searchParams.set('state', state)
    response.writeHead(302, { location: target.toString() })
    response.end()
    return
  }
  if (url.pathname === '/token' && request.method === 'POST') {
    let body = ''
    request.on('data', (chunk) => { body += String(chunk) })
    request.on('end', () => {
      const now = Math.floor(Date.now() / 1000)
      const idToken = sign({
        iss: ISSUER,
        aud: CLIENT_ID,
        sub: 'test-subject',
        email: EMAIL,
        email_verified: true,
        preferred_username: EMAIL,
        name: 'Recette SSO',
        iat: now,
        exp: now + 3600,
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ access_token: 'test-access-token', token_type: 'Bearer', expires_in: 3600, id_token: idToken }))
    })
    return
  }
  if (url.pathname === '/userinfo') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ sub: 'test-subject', email: EMAIL, email_verified: true }))
    return
  }
  response.writeHead(404).end('not found')
})

server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(`sso-stub listening on ${PORT} as ${ISSUER}\n`)
})
