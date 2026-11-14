import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const dockerfile = readFileSync(join(import.meta.dirname, '..', 'deploy', 'Dockerfile.workbench'), 'utf8')
const prebuilds = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'native', 'system', 'packages', 'linux-x64', 'prebuilds.json'), 'utf8')) as { binaries: { tool: string; kind: string; path: string }[] }

describe('the workbench image', () => {
  it('builds the static Landlock launcher, without which every agent turn fails closed', () => {
    // DSH refuses to run a workflow unconfined (sandbox-unavailable); in a container the
    // backend is Landlock through native/system's landlock-run, which the artifacts build
    // does not produce.
    const launcher = prebuilds.binaries.find(binary => binary.tool === 'landlock-run')
    expect(launcher).toMatchObject({ kind: 'static-musl', path: 'bin/landlock-run' })
    expect(dockerfile).toMatch(/apt-get install[^\n]*\bmusl-tools\b/)
    expect(dockerfile).toContain('RUN pnpm exec tsx native/system/scripts/build.ts')
    // The build stops when the launcher is missing, instead of shipping an image whose turns all fail.
    expect(dockerfile).toMatch(/accessSync\('native\/system\/packages\/linux-' \+ process\.arch \+ '\/bin\/landlock-run'/)
    // The launcher is built before the image's workspace is copied to the runtime stage.
    expect(dockerfile.indexOf('native/system/scripts/build.ts')).toBeLessThan(dockerfile.indexOf('COPY --from=build'))
  })
})
