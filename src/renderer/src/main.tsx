import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import type { BullpenApi } from '../../preload/index'

declare global {
  interface Window {
    bullpen: BullpenApi
  }
}

document.body.style.margin = '0'

/**
 * No focus rings.
 *
 * Chromium draws a white ring on whatever was last clicked - buttons, toggles,
 * the search box - and against these panels it reads as a stray border rather
 * than as focus. Keyboard focus keeps a ring, in the app's own colour: losing
 * the outline entirely would leave tab navigation with nowhere visible to be.
 */
const rings = document.createElement('style')
rings.textContent = `
  :focus { outline: none }
  :focus-visible { outline: 1px solid var(--accent-ink); outline-offset: -1px }
`
document.head.appendChild(rings)
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
