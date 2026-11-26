// Start a tenant's rendered compose with plain `docker run` (the rehearsal may
// run where the Compose plugin is missing): same images, environment, env
// files, volumes, entrypoint, commands, user, read-only root, dropped
// capabilities, security options, fixed container name and restart policy,
// service by service, on one
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
// The compose's own networks, internal ones included; an external network (the
// host's Traefik) has no place in a rehearsal and is left out.
const declared = { ...(base.networks ?? {}), ...(over.networks ?? {}) }
const networkName = name => `${project}_${name}`
for (const [name, spec] of Object.entries(declared)) {
  if (spec?.external === true) continue
  try { docker('network', 'inspect', networkName(name)) } catch {
    docker('network', 'create', ...(spec?.internal === true ? ['--internal'] : []), networkName(name))
  }
}
/** @param service - one service. @returns its networks with their aliases, external ones left out. */
const attachments = (service) => {
  const listed = service.networks ?? ['front']
  const entries = Array.isArray(listed) ? listed.map(name => [name, {}]) : Object.entries(listed).map(([name, spec]) => [name, spec ?? {}])
  return entries.filter(([name]) => declared[name]?.external !== true).map(([name, spec]) => ({ name, aliases: spec.aliases ?? [] }))
}
for (const [name, service] of Object.entries(services)) {
  if (name === 'proxy') continue
  // A fixed name when the compose sets one (the egress proxy: the sidecar attaches it by name).
  const container = service.container_name ?? `${project}-${name}`
  const [first, ...others] = attachments(service)
  if (first === undefined) throw new Error(`${name}: no network of this rehearsal`)
  // Created, every network connected, then started: a service resolving one of its
  // own aliases at boot (the gateway's listen address) finds it already there.
  const args = ['create', '--name', container, '--network', networkName(first.name), '--network-alias', name,
    ...first.aliases.flatMap(alias => ['--network-alias', alias]), '--restart', service.restart ?? 'no']
  for (const file of service.env_file ?? []) args.push('--env-file', file)
  for (const [key, value] of Object.entries(service.environment ?? {})) args.push('-e', `${key}=${value}`)
  for (const volume of service.volumes ?? []) args.push('-v', volume)
  for (const port of service.ports ?? []) args.push('-p', port)
  for (const host of service.extra_hosts ?? []) args.push('--add-host', host)
  if (service.user !== undefined) args.push('--user', String(service.user))
  if (service.read_only === true) args.push('--read-only')
  for (const cap of service.cap_drop ?? []) args.push('--cap-drop', cap)
  for (const option of service.security_opt ?? []) args.push('--security-opt', option)
  if (Array.isArray(service.entrypoint)) args.push('--entrypoint', service.entrypoint[0])
  // The configuration hash: every argument, the env files' content and the image's
  // own id (a rebuilt tag is a new image), as Compose compares them.
  let imageId = service.image
  try { imageId = docker('image', 'inspect', '-f', '{{.Id}}', service.image) } catch { /* pulled by run */ }
  const envFiles = (service.env_file ?? []).map((file) => { try { return readFileSync(file, 'utf8') } catch { return '' } })
  const hash = createHash('sha256').update(JSON.stringify([args, others, service.command ?? null, imageId, envFiles])).digest('hex').slice(0, 16)
  let current = ''
  try { current = docker('inspect', '-f', '{{.State.Running}} {{index .Config.Labels "mndt.rehearsal.config"}}', container) } catch { /* absent */ }
  if (current === `true ${hash}`) {
    console.log(`${name}: kept (configuration unchanged)`)
    continue
  }
  try { docker('rm', '-f', container) } catch { /* absent */ }
  args.push('--label', `mndt.rehearsal.config=${hash}`, service.image)
  // An entrypoint of several words: the first is --entrypoint, the rest lead the command.
  if (Array.isArray(service.entrypoint)) args.push(...service.entrypoint.slice(1))
  if (Array.isArray(service.command)) args.push(...service.command)
  const id = docker(...args).slice(0, 12)
  for (const other of others) {
    docker('network', 'connect', '--alias', name, ...other.aliases.flatMap(alias => ['--alias', alias]), networkName(other.name), container)
  }
  docker('start', container)
  console.log(`${name}: ${current === '' ? 'created' : 'recreated'} ${id}`)
}
