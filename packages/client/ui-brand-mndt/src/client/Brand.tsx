import symbol from '../assets/mndt-symbol.png'
import wordmark from '../assets/mndt-wordmark.png'
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/** Intrinsic ratio of the mndt ribbon (measured on the brand kit source). */
const SYMBOL_RATIO = 2.2
/** Intrinsic ratio of the mndt wordmark (measured on the brand kit source). */
const WORDMARK_RATIO = 3.36

/**
 * Sidebar mark: the ribbon, kept slightly under the host's requested edge so it
 * sits level with the wordmark beside it instead of dominating the brand row.
 * @param props - Host-supplied mark presentation.
 * @returns the mndt ribbon.
 */
export function MndtBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  const height = Math.round(size * 0.78)
  return (
    <img
      src={symbol}
      alt="mndt"
      height={height}
      width={Math.round(height * SYMBOL_RATIO)}
      style={{ display: 'block', objectFit: 'contain' }}
    />
  )
}

/**
 * Sidebar name: the wordmark without its independently slotted mark.
 * @returns the mndt wordmark.
 */
export function MndtBrandName() {
  const height = 22
  return (
    <img
      src={wordmark}
      alt="mndt"
      height={height}
      width={Math.round(height * WORDMARK_RATIO)}
      style={{ display: 'block', objectFit: 'contain' }}
    />
  )
}

/**
 * Blank-session hero mark. The slot asks for a square edge and hands back the
 * host class that preserves its geometry (the shell's fish sits in it), so the
 * ribbon is centred inside that square at its own ratio instead of being
 * stretched to fill it.
 * @param props - Requested square edge and the host's geometry class.
 * @returns the mndt ribbon centred in the hero slot.
 */
export function MndtHeroMark({ size, className }: HeroBrandMarkOwnerProps) {
  const height = Math.round(size * 0.64)
  return (
    <span
      className={className}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size }}
    >
      <img
        src={symbol}
        alt="mndt"
        height={height}
        width={Math.round(height * SYMBOL_RATIO)}
        style={{ display: 'block', objectFit: 'contain' }}
      />
    </span>
  )
}
