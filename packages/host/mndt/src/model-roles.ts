/**
 * Which model plays each step of a turn, by its role (decision of Stéphane,
 * 26/11 and 27/11): Qwen on our H100 for the volume (workers, peers, scheduled
 * runs, missions), an API for framing, checking and judging (the verifier, the
 * synthesis, the council's framing and synthesis, the briefing); the author,
 * the reading of advice and the council's members keep their own agent's model.
 *
 * The space's policy is a file, `roles.json` beside `grants.json`, read at each
 * turn: route names, each a `provider/model` that may name a variable of the
 * space's model.env (`${VLLM_QWEN_MODEL}`), and for each role a route name or
 * `agent`. No file: every step keeps its agent's model, as before. A file that
 * does not read (an unknown role, an unknown or unpriced route, an author that
 * is not `agent`) refuses the turn, said; never a silent fallback. A route whose
 * variable is empty (a space without Qwen) is unavailable: its roles keep their
 * agent's model, and the operator's log says so once.
 */
import { readFile } from 'node:fs/promises'
import { priceOf } from './core/index.ts'
import type { Agent, PriceGrid } from './core/index.ts'

/** The roles a step can play. */
export const STEP_ROLES = [
  'author', 'worker', 'peer', 'helpReading', 'verifier', 'synthesis', 'council', 'councilMember', 'scheduled', 'mission', 'briefing',
] as const
export type StepRole = typeof STEP_ROLES[number]

/** A route a role may take: the model of a provider declared in the space's routes. */
export interface ModelRoute {
  readonly provider: string
  readonly model: string
}

/** The space's policy, once read. */
export interface ModelRoles {
  /** By name; undefined when its variable is empty (the route is unavailable). */
  readonly routes: Readonly<Record<string, ModelRoute | undefined>>
  /** By role: a route name, or « agent ». A role absent is « agent ». */
  readonly roles: Readonly<Partial<Record<StepRole, string>>>
}

/** No policy: every step keeps its agent's model. */
export const NO_MODEL_ROLES: ModelRoles = { routes: {}, roles: {} }

/** What reading the policy gave. */
export type ModelRolesRead =
  | { readonly ok: true; readonly policy: ModelRoles; readonly unavailable: readonly string[] }
  | { readonly ok: false; readonly reason: string }

const ROUTE_NAME = /^[a-z][a-z0-9-]{0,31}$/
const PROVIDER = /^[a-z0-9][a-z0-9-]{0,62}$/
const VARIABLE = /\$\{([A-Z_][A-Z0-9_]*)\}/g

/**
 * @param text - the file's text, or undefined when there is none.
 * @param env - where the routes' variables are read (the workbench's environment, from model.env).
 * @param prices - the space's price grid: a route without a price is refused.
 * @returns the policy, or why it does not read.
 */
export function parseModelRoles(
  text: string | undefined, env: Readonly<Record<string, string | undefined>>, prices: PriceGrid,
): ModelRolesRead {
  if (text === undefined) return { ok: true, policy: NO_MODEL_ROLES, unavailable: [] }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'roles.json n’est pas un JSON valide' }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'roles.json doit être un objet { routes, roles }' }
  const { routes: rawRoutes = {}, roles: rawRoles = {}, ...rest } = raw as Record<string, unknown>
  const unknownKeys = Object.keys(rest).filter(key => !key.startsWith('_') && key !== 'onUnreachable')
  if (unknownKeys.length > 0) return { ok: false, reason: `roles.json : clé inconnue ${unknownKeys.join(', ')}` }
  if (rawRoutes === null || typeof rawRoutes !== 'object' || Array.isArray(rawRoutes)) return { ok: false, reason: 'roles.json : routes doit être un objet' }
  if (rawRoles === null || typeof rawRoles !== 'object' || Array.isArray(rawRoles)) return { ok: false, reason: 'roles.json : roles doit être un objet' }
  const routes: Record<string, ModelRoute | undefined> = {}
  const unavailable: string[] = []
  for (const [name, value] of Object.entries(rawRoutes as Record<string, unknown>)) {
    if (!ROUTE_NAME.test(name) || name === 'agent') return { ok: false, reason: `roles.json : nom de route invalide « ${name} »` }
    if (typeof value !== 'string') return { ok: false, reason: `roles.json : la route ${name} doit être « fournisseur/modèle »` }
    let empty = false
    const expanded = value.replace(VARIABLE, (_whole, variable: string) => {
      const found = env[variable] ?? ''
      if (found.trim() === '') empty = true
      return found.trim()
    })
    if (empty) {
      routes[name] = undefined
      unavailable.push(name)
      continue
    }
    const slash = expanded.indexOf('/')
    const provider = slash < 0 ? '' : expanded.slice(0, slash)
    const model = slash < 0 ? '' : expanded.slice(slash + 1)
    if (!PROVIDER.test(provider) || model === '' || /\s/.test(model)) return { ok: false, reason: `roles.json : la route ${name} doit être « fournisseur/modèle », pas « ${value} »` }
    if (priceOf(prices, { provider, model }) === undefined) return { ok: false, reason: `roles.json : la route ${name} (${provider}/${model}) n’a pas de prix dans prices.json` }
    routes[name] = { provider, model }
  }
  const roles: Partial<Record<StepRole, string>> = {}
  for (const [role, value] of Object.entries(rawRoles as Record<string, unknown>)) {
    if (!(STEP_ROLES as readonly string[]).includes(role)) return { ok: false, reason: `roles.json : rôle inconnu « ${role} » (connus : ${STEP_ROLES.join(', ')})` }
    if (typeof value !== 'string' || (value !== 'agent' && !(value in routes))) {
      return { ok: false, reason: `roles.json : le rôle ${role} nomme une route inconnue « ${String(value)} »` }
    }
    // The author keeps its agent's model: so does the guard between an author and its verifier (same-model).
    if (role === 'author' && value !== 'agent') return { ok: false, reason: 'roles.json : l’auteur garde le modèle de son agent (author: "agent")' }
    roles[role as StepRole] = value
  }
  return { ok: true, policy: { routes, roles }, unavailable }
}

/**
 * @param policy - the space's policy.
 * @param role - the step's role.
 * @param agent - the agent that plays it.
 * @returns the model that plays it: the role's route, or the agent's own.
 */
export function resolveModel(policy: ModelRoles, role: StepRole, agent: Pick<Agent, 'provider' | 'model'>): ModelRoute & { readonly route?: string } {
  const name = policy.roles[role] ?? 'agent'
  const route = name === 'agent' ? undefined : policy.routes[name]
  return route === undefined ? { provider: agent.provider, model: agent.model } : { ...route, route: name }
}

/**
 * The role of a step of a turn, from its suffix (turns.ts: '' the author,
 * r its revision, v the verifier, w1… a worker, s the synthesis, h1a… a
 * peer's advice, hr1… the reading of the advice, cf/cs the council's framing
 * and synthesis, cpa…/cca… a member's position and critique).
 * @param suffix - the step's suffix.
 * @returns its role.
 * @throws on a suffix no step uses: a new step must be given its role here.
 */
export function stepRole(suffix: string): StepRole {
  if (suffix === '' || suffix === 'r') return 'author'
  if (suffix === 'v') return 'verifier'
  if (suffix === 's') return 'synthesis'
  if (suffix === 'cf' || suffix === 'cs') return 'council'
  if (/^c[pc][a-d]$/.test(suffix)) return 'councilMember'
  if (/^w\d+$/.test(suffix)) return 'worker'
  if (/^hr\d+$/.test(suffix)) return 'helpReading'
  if (/^h\d+[ab]$/.test(suffix)) return 'peer'
  throw new Error(`no step role for the suffix « ${suffix} »`)
}

const warned = new Set<string>()

/**
 * @param file - roles.json, or undefined when the space declares none.
 * @param env - the workbench's environment.
 * @param prices - the price grid.
 * @param warn - the operator's log: an unavailable route said once.
 * @returns the policy as it reads now (the file is read at each call).
 */
export async function readModelRoles(
  file: string | undefined, env: Readonly<Record<string, string | undefined>>, prices: PriceGrid, warn: (line: string) => void,
): Promise<ModelRolesRead> {
  if (file === undefined || file === '') return { ok: true, policy: NO_MODEL_ROLES, unavailable: [] }
  let text: string | undefined
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') text = undefined
    else return { ok: false, reason: 'roles.json ne se lit pas' }
  }
  const read = parseModelRoles(text, env, prices)
  if (read.ok) {
    for (const name of read.unavailable) {
      if (warned.has(name)) continue
      warned.add(name)
      warn(`mndt: the model route « ${name} » of roles.json names an empty variable of model.env: its roles keep their agent's model`)
    }
  }
  return read
}
