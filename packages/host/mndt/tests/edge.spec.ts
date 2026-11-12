import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

const deploy = join(import.meta.dirname, '..', 'deploy')

interface Service {
  command?: string[]
  ports?: string[]
  volumes?: string[]
  labels?: Record<string, string>
  networks?: string[]
}

interface Compose {
  services: Record<string, Service>
  networks: Record<string, { name?: string; external?: boolean }>
}

/** @returns the edge compose, parsed. */
function edge(): Compose {
  return load(readFileSync(join(deploy, 'edge', 'docker-compose.yml'), 'utf8')) as Compose
}

/** @returns a tenant compose rendered by create-tenant.sh with its defaults. */
function tenant(): Compose {
  const root = mkdtempSync(join(tmpdir(), 'edge-'))
  mkdirSync(join(root, 'etc', 'oauth2-proxy'), { recursive: true })
  writeFileSync(join(root, 'etc', 'oauth2-proxy', 'governance.cfg'), 'client_id = "app-1"\n')
  writeFileSync(join(root, 'etc', 'oauth2-proxy', 'client_secret'), 's')
  execFileSync('bash', [join(deploy, 'create-tenant.sh'), 'datanalysis', 'equipe.datanalysis.re', '--owner', 'duke@datanalysis.re', '--no-docker'], {
    env: { ...process.env, MNDT_ROOT: root },
  })
  return load(readFileSync(join(root, 'opt/mndt/datanalysis/docker-compose.yml'), 'utf8')) as Compose
}

/** @param command - a Traefik command line. @param flag - a flag name. @returns its value. */
function flag(command: readonly string[], name: string): string | undefined {
  return command.find(item => item.startsWith(`--${name}=`))?.slice(name.length + 3)
}

describe('edge (Traefik) of a fresh host', { timeout: 30_000 }, () => {
  it('publishes 80 and 443 only, redirects to https and reads the Docker socket read-only', () => {
    const traefik = edge().services.traefik!
    expect(traefik.ports).toEqual(['80:80', '443:443'])
    expect(traefik.volumes).toContain('/var/run/docker.sock:/var/run/docker.sock:ro')
    const command = traefik.command ?? []
    expect(flag(command, 'providers.docker.exposedbydefault')).toBe('false')
    expect(flag(command, 'entrypoints.web.http.redirections.entrypoint.scheme')).toBe('https')
    expect(flag(command, 'api.dashboard')).toBe('false')
    expect(flag(command, 'certificatesresolvers.letsencrypt.acme.email')).toContain('ACME_EMAIL:?')
  })

  it('is the network, the resolver and the entry point a rendered tenant expects', () => {
    const edgeCompose = edge()
    const command = edgeCompose.services.traefik!.command ?? []
    const network = edgeCompose.networks.traefik!.name
    const proxy = tenant()
    const labels = proxy.services.proxy!.labels ?? {}
    expect(labels['traefik.docker.network']).toBe(network)
    expect(proxy.networks.edge).toEqual({ external: true, name: network })
    expect(labels['traefik.http.routers.mndt-datanalysis.tls.certresolver']).toBe('letsencrypt')
    expect(command.some(item => item.startsWith('--certificatesresolvers.letsencrypt.'))).toBe(true)
    expect(labels['traefik.http.routers.mndt-datanalysis.entrypoints']).toBe('websecure')
    expect(flag(command, 'entrypoints.websecure.address')).toBe(':443')
    expect(labels['traefik.http.routers.mndt-datanalysis.rule']).toBe('Host(`equipe.datanalysis.re`)')
  })
})
