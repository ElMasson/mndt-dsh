// Run one command the way the workbench confines an agent's command: the image's
// own LocalSandboxProvider (sandbox-local) chooses the runner and builds its
// arguments from the policy and the process environment (DSH_SANDBOX_READ_ROOTS),
// then the confined argv runs. Prints the runner's argv head and the output.
//   node sandbox-probe.mjs <workspace root> <script>
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

// Resolved from the image's sandbox-local package, as the workbench resolves them.
const from = createRequire('/app/packages/sandbox/sandbox-local/package.json')
const load = async name => import(pathToFileURL(from.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const LocalSandboxProvider = (await load('/app/packages/sandbox/sandbox-local/lib/index.js')).default

const [workspaceRoot, script] = process.argv.slice(2)
const ctx = new Context()
const provider = new LocalSandboxProvider(ctx, { runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 5000 })
let confined
try {
  confined = await provider.confine(['sh', script], { mode: 'workspace-write', workspaceRoot })
} catch (error) {
  console.log(`SANDBOX-REFUSED ${error instanceof Error ? error.message : String(error)}`)
  process.exit(0)
}
console.log(`RUNNER ${confined.argv[0]} enforcement=${confined.enforcement} read=${confined.argv.filter((_a, i, all) => all[i - 1] === '--read' || all[i - 1] === '--ro').join(',') || '?'}`)
// The command gets what an agent's command gets: no inherited environment (the
// workbench's holds the model keys), only a path and a home.
const run = spawnSync(confined.argv[0], confined.argv.slice(1), {
  cwd: workspaceRoot, encoding: 'utf8', timeout: 150000, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', LANG: 'C.UTF-8' },
})
process.stdout.write(run.stdout ?? '')
process.stdout.write(run.stderr ? `STDERR ${run.stderr.slice(0, 2000)}\n` : '')
console.log(`EXIT ${run.status}`)
