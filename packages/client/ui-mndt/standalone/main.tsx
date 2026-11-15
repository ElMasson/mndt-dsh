/**
 * Entry of the standalone team page (`vite build --config standalone/vite.config.ts`): mounts the
 * page and its styles, nothing else. What the page does is in `src/client/TeamApp.tsx`.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// The brand faces, self-hosted (SIL OFL 1.1): Inter for text, Space Grotesk for titles.
import '../../ui-brand-mndt/src/styles/brand-font.css'
import { TeamApp } from '../src/client/TeamApp.tsx'
import { createHttpFace } from '../src/client/httpFace.ts'
import { createHttpChat } from '../src/client/httpChat.ts'
import { createHttpDocuments } from '../src/client/documents.ts'
import { CSS } from '../src/client/styles.ts'
import { TEAM_CSS } from '../src/client/teamStyles.ts'

const style = document.createElement('style')
style.id = 'mndt-team-styles'
style.textContent = CSS + TEAM_CSS
document.head.append(style)

const root = document.getElementById('root')
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <TeamApp api={createHttpFace()} chat={createHttpChat()} documents={createHttpDocuments()} />
    </StrictMode>,
  )
}
