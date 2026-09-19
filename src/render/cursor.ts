// Injected into every page via Playwright's addInitScript. Renders a
// floating cursor that mirrors the real pointer, plus a CSS ripple
// animation on mousedown. Purely visual — does not synthesize events.

export function buildCursorInitScript(opts: { size: number; color: string }): string {
  const { size, color } = opts
  return `
(() => {
  if (window.__videoStudioCursorInstalled) return
  window.__videoStudioCursorInstalled = true

  const install = () => {
    if (!document.body) {
      requestAnimationFrame(install)
      return
    }

    const cursor = document.createElement('div')
    cursor.id = '__vs-cursor'
    Object.assign(cursor.style, {
      position: 'fixed',
      left: '0px',
      top: '0px',
      width: '${size}px',
      height: '${size}px',
      borderRadius: '50%',
      background: '${color}',
      boxShadow: '0 0 0 4px rgba(255,255,255,0.6), 0 0 16px ${color}',
      pointerEvents: 'none',
      zIndex: '2147483647',
      transform: 'translate(-50%, -50%)',
      transition: 'transform 60ms linear',
      mixBlendMode: 'normal',
    })
    document.body.appendChild(cursor)

    const setPos = (x, y) => {
      cursor.style.left = x + 'px'
      cursor.style.top = y + 'px'
    }

    document.addEventListener('mousemove', (e) => setPos(e.clientX, e.clientY), { passive: true, capture: true })

    // Click ripple
    const styleEl = document.createElement('style')
    styleEl.textContent = \`
      @keyframes __vs_ripple {
        0%   { opacity: 0.9; transform: translate(-50%, -50%) scale(0.4); }
        100% { opacity: 0;   transform: translate(-50%, -50%) scale(3); }
      }
      .__vs-ripple {
        position: fixed;
        width: 36px; height: 36px;
        border-radius: 50%;
        background: transparent;
        border: 3px solid ${color};
        pointer-events: none;
        z-index: 2147483646;
        animation: __vs_ripple 600ms ease-out forwards;
      }
    \`
    document.head.appendChild(styleEl)

    document.addEventListener('mousedown', (e) => {
      const r = document.createElement('div')
      r.className = '__vs-ripple'
      r.style.left = e.clientX + 'px'
      r.style.top = e.clientY + 'px'
      document.body.appendChild(r)
      setTimeout(() => r.remove(), 650)
    }, { passive: true, capture: true })
  }

  install()
})()
`
}

// Programmatic ripple at a specific point (used after a Playwright .click()
// since synthesized clicks don't fire mousedown the same way visually).
export function rippleAt(x: number, y: number): string {
  return `
(() => {
  const r = document.createElement('div')
  r.className = '__vs-ripple'
  r.style.left = ${x} + 'px'
  r.style.top = ${y} + 'px'
  document.body.appendChild(r)
  setTimeout(() => r.remove(), 650)
})()
`
}

// Move the visual cursor to a specific (clientX, clientY).
export function moveCursorTo(x: number, y: number): string {
  return `
(() => {
  const c = document.getElementById('__vs-cursor')
  if (c) {
    c.style.left = ${x} + 'px'
    c.style.top = ${y} + 'px'
  }
})()
`
}
