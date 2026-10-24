/** mndt occupants for the generic browser-brand slots. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { MndtBrandMark, MndtBrandName, MndtHeroMark } from './Brand.tsx'

/** Required service: the UI slot registry. */
export const inject = ['slots']

/**
 * Fill the brand slots as one declaration-aware registration set: the sidebar
 * mark and name, and the blank-session hero mark.
 *
 * The gate is deliberately inverted: this build registers unless the client was
 * built for the `official` profile explicitly. Gating on "mndt only" meant that
 * any ordinary rebuild, which carries no build profile, silently dropped the
 * brand and fell back to the shell's fish mark. The official package does the
 * mirror image (it registers only for `official`), and the slots are
 * `kind: 'single'`, so exactly one occupant exists in every case:
 *
 *   no profile   official skips, mndt registers   -> mndt brand
 *   mndt         official skips, mndt registers   -> mndt brand
 *   official     official registers, mndt skips   -> upstream brand
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  if (process.env.DSH_CLIENT_BUILD_PROFILE === 'official') return
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', () =>
      ctx.slots.inject('conversation.hero.brand.mark', function* () {
        yield ctx.slots.register({ name: 'sidebar.brand.mark' }, MndtBrandMark)
        yield ctx.slots.register({ name: 'sidebar.brand.name' }, MndtBrandName)
        yield ctx.slots.register({ name: 'conversation.hero.brand.mark' }, MndtHeroMark)
      })))
}
