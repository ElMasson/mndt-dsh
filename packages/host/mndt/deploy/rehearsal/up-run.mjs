// Start a tenant's rendered compose with plain `docker run` (the rehearsal may
// run where the Compose plugin is missing): same images, environment, env
// files, volumes, commands and restart policy, service by service, on one
// network where each service answers to its name. Like `docker compose up -d`,
// a running container whose configuration did not change is KEPT, with the code
// it started with: the update rehearsal must see what the instance sees. `proxy` (oauth2-proxy, SSO)
// is left out: the rehearsal gives the gateway the identity header itself.
//   node up-run.mjs <compose.yml> <override.yml> <project>
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'

const [composePath, overridePath, project] = process.argv.slice(2)
if (project === undefined) {
  console.error('usage: node up-run.mjs <compose.yml> <override.yml> <project>')
  process.exit(2)
}
const base = load(readFileSync(composePath, 'utf8'))
const over = load(readFileSync(overridePath, 'utf8')) ?? {}
const services = { ...base.services }
for (const [name, extra] of Object.entries(over.services ?? {})) services[name] = { ...(services[name] ?? {}), ...extra }
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const network = `${project}_front`
try { docker('network', 'inspect', network) } catch { docker('network', 'create', network) }
for (const [name, service] of Object.entries(services)) {
  if (name === 'proxy') continue
  const container = `${project}-${name}`
  const args = ['run', '-d', '--name', container, '--network', network, '--network-alias', name, '--restart', service.restart ?? 'no']
  for (const file of service.env_file ?? []) args.push('--env-file', file)
  for (const [key, value] of Object.entries(service.environment ?? {})) args.push('-e', `${key}=${value}`)
  for (const volume of service.volumes ?? []) args.push('-v', volume)
  for (const port of service.ports ?? []) args.push('-p', port)
  for (const host of service.extra_hosts ?? []) args.push('--add-host', host)
  // The configuration hash: every argument, the env files' content and the image's
  // own id (a rebuilt tag is a new image), as Compose compares them.
  let imageId = service.image
  try { imageId = docker('image', 'inspect', '-f', '{{.Id}}', service.image) } catch { /* pulled by run */ }
  const envFiles = (service.env_file ?? []).map((file) => { try { return readFileSync(file, 'utf8') } catch { return '' } })
  const hash = createHash('sha256').update(JSON.stringify([args, service.command ?? null, imageId, envFiles])).digest('hex').slice(0, 16)
  let current = ''
  try { current = docker('inspect', '-f', '{{.State.Running}} {{index .Config.Labels "mndt.rehearsal.config"}}', container) } catch { /* absent */ }
  if (current === `true ${hash}`) {
    console.log(`${name}: kept (configuration unchanged)`)
    continue
  }
  try { docker('rm', '-f', container) } catch { /* absent */ }
  args.push('--label', `mndt.rehearsal.config=${hash}`, service.image)
  if (Array.isArray(service.command)) args.push(...service.command)
  console.log(`${name}: ${current === '' ? 'created' : 'recreated'} ${docker(...args).slice(0, 12)}`)
}
