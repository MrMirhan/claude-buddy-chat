import { expect, mock, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import nacl from '../hooks/vendor/nacl.js'
import { ml_kem768 } from '../hooks/vendor/mlkem.js'

type KP = { publicKey: Uint8Array; secretKey: Uint8Array }
type Post = { url: string; body: string }
type World = { feed: string[]; posts: Post[]; notes: string[]; toasts: string[]; answer: { value: string }; clock: ReturnType<typeof mock.clock> }

const enc = (s: string) => new TextEncoder().encode(s)
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
function b64(bytes: Uint8Array) {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const unb64 = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0))
const idOf = (kp: KP) => b64(kp.publicKey)
const topicOf = (id: string) => 'https://ntfy.sh/buddy-chat-' + hex(nacl.hash(enc(id))).slice(0, 32)
const friend = (kp: KP, nickname?: string) =>
  ({ id: idOf(kp), state: 'friend', profile: { username: '', displayName: '' }, nickname, at: 0 })

function envelope(from: KP, to: string, payload: object, signer?: KP) {
  const nonce = nacl.randomBytes(24)
  const box = nacl.box(enc(JSON.stringify(payload)), nonce, unb64(to), (signer ?? from).secretKey)
  return JSON.stringify({ v: 3, from: idOf(from), nonce: b64(nonce), box: b64(box) })
}
function opened(post: Post | undefined, kp: KP) {
  if (!post) return null
  const env = JSON.parse(post.body)
  const plain = nacl.box.open(unb64(env.box), unb64(env.nonce), unb64(env.from), kp.secretKey)
  return plain ? JSON.parse(new TextDecoder().decode(plain)) : null
}
const to = (w: World, kp: KP) => w.posts.filter(p => p.url === topicOf(idOf(kp)))
const sent = (w: World, kp: KP) => to(w, kp).filter(p => !['kem', 'pq'].includes(opened(p, kp)?.t))

function setup(on: On, store: Record<string, unknown>, sessionId = 's1'): World {
  const w: World = { feed: [], posts: [], notes: [], toasts: [], answer: { value: 'Gönderme' }, clock: undefined as never }
  mock.store(on, store)
  w.clock = mock.clock(on, { now: 1_800_000_000_000 })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: sessionId }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: 'mcp__buddy-chat__' + e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.copy', () => ({ value: { isCopied: true } }))
  on('ui.toast', (_, e) => { w.toasts.push(String((e as { text?: string }).text ?? '')); return { value: undefined } as never })
  on('ui.notify', (_, e) => { w.notes.push(String((e as { text?: string }).text ?? JSON.stringify(e))); return { value: { isSent: true, channel: 'terminal' } } as never })
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const q = (e as unknown as { questions: { question: string }[] }).questions[0]?.question ?? ''
    return { result: { questions: [], answers: { [q]: w.answer.value } } } as never
  })
  let n = 0
  on('http.fetch', (_, e) => {
    if (e.init?.method === 'POST') {
      w.posts.push({ url: e.url, body: String(e.init.body) })
      return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
    }
    const lines = w.feed.splice(0).map(m => JSON.stringify({ id: 'ev' + n++, event: 'message', time: 1_800_000_000, message: m }))
    return { value: { status: 200, ok: true, headers: {}, text: lines.join('\n') } }
  })
  return w
}

// Opens a chat as the user would: a click on the Desktop row (a Client), a press on the terminal chip.
// Every mounted surface can find and press; terminal and Desktop drawings can also take pointer events.
type Opener = {
  find: (query: { key: string }) => Promise<{ type: string } | undefined>
  press: (target: { key: string }) => Promise<unknown>
}
type Pointer = { pointer: (event: { type: 'down' | 'up'; x: number; y: number; button: 'left'; in: string }) => Promise<void> }
async function openChat(ui: Opener, key: string) {
  const el = await ui.find({ key })
  // On a narrow surface with the chat already open, the list is not drawn and there is nothing to click.
  if (!el) return
  if (el.type === 'Client') {
    await (ui as unknown as Pointer).pointer({ type: 'down', x: 1, y: 0, button: 'left', in: key })
    await (ui as unknown as Pointer).pointer({ type: 'up', x: 1, y: 0, button: 'left', in: key })
  } else {
    await ui.press({ key })
  }
}

// The chat frame on Desktop: the Svg inside the Box keyed chat-frame, whose source is the messages' HTML.
async function frameSource(ui: { find: (q: never) => Promise<unknown> }): Promise<string> {
  const box = (await ui.find({ key: 'chat-frame' } as never)) as { children?: { type?: string; props?: { source?: string } }[] } | undefined
  return box?.children?.find(c => c.type === 'Svg')?.props?.source ?? ''
}

// Finds text on any surface: as a Text element, or on Desktop inside the chat frame's HTML.
async function shows(ui: { find: (q: never) => Promise<unknown> }, query: { type: 'Text'; text: RegExp }) {
  const found = (await ui.find(query as never)) as { text?: string } | undefined
  if (found) return found
  const source = await frameSource(ui)
  const inner = new RegExp(query.text.source.replace(/^\^/, '>').replace(/\$$/, '<'))
  const hit = inner.exec(source) ?? query.text.exec(source)
  return hit ? { text: hit[0].replace(/^>|<$/g, '') } : undefined
}

// Runs a /buddy command as the user typing it in the prompt box would.
const run = ($: Engine, command: string, args = '') =>
  $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

async function start($: Engine): Promise<string> {
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const r = await run($, 'buddy-id')
  return /(?:ID'n|ID): (\S{43})/.exec(r.text ?? '')?.[1] ?? ''
}

const list = async ($: Engine) => (await run($, 'buddy-list')).text ?? ''
const pane = (surface: 'terminal' | 'desktop') => ({
  plugin: 'buddy-chat', component: 'Pane', requestId: 'buddy-chat', surface,
  props: { title: 'Buddy chat', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
}) as const
const V4 = { version: 4, lang: 'tr' }

test('request, accept, profile and a local nickname that never leaves this machine', async ($, on) => {
  const w = setup(on, { ...V4, profile: { username: 'deniz', displayName: 'Deniz Kaya' } })
  const me = await start($)
  const ayse = nacl.box.keyPair()

  await run($, 'buddy-add', '/buddy-add ' + idOf(ayse))
  const req = opened(sent(w, ayse)[0], ayse)
  expect(req?.t).toBe('request')
  expect(req?.profile).toEqual({ username: 'deniz', displayName: 'Deniz Kaya' })
  expect(await list($)).toContain('Yanıt bekleyen')

  w.feed.push(envelope(ayse, me, { t: 'accept', id: 'a1', profile: { username: '@AYilmaz', displayName: 'Ayşe Yılmaz' } }))
  await w.clock.advance(8000)
  expect(await list($)).toContain('Ayşe Yılmaz · @ayilmaz')
  expect(w.notes.some(n => n.includes('kabul etti'))).toBe(true)

  const ui = await $.ui.mount(pane('desktop'))
  await ui.press({ key: 'tab-people' })
  await ui.press({ key: 'friend-nick-' + idOf(ayse) })
  await ui.input({ key: 'nick-' + idOf(ayse), text: 'Kanka' })
  await ui.press({ key: 'tab-chats' })
  await openChat(ui, 'conv-dm:' + idOf(ayse))
  expect((await shows(ui, { type: 'Text', text: /Artık arkadaşsınız/ }))).toBeDefined()
  await ui.unmount()
  expect(await list($)).toContain('Kanka · @ayilmaz · Ayşe Yılmaz')

  await run($, 'buddy-send', 'kanka selam kanka')
  await run($, 'buddy-send', '@ayilmaz ikinci')
  const texts = sent(w, ayse).slice(1).map(p => opened(p, ayse))
  expect(texts.map(p => p?.text)).toEqual(['selam kanka', 'ikinci'])
  expect(w.posts.some(p => JSON.stringify(opened(p, ayse)).includes('Kanka'))).toBe(false)
})

test('incoming request shows in Kişiler; dm before accept is dropped, after accept arrives', async ($, on) => {
  const w = setup(on, V4)
  const me = await start($)
  const ayse = nacl.box.keyPair()
  w.feed.push(
    envelope(ayse, me, { t: 'request', id: 'r1', profile: { username: 'ayse', displayName: 'Ayşe' } }),
    envelope(ayse, me, { t: 'dm', id: 'd0', name: 'Ayşe', text: 'erken mesaj' }),
  )
  await w.clock.advance(8000)
  expect(w.notes.some(n => n.includes('seni eklemek istiyor'))).toBe(true)

  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'tab-people' })
  expect(await shows(ui, { type: 'Text', text: /Arkadaşlık istekleri/ })).toBeDefined()
  await ui.press({ key: 'req-accept-' + idOf(ayse) })
  expect(opened(sent(w, ayse)[0], ayse)?.t).toBe('accept')

  w.feed.push(envelope(ayse, me, { t: 'dm', id: 'd1', name: 'Ayşe', text: 'artik geliyor' }))
  await w.clock.advance(8000)
  await ui.redraw()
  expect((await shows(ui, { type: 'Text', text: /artik geliyor/ }))?.text).toContain('artik geliyor')
  expect(await shows(ui, { type: 'Text', text: /erken mesaj/ })).toBeUndefined()
  await ui.unmount()
})

test('dm is end-to-end encrypted, forged and stranger messages are dropped, os notification fires', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  const mallory = nacl.box.keyPair()
  const w = setup(on, { ...V4, contacts: [friend(ahmet, 'Ahmet')] })
  const me = await start($)
  w.feed.push(
    envelope(ahmet, me, { t: 'dm', id: 'm1', name: 'A', text: 'gercek mesaj' }),
    envelope(ahmet, me, { t: 'dm', id: 'm2', name: 'A', text: 'sahte mesaj' }, mallory),
    envelope(mallory, me, { t: 'dm', id: 'm3', name: 'M', text: 'yabanci mesaj' }),
    'null',
  )
  await w.clock.advance(8000)
  expect(w.notes).toEqual(['gercek mesaj'])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(pane(surface))
    await openChat(ui, 'conv-dm:' + idOf(ahmet))
    expect((await shows(ui, { type: 'Text', text: /gercek mesaj/ }))).toBeDefined()
    expect(await shows(ui, { type: 'Text', text: /sahte|yabanci/ })).toBeUndefined()
    await ui.unmount()
  }

  await run($, 'buddy-send', 'ahmet gizli selam')
  expect(sent(w, ahmet)[0]?.body.includes('gizli')).toBe(false)
  expect(opened(sent(w, ahmet)[0], ahmet)?.text).toBe('gizli selam')
  expect(opened(sent(w, ahmet)[0], mallory)).toBeNull()
})

test('edit and delete: only the author can change a message, both directions', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  const veli = nacl.box.keyPair()
  const w = setup(on, { ...V4, contacts: [friend(ahmet, 'Ahmet'), friend(veli, 'Veli')] })
  const me = await start($)
  w.feed.push(
    envelope(ahmet, me, { t: 'dm', id: 'm1', name: 'A', text: 'ilk hali' }),
    envelope(veli, me, { t: 'edit', id: 'e0', ref: 'm1', text: 'veli bozdu' }),
    envelope(ahmet, me, { t: 'edit', id: 'e1', ref: 'm1', text: 'son hali' }),
  )
  await w.clock.advance(8000)

  const ui = await $.ui.mount(pane('desktop'))
  await openChat(ui, 'conv-dm:' + idOf(ahmet))
  expect(await shows(ui, { type: 'Text', text: /son hali/ })).not.toBeUndefined()
  expect(await shows(ui, { type: 'Text', text: /düzenlendi/ })).not.toBeUndefined()
  expect(await shows(ui, { type: 'Text', text: /veli bozdu/ })).toBeUndefined()

  w.feed.push(envelope(ahmet, me, { t: 'delete', id: 'x1', ref: 'm1' }))
  await w.clock.advance(8000)
  await ui.redraw()
  expect(await shows(ui, { type: 'Text', text: /Bu mesaj silindi/ })).toBeDefined()

  await ui.input({ key: 'compose-dm:' + idOf(ahmet), text: 'yazim hatsı' })
  const mine = opened(sent(w, ahmet)[0], ahmet)
  await ui.press({ key: 'edit-' + mine.id })
  await ui.input({ key: 'editing-' + mine.id, text: 'yazım hatası' })
  const edit = opened(sent(w, ahmet)[1], ahmet)
  expect(edit).toMatchObject({ t: 'edit', ref: mine.id, text: 'yazım hatası' })
  expect((await shows(ui, { type: 'Text', text: /yazım hatası/ }))).toBeDefined()

  w.answer.value = 'Sil'
  await ui.press({ key: 'del-' + mine.id })
  expect(opened(sent(w, ahmet)[2], ahmet)).toMatchObject({ t: 'delete', ref: mine.id })
  await ui.unmount()
})

test('block is silent and drops everything; unfriend notifies the other side', async ($, on) => {
  const spam = nacl.box.keyPair()
  const ali = nacl.box.keyPair()
  const w = setup(on, { ...V4, contacts: [friend(spam, 'Spam'), friend(ali, 'Ali')] })
  const me = await start($)

  w.answer.value = 'Engelle'
  const ui = await $.ui.mount(pane('desktop'))
  await ui.press({ key: 'tab-people' })
  await ui.press({ key: 'friend-block-' + idOf(spam) })
  expect(sent(w, spam).length).toBe(0)
  expect(await shows(ui, { type: 'Text', text: /Engellenenler \(?1/ })).toBeDefined()

  w.answer.value = 'Çıkar'
  await ui.press({ key: 'friend-remove-' + idOf(ali) })
  expect(opened(sent(w, ali)[0], ali)?.t).toBe('unfriend')
  await ui.unmount()

  w.feed.push(
    envelope(spam, me, { t: 'request', id: 'r9', profile: { username: 'spam', displayName: 'Spam' } }),
    envelope(spam, me, { t: 'dm', id: 'd9', name: 'Spam', text: 'engelli mesaj' }),
  )
  await w.clock.advance(8000)
  const text = await list($)
  expect(text).toContain('Arkadaşlar (0)')
  expect(text).not.toContain('Gelen istekler')
  expect(w.notes.length).toBe(0)
})

test('being unfriended removes the contact and notifies', async ($, on) => {
  const ali = nacl.box.keyPair()
  const w = setup(on, { ...V4, contacts: [friend(ali, 'Ali')] })
  const me = await start($)
  w.feed.push(envelope(ali, me, { t: 'unfriend', id: 'u1' }))
  await w.clock.advance(8000)
  expect(await list($)).toContain('Arkadaşlar (0)')
  expect(w.notes).toEqual(['Ali seni arkadaşlıktan çıkardı'])
})

test('group: invite from a friend, message from a non-friend member, send fans out', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  const zeynep = nacl.box.keyPair()
  const w = setup(on, { ...V4, contacts: [friend(ahmet, 'Ahmet')], profile: { username: '', displayName: 'Deniz' }, profileSent: JSON.stringify({ username: '', displayName: 'Deniz' }) })
  const me = await start($)
  const members = [{ id: idOf(ahmet), name: 'Ahmet' }, { id: me, name: 'Deniz' }, { id: idOf(zeynep), name: 'Zeynep' }]
  w.feed.push(
    envelope(ahmet, me, { t: 'invite', id: 'i1', g: '0123456789abcdef', title: 'Aile', name: 'Ahmet', members }),
    envelope(zeynep, me, { t: 'group', id: 'g1', g: '0123456789abcdef', name: 'Zeynep', text: 'grupta selam' }),
  )
  await w.clock.advance(8000)
  expect(await list($)).toContain('Aile · Ahmet, sen, Zeynep')

  const r = await run($, 'buddy-send', 'Aile herkese selam')
  expect(r.text).toBe('Gönderildi.')
  expect(opened(sent(w, zeynep)[0], zeynep)?.text).toBe('herkese selam')
  expect(opened(sent(w, ahmet)[0], ahmet)?.text).toBe('herkese selam')

  const ui = await $.ui.mount(pane('terminal'))
  await openChat(ui, 'conv-g:0123456789abcdef')
  expect((await shows(ui, { type: 'Text', text: /grupta selam/ }))).toBeDefined()
  await ui.unmount()
})

test('creating a group invites each picked friend with their own names, not nicknames', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  const veli = nacl.box.keyPair()
  const w = setup(on, {
    ...V4,
    contacts: [
      { ...friend(ahmet, 'Kanka'), profile: { username: 'ahmet', displayName: 'Ahmet Yılmaz' } },
      friend(veli, 'Veli'),
    ],
  })
  await start($)
  const ui = await $.ui.mount(pane('desktop'))
  await ui.press({ key: 'tab-people' })
  await ui.press({ key: 'pick-' + idOf(ahmet) })
  await ui.press({ key: 'pick-' + idOf(veli) })
  await ui.input({ key: 'group-title', text: 'Proje' })
  await ui.unmount()

  const invite = opened(sent(w, veli)[0], veli)
  expect(invite).toMatchObject({ t: 'invite', title: 'Proje' })
  expect(invite.members.map((m: { name: string }) => m.name)).toContain('Ahmet Yılmaz')
  expect(JSON.stringify(invite)).not.toContain('Kanka')
  expect(sent(w, ahmet).length).toBe(1)
})

test('send_to_buddy asks first: decline sends nothing, approve sends', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  const w = setup(on, { ...V4, contacts: [friend(ahmet, 'Ahmet')] })
  await start($)
  const declined = await $.tool.call({ tool: 'mcp__buddy-chat__send_to_buddy', to: 'Ahmet', text: 'gizli dosya' } as never)
  expect(JSON.stringify(declined)).toContain('onaylamadı')
  expect(sent(w, ahmet).length).toBe(0)
  w.answer.value = 'Gönder'
  await $.tool.call({ tool: 'mcp__buddy-chat__send_to_buddy', to: 'Ahmet', text: 'merhaba' } as never)
  expect(sent(w, ahmet).length).toBe(1)
})

test('a second session does not poll while another holds the poller', async ($, on) => {
  let gets = 0
  mock.store(on, { ...V4, poller: { session: 'other', at: 1_800_000_000_000 } })
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's2' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: 'mcp__buddy-chat__' + e.name } }))
  on('http.fetch', () => { gets++; return { value: { status: 200, ok: true, headers: {}, text: '' } } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(16000)
  expect(gets).toBe(0)
  await clock.advance(24000)
  expect(gets).toBeGreaterThan(0)
})

test('0.3 data migrates: friends keep their names as nicknames, keys survive', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  const sk = b64(nacl.box.keyPair().secretKey)
  setup(on, { version: 3, lang: 'tr', secretKey: sk, name: 'Deniz', friends: [{ name: 'Kanka', id: idOf(ahmet) }] })
  const me = await start($)
  expect(me).toBe(b64(nacl.box.keyPair.fromSecretKey(unb64(sk)).publicKey))
  const text = await list($)
  expect(text).toContain('Sen: Deniz')
  expect(text).toContain('Kanka')
})

test('0.2 data is cleared except the name, English is the default, and the empty pane draws on both surfaces', async ($, on) => {
  setup(on, { me: 'a'.repeat(48), friends: [{ name: 'Eski', id: 'b'.repeat(48) }], name: 'Deniz' })
  const me = await start($)
  expect(await list($)).toContain('Friends (0)')
  expect(await list($)).toContain('You: Deniz · ' + me)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect((await run($, 'buddy-id')).text).toContain(me)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(pane(surface))
    expect(['welcome', await shows(ui, { type: 'Text', text: /Welcome to Buddy chat/ })]).toEqual(['welcome', expect.anything()])
    await ui.press({ key: 'copy-line' })
    await ui.press({ key: 'tab-people' })
    expect(['people', await shows(ui, { type: 'Text', text: /Friends/ })]).toEqual(['people', expect.anything()])
    await ui.press({ key: 'tab-chats' })
    await ui.unmount()
  }
})

function hybridKey(friendKp: KP, meId: string, pq: Uint8Array) {
  const x = nacl.box.before(unb64(meId), friendKp.secretKey)
  const label = enc('buddy-chat hybrid v1')
  const input = new Uint8Array(x.length + pq.length + label.length)
  input.set(x); input.set(pq, x.length); input.set(label, x.length + pq.length)
  return nacl.hash(input).slice(0, 32)
}
function hybridEnvelope(from: KP, meId: string, pq: Uint8Array, payload: object) {
  const nonce = nacl.randomBytes(24)
  const box = nacl.secretbox(enc(JSON.stringify(payload)), nonce, hybridKey(from, meId, pq))
  return JSON.stringify({ v: 3, from: idOf(from), nonce: b64(nonce), box: b64(box), h: 1 })
}
function openHybrid(post: Post | undefined, friendKp: KP, meId: string, pq: Uint8Array) {
  if (!post) return null
  const env = JSON.parse(post.body)
  if (env.h !== 1) return null
  const plain = nacl.secretbox.open(unb64(env.box), unb64(env.nonce), hybridKey(friendKp, meId, pq))
  return plain ? JSON.parse(new TextDecoder().decode(plain)) : null
}
const payloads = (w: World, kp: KP) => to(w, kp).map(p => opened(p, kp)).filter(Boolean)

for (const order of ['smaller', 'larger'] as const) {
  test('post-quantum handshake when my id is ' + order + ': hybrid messages both ways, classic is refused', async ($, on) => {
    const sk = nacl.box.keyPair()
    const meId = idOf(sk)
    let friendKp = nacl.box.keyPair()
    while ((meId < idOf(friendKp)) !== (order === 'smaller')) friendKp = nacl.box.keyPair()
    const w = setup(on, { ...V4, secretKey: b64(sk.secretKey), contacts: [friend(friendKp, 'Ahmet')] })
    expect(await start($)).toBe(meId)
    await w.clock.settle()

    const myKem = payloads(w, friendKp).find(p => p.t === 'kem')?.kem
    expect(myKem).toBeDefined()
    let pq: Uint8Array
    if (order === 'smaller') {
      const theirs = ml_kem768.keygen()
      w.feed.push(envelope(friendKp, meId, { t: 'kem', id: 'k1', kem: b64(theirs.publicKey) }))
      await w.clock.advance(8000)
      const ct = payloads(w, friendKp).find(p => p.t === 'pq')?.ct
      pq = ml_kem768.decapsulate(unb64(ct), theirs.secretKey)
    } else {
      const encap = ml_kem768.encapsulate(unb64(myKem))
      pq = encap.sharedSecret
      w.feed.push(envelope(friendKp, meId, { t: 'pq', id: 'q1', ct: b64(encap.cipherText) }))
      await w.clock.advance(8000)
    }
    expect(await list($)).toContain('kuantuma dayanıklı')

    w.feed.push(
      hybridEnvelope(friendKp, meId, pq, { t: 'dm', id: 'h1', name: 'A', text: 'kuantum selam' }),
      envelope(friendKp, meId, { t: 'dm', id: 'c1', name: 'A', text: 'klasik mesaj' }),
    )
    await w.clock.advance(8000)
    const ui = await $.ui.mount(pane('desktop'))
    await openChat(ui, 'conv-dm:' + idOf(friendKp))
    expect(await shows(ui, { type: 'Text', text: /kuantum selam/ })).toBeDefined()
    expect(await shows(ui, { type: 'Text', text: /klasik mesaj/ })).toBeUndefined()
    await ui.unmount()

    await run($, 'buddy-send', 'Ahmet cevap')
    const last = to(w, friendKp).at(-1)
    expect(opened(last, friendKp)).toBeNull()
    expect(openHybrid(last, friendKp, meId, pq)?.text).toBe('cevap')
  })
}

test('desktop opens on the chat list with avatars and previews, terminal goes straight to the thread', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  const w = setup(on, { ...V4, contacts: [friend(ahmet, 'Ahmet Yılmaz')] })
  const me = await start($)
  w.feed.push(envelope(ahmet, me, { t: 'dm', id: 'p1', name: 'A', text: 'liste önizlemesi' }))
  await w.clock.advance(8000)

  const desk = await $.ui.mount(pane('desktop'))
  expect(['step1', await desk.find({ type: 'Svg' })]).toEqual(['step1', expect.anything()])
  expect(await desk.find({ key: 'back' })).toBeUndefined()
  expect((await desk.find({ type: 'Client', key: 'conv-dm:' + idOf(ahmet) }))).not.toBeUndefined()
  expect((await desk.find({ type: 'Text', text: /liste önizlemesi/, in: 'conv-dm:' + idOf(ahmet) }))?.props?.size).toBe('footnote')
  await openChat(desk, 'conv-dm:' + idOf(ahmet))
  expect(['step2', await desk.find({ key: 'back' })]).toEqual(['step2', expect.anything()])
  expect(['step3', await shows(desk, { type: 'Text', text: /kuantuma|PQ/ })]).toEqual(['step3', expect.anything()])
  await desk.press({ key: 'back' })
  expect(await desk.find({ key: 'back' })).toBeUndefined()
  await desk.unmount()

  const term = await $.ui.mount(pane('terminal'))
  expect(await term.find({ type: 'Svg' })).toBeUndefined()
  expect((await term.find({ key: 'tab-chats' }))?.props?.plain).toBe(true)
  expect(['step4', await shows(term, { type: 'Text', text: /liste önizlemesi/ })]).toEqual(['step4', expect.anything()])
  expect(['step5', await term.find({ key: 'compose-dm:' + idOf(ahmet) })]).toEqual(['step5', expect.anything()])
  await term.unmount()
})

test('mobile draws without text fields instead of being refused', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  setup(on, { ...V4, contacts: [friend(ahmet, 'Ahmet')] })
  await start($)
  const ui = await $.ui.mount({ ...pane('desktop'), surface: 'mobile' } as never)
  expect(['list', await ui.find({ key: 'tab-people' })]).toEqual(['list', expect.anything()])
  await openChat(ui, 'conv-dm:' + idOf(ahmet))
  expect(['thread', await shows(ui, { type: 'Text', text: /buddy-send/ })]).toEqual(['thread', expect.anything()])
  await ui.press({ key: 'back' })
  await ui.press({ key: 'tab-people' })
  expect(['people', await shows(ui, { type: 'Text', text: /buddy-add/ })]).toEqual(['people', expect.anything()])
  await ui.unmount()
})

test('the language switches between English and Turkish, and system lines follow it', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  const w = setup(on, { version: 4, contacts: [friend(ahmet, 'Ahmet')] })
  const me = await start($)
  w.feed.push(envelope(ahmet, me, { t: 'unfriend', id: 'u7' }))
  expect((await run($, 'buddy-id')).text).toContain('Your friend runs: /buddy-add ' + me)

  const r = await run($, 'buddy-lang', 'tr')
  expect(r.text).toBe('Dil: Türkçe')
  expect((await run($, 'buddy-id')).text).toContain('Arkadaşın şunu yazsın')
  expect((await run($, 'buddy-lang', 'xx')).text).toContain('/buddy-lang <en|tr>')

  const ui = await $.ui.mount(pane('desktop'))
  await ui.press({ key: 'tab-people' })
  expect(await shows(ui, { type: 'Text', text: /Arkadaşlar/ })).not.toBeUndefined()
  await ui.press({ key: 'lang-en' })
  expect(await shows(ui, { type: 'Text', text: /Friends/ })).not.toBeUndefined()
  await ui.unmount()

  await run($, 'buddy-lang', 'tr')
  expect(w.notes).toEqual([])
  await w.clock.advance(8000)
  expect(w.notes).toEqual(['Ahmet seni arkadaşlıktan çıkardı'])
})

test('onboarding: name form until a name is saved, then a summary with Edit; steps tick as they are done', async ($, on) => {
  const w = setup(on, { version: 4 })
  await start($)
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount(pane(surface))
    expect(await ui.find({ key: 'display-name' })).not.toBeUndefined()
    expect(await ui.find({ key: 'edit-profile' })).toBeUndefined()
    expect(await shows(ui, { type: 'Text', text: /^Buddy ID:$/ })).not.toBeUndefined()
    expect(await shows(ui, { type: 'Text', text: /X25519|ML-KEM/ })).toBeUndefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount(pane('desktop'))
  await ui.input({ key: 'display-name', text: 'Deniz Kaya' })
  expect(await ui.find({ key: 'display-name' })).toBeUndefined()
  expect(await ui.find({ key: 'edit-profile' })).not.toBeUndefined()
  expect(await shows(ui, { type: 'Text', text: /^Deniz Kaya$/ })).not.toBeUndefined()

  await ui.press({ key: 'copy-line' })
  expect((await shows(ui, { type: 'Text', text: /Share your add line/ }))).not.toBeUndefined()
  expect(await shows(ui, { type: 'Text', text: /^✓$/ })).not.toBeUndefined()

  await ui.press({ key: 'edit-profile' })
  expect(await ui.find({ key: 'username' })).not.toBeUndefined()
  await ui.press({ key: 'profile-done' })
  expect(await ui.find({ key: 'username' })).toBeUndefined()
  await ui.unmount()
  expect(w.posts.length).toBe(0)
})

test('a wide desktop pane: list beside home, a chat opens beside the list, sending clears the field, closing returns home', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  const veli = nacl.box.keyPair()
  const w = setup(on, { ...V4, contacts: [friend(ahmet, 'Ahmet'), friend(veli, 'Veli')] })
  const me = await start($)
  w.feed.push(envelope(ahmet, me, { t: 'dm', id: 'w1', name: 'A', text: 'geniş ekran mesajı' }))
  await w.clock.advance(8000)

  const wide = { ...pane('desktop'), props: { ...pane('desktop').props, bodyColumns: 140 } }
  const ui = await $.ui.mount(wide)
  expect(await ui.find({ key: 'conv-dm:' + idOf(ahmet) })).not.toBeUndefined()
  expect(await shows(ui, { type: 'Text', text: /^Buddy ID:$/ })).not.toBeUndefined()
  expect(await ui.find({ key: 'compose-dm:' + idOf(ahmet) })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^1$/, in: 'conv-dm:' + idOf(ahmet) })).not.toBeUndefined()

  await openChat(ui, 'conv-dm:' + idOf(ahmet))
  expect(await shows(ui, { type: 'Text', text: /^geniş ekran mesajı$/ })).not.toBeUndefined()
  // An open chat takes the whole pane, so it scrolls with the wheel; the list comes back with the back button.
  expect(await ui.find({ key: 'conv-dm:' + idOf(veli) })).toBeUndefined()
  await ui.input({ key: 'compose-dm:' + idOf(ahmet), text: 'cevap' })
  expect(await ui.find({ key: 'compose-dm:' + idOf(ahmet) })).toBeUndefined()
  expect(await ui.find({ key: 'compose-dm:' + idOf(ahmet) + '-1' })).not.toBeUndefined()

  await ui.press({ key: 'back' })
  expect(await shows(ui, { type: 'Text', text: /^Buddy ID:$/ })).not.toBeUndefined()
  expect(await ui.find({ key: 'conv-dm:' + idOf(veli) })).not.toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^1$/, in: 'conv-dm:' + idOf(ahmet) })).toBeUndefined()
  await ui.unmount()
})

test('a new session does not toast what is already stored; a new message toasts once', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  const old = { key: 'o1', conv: 'dm:' + idOf(ahmet), from: idOf(ahmet), name: 'A', text: 'eski mesaj', at: 1, mine: false }
  const w = setup(on, { ...V4, contacts: [friend(ahmet, 'Ahmet')], inbox: [old] })
  const toasts = w.toasts
  const me = await start($)
  await w.clock.advance(8000)
  expect(toasts).toEqual([])

  w.feed.push(envelope(ahmet, me, { t: 'dm', id: 'n1', name: 'A', text: 'yeni mesaj' }))
  await w.clock.advance(8000)
  await w.clock.advance(8000)
  expect(toasts).toEqual(['Ahmet: yeni mesaj'])
})

test('terminal: the text field does not grab the focus, and a write button with hotkey i is there', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  setup(on, { ...V4, contacts: [friend(ahmet, 'Ahmet')] })
  await start($)
  const ui = await $.ui.mount(pane('terminal'))
  const field = await ui.find({ key: 'compose-dm:' + idOf(ahmet) })
  expect(field?.props?.autoFocus).toBeUndefined()
  expect((await ui.find({ key: 'write' }))?.props?.hotkey).toBe('i')
  await ui.press({ key: 'write' })
  await ui.unmount()
})

test('terminal: a thread is in time order, holds what fits above the composer, pages, and follows the j/k mark', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  const conv = 'dm:' + idOf(ahmet)
  const msg = (key: string, text: string, at: number, mine: boolean) =>
    ({ key, conv, from: mine ? '' : idOf(ahmet), name: 'A', text, at, mine })
  const inbox = Array.from({ length: 35 }, (_, i) => msg('k' + i, 'mesaj ' + i, (i + 1) * 1000, i % 2 === 0))
  // Stored last, as a late batch leaves it, but it is the oldest message of all.
  inbox.push(msg('late', 'en eski cevap', 500, false))
  setup(on, { ...V4, contacts: [friend(ahmet, 'Ahmet')], inbox })
  await start($)

  const ui = await $.ui.mount(pane('terminal'))
  expect(await shows(ui, { type: 'Text', text: /^mesaj 34$/ })).not.toBeUndefined()
  expect(await shows(ui, { type: 'Text', text: /^en eski cevap$/ })).toBeUndefined()
  expect(await ui.find({ key: 'compose-' + conv })).not.toBeUndefined()
  const older = await ui.find({ key: 'older' })
  const hidden = Number(/(\d+)/.exec(older?.text ?? '')?.[1])
  expect(hidden).toBeGreaterThan(0)
  // Everything that is not hidden is drawn, and only that.
  expect(await ui.find({ type: 'Text', text: new RegExp('^mesaj ' + (hidden - 1) + '$') })).not.toBeUndefined()
  expect(await ui.find({ type: 'Text', text: new RegExp('^mesaj ' + (hidden - 2) + '$') })).toBeUndefined()

  await ui.press({ key: 'older' })
  expect(await shows(ui, { type: 'Text', text: /^mesaj 34$/ })).toBeUndefined()
  expect((await ui.find({ key: 'newer' }))?.text).toContain('8')
  await ui.press({ key: 'newer' })
  expect(await shows(ui, { type: 'Text', text: /^mesaj 34$/ })).not.toBeUndefined()

  // Walking the mark up past the window's top drags the window with it.
  for (let n = 0; n < 36 - hidden + 2; n++) await ui.press({ key: 'nav-up' })
  expect(await shows(ui, { type: 'Text', text: /^mesaj 34$/ })).toBeUndefined()
  expect(await shows(ui, { type: 'Text', text: /^[‹›]$/ })).not.toBeUndefined()
  await ui.unmount()
})

test('terminal: j/k mark messages, the marked one takes e/x/f, and People moved to p', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  const conv = 'dm:' + idOf(ahmet)
  const inbox = [
    { key: 'r1', conv, from: idOf(ahmet), name: 'A', text: 'gelen', at: 1000, mine: false },
    { key: 'm1', conv, from: '', name: 'me', text: 'giden', at: 2000, mine: true },
  ]
  setup(on, { ...V4, contacts: [friend(ahmet, 'Ahmet')], inbox })
  await start($)
  const ui = await $.ui.mount(pane('terminal'))
  expect((await ui.find({ key: 'tab-people' }))?.props?.hotkey).toBe('p')
  expect((await ui.find({ key: 'nav-up' }))?.props?.hotkey).toBe('k')
  expect(await shows(ui, { type: 'Text', text: /^[‹›]$/ })).toBeUndefined()

  await ui.press({ key: 'nav-up' })
  expect(await shows(ui, { type: 'Text', text: /^‹$/ })).not.toBeUndefined()
  expect((await ui.find({ key: 'edit-m1' }))?.props?.hotkey).toBe('e')
  expect((await ui.find({ key: 'del-m1' }))?.props?.hotkey).toBe('x')

  await ui.press({ key: 'nav-up' })
  expect(await shows(ui, { type: 'Text', text: /^›$/ })).not.toBeUndefined()
  expect((await ui.find({ key: 'fwd-r1' }))?.props?.hotkey).toBe('f')
  expect((await ui.find({ key: 'edit-m1' }))?.props?.hotkey).toBeUndefined()

  await ui.press({ key: 'nav-down' })
  await ui.press({ key: 'nav-down' })
  expect(await shows(ui, { type: 'Text', text: /^[‹›]$/ })).toBeUndefined()
  await ui.unmount()
})

test('desktop: the chat frame holds the newest 150 messages and loads 100 older ones at a time', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  const conv = 'dm:' + idOf(ahmet)
  const inbox = Array.from({ length: 200 }, (_, i) =>
    ({ key: 'p' + i, conv, from: idOf(ahmet), name: 'A', text: 'satır ' + i, at: (i + 1) * 1000, mine: false }))
  setup(on, { ...V4, contacts: [friend(ahmet, 'Ahmet')], inbox })
  await start($)
  const wide = { ...pane('desktop'), props: { ...pane('desktop').props, bodyColumns: 140 } }
  const ui = await $.ui.mount(wide)
  await openChat(ui, 'conv-' + conv)
  const box = await ui.find({ key: 'chat-frame' })
  const frame = (box?.children as { type?: string; props?: { isInteractive?: boolean } }[] | undefined)?.find(c => c.type === 'Svg')
  expect(frame?.props?.isInteractive).toBe(true)
  expect(await frameSource(ui)).toContain('overflow-y: auto')
  expect(await ui.find({ key: 'compose-' + conv })).not.toBeUndefined()
  expect(await shows(ui, { type: 'Text', text: /^satır 199$/ })).not.toBeUndefined()
  expect(await shows(ui, { type: 'Text', text: /^satır 50$/ })).not.toBeUndefined()
  expect(await shows(ui, { type: 'Text', text: /^satır 49$/ })).toBeUndefined()
  expect((await ui.find({ key: 'older' }))?.text).toContain('50')

  await ui.press({ key: 'older' })
  expect(await shows(ui, { type: 'Text', text: /^satır 0$/ })).not.toBeUndefined()
  expect(await ui.find({ key: 'older' })).toBeUndefined()
  await ui.unmount()
})

test('a wheel or arrow scroll over a chat pages its messages and holds the pane at the top', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  const conv = 'dm:' + idOf(ahmet)
  const inbox = Array.from({ length: 60 }, (_, i) =>
    ({ key: 'w' + i, conv, from: idOf(ahmet), name: 'A', text: 'teker ' + i, at: (i + 1) * 1000, mine: false }))
  const offsets: number[] = []
  on('ui.scroll', (_, e) => { offsets.push((e as { offset: number }).offset); return {} as never })
  setup(on, { ...V4, contacts: [friend(ahmet, 'Ahmet')], inbox })
  await start($)
  const ui = await $.ui.mount(pane('terminal'))
  expect(await shows(ui, { type: 'Text', text: /^teker 59$/ })).not.toBeUndefined()

  await $.ui.scroll({ component: 'Pane', requestId: 'buddy-chat', offset: 0, by: -3, bodyRows: 40, contentRows: 41, origin: { kind: 'person' } } as never)
  await ui.redraw()
  expect(offsets.at(-1)).toBe(0)
  expect(await shows(ui, { type: 'Text', text: /^teker 59$/ })).toBeUndefined()
  expect((await ui.find({ key: 'newer' }))?.text).toContain('3')
  await ui.unmount()
})

test('desktop frame: a buddy cannot inject markup, and long histories stay under the Svg size limit', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  const conv = 'dm:' + idOf(ahmet)
  const evil = `<img src="https://evil.example/t.png"><style>*{display:none}</style>"'&`
  const long = 'x'.repeat(3000)
  const inbox = [
    ...Array.from({ length: 150 }, (_, i) => ({ key: 'l' + i, conv, from: idOf(ahmet), name: 'A', text: long, at: (i + 1) * 1000, mine: false })),
    { key: 'evil', conv, from: idOf(ahmet), name: '<b>A</b>', text: evil, at: 999_999, mine: false },
  ]
  setup(on, { ...V4, contacts: [friend(ahmet, 'Ahmet')], inbox })
  await start($)
  const ui = await $.ui.mount(pane('desktop'))
  await openChat(ui, 'conv-' + conv)
  const source = await frameSource(ui)
  expect(source.length).toBeLessThan(131_072)
  expect(source).not.toContain('<img')
  expect(source).not.toContain('evil.example/t.png">')
  expect(source).toContain('&lt;img src=&quot;https://evil.example/t.png&quot;&gt;')
  expect((source.match(/<style>/g) ?? []).length).toBe(1)
  expect((await ui.find({ key: 'older' }))?.text).toBeDefined()
  await ui.unmount()
})
