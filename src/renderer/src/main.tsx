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

  /* A range input draws a rounded blue lozenge in every OS's own idea of a
     slider, which is the one control in this app that looks like it came from
     somewhere else. Square track, square thumb, the app's own colours - the
     filled part is painted inline, because a gradient is the only way to do it
     without a pseudo-element per browser. */
  input[type='range'] {
    -webkit-appearance: none;
    appearance: none;
    height: 8px;
    border: 1px solid var(--line);
    background: var(--sunk);
    cursor: ew-resize;
  }
  /* Same reason: a checkbox is the other control that arrives in the system's
     blue rather than the app's. */
  input[type='checkbox'] { accent-color: var(--accent-ink) }

  /* The one animation in the app: something turning while a floor is handed
     over and the window is taken down. */
  @keyframes bp-spin { to { transform: rotate(360deg) } }
  input[type='range']::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 9px;
    height: 14px;
    border: 0;
    border-radius: 0;
    background: var(--accent-ink);
  }
`
document.head.appendChild(rings)

/**
 * A control the pointer chose does not keep the ring.
 *
 * Focus stays on whatever was last clicked, and the ring around it is drawn in
 * the same colour as selected - so a toggle switched *off* by the click still
 * read as on, and the only way to clear it was to click somewhere else. Two
 * buttons had already grown their own `blur()` in their own `onClick`, which is
 * a fix that has to be remembered every time a button is written. Once, here,
 * for every button there is. Keyboard focus is untouched: `blur` on pointerup
 * cannot fire for a key.
 */
document.addEventListener('pointerup', (e) => {
  const hit = (e.target as HTMLElement | null)?.closest('button')
  if (hit && document.activeElement === hit) hit.blur()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
