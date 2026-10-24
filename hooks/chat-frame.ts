// Desktop draws an interactive Svg in a sandboxed frame with no script, where CSS still works.
// The messages go in that frame as HTML inside a foreignObject, in a box with overflow: auto, so the
// frame scrolls itself with the wheel and the trackpad while the header and the composer stay outside it.
// The list is laid out bottom-up (column-reverse), so the frame opens at the newest message.

export type FrameMessage = {
  key: string
  text: string
  name: string
  time: string
  mine: boolean
  system: boolean
  deleted: boolean
  edited: boolean
  forwarded: boolean
  // Shown above a message that starts a new day.
  day: string
  // A group message from someone else that starts a run: draw the sender's name.
  showName: boolean
  color: string
  marked: boolean
}

export type FrameLabels = { deleted: string; edited: string; forwarded: string }

const esc = (s: string) =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const STYLE = `
* { box-sizing: border-box; margin: 0; }
:root { color-scheme: light dark; --mine: #d97757; --mine-text: #fff; --theirs: rgba(142,142,147,.16);
  --text: #1f1f1f; --dim: rgba(60,60,67,.6); --mark: rgba(217,119,87,.55); }
@media (prefers-color-scheme: dark) {
  :root { --theirs: rgba(142,142,147,.2); --text: #ececec; --dim: rgba(235,235,245,.55); }
}
html, body { height: 100%; background: transparent; }
.scroll { height: 100%; overflow-y: auto; display: flex; flex-direction: column-reverse; padding: 8px 6px 4px;
  font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; color: var(--text); }
.list { display: flex; flex-direction: column; gap: 2px; }
.day { align-self: center; margin: 12px 0 8px; padding: 2px 10px; border-radius: 10px; background: var(--theirs);
  color: var(--dim); font-size: 12px; }
.sys { align-self: center; margin: 4px 0; color: var(--dim); font-size: 12px; font-style: italic; }
.row { display: flex; flex-direction: column; max-width: 78%; }
.row.start { margin-top: 8px; }
.row.mine { align-self: flex-end; align-items: flex-end; }
.row.theirs { align-self: flex-start; align-items: flex-start; }
.name { font-size: 12px; font-weight: 600; margin: 0 0 2px 10px; }
.bubble { padding: 6px 10px 4px; border-radius: 16px; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
.mine .bubble { background: var(--mine); color: var(--mine-text); border-bottom-right-radius: 4px; }
.theirs .bubble { background: var(--theirs); border-bottom-left-radius: 4px; }
.bubble.marked { box-shadow: 0 0 0 2px var(--mark); }
.meta { display: block; text-align: right; font-size: 11px; margin-top: 2px; opacity: .7; }
.deleted { font-style: italic; opacity: .75; }
.fwd { font-size: 11px; color: var(--dim); margin: 2px 6px 0; }
`

export function chatFrame(messages: readonly FrameMessage[], labels: FrameLabels): string {
  const items = messages.map(m => {
    const day = m.day ? `<div class="day">${esc(m.day)}</div>` : ''
    if (m.system) return day + `<div class="sys">${esc(m.text)}</div>`
    const side = m.mine ? 'mine' : 'theirs'
    const name = m.showName ? `<div class="name" style="color:${esc(m.color)}">${esc(m.name)}</div>` : ''
    const body = m.deleted ? `<span class="deleted">${esc(labels.deleted)}</span>` : esc(m.text)
    const meta = (m.edited ? esc(labels.edited) + ' · ' : '') + esc(m.time)
    const fwd = m.forwarded ? `<div class="fwd">${esc(labels.forwarded)}</div>` : ''
    return day + `<div class="row ${side}${m.showName || day ? ' start' : ''}">${name}` +
      `<div class="bubble${m.marked ? ' marked' : ''}">${body}<span class="meta">${meta}</span></div>${fwd}</div>`
  })
  // column-reverse scrolls from the bottom; the inner list keeps the messages in reading order.
  return '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">' +
    '<foreignObject x="0" y="0" width="100%" height="100%">' +
    `<div xmlns="http://www.w3.org/1999/xhtml" class="scroll"><style>${STYLE}</style>` +
    `<div class="list">${items.join('')}</div></div>` +
    '</foreignObject></svg>'
}
