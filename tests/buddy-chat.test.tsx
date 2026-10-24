import { expect, mock, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import nacl from '../hooks/vendor/nacl.js'
import { ml_kem768 } from '../hooks/vendor/mlkem.js'
import { backupKey, fromWords, keysFromEntropy, toWords } from '../hooks/recovery.js'

type KP = { publicKey: Uint8Array; secretKey: Uint8Array }
type Post = { url: string; body: string }
type World = { feed: string[]; linkFeed: string[]; uploads: Map<string, string>; statuses: string[]; sounds: string[]; notifySent: boolean; posts: Post[]; gets: number; opens: string[]; notes: string[]; toasts: string[]; answer: { value: string }; clock: ReturnType<typeof mock.clock> }

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
const sent = (w: World, kp: KP) => to(w, kp).filter(p => !['kem', 'pq', 'receipt', 'typing'].includes(opened(p, kp)?.t))

// spawn stands in for curl; without one the stream cannot start and the poller carries the test.
function setup(on: On, store: Record<string, unknown>, sessionId = 's1', spawn?: (e: { argv: string[] }) => AsyncGenerator<object>): World {
  const w: World = { feed: [], linkFeed: [], uploads: new Map(), statuses: [], sounds: [], notifySent: true, posts: [], gets: 0, opens: [], notes: [], toasts: [], answer: { value: 'Gönderme' }, clock: undefined as never }
  mock.store(on, store)
  w.clock = mock.clock(on, { now: 1_800_000_000_000 })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: sessionId }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: 'mcp__buddy-chat__' + e.name } }))
  on('ui.open', (_, e) => { w.opens.push((e as { id: string }).id); return { value: { isPlaced: true } } as never })
  on('ui.copy', () => ({ value: { isCopied: true } }))
  on('ui.status', (_, e) => { w.statuses.push(JSON.stringify(e)); return { value: undefined } as never })
  on('process.spawn', async function* (_: unknown, e: { argv: string[] }) {
    if (!spawn) throw new Error('no curl')
    yield* spawn(e)
  } as never)
  on('ui.toast', (_, e) => { w.toasts.push(String((e as { text?: string }).text ?? '')); return { value: undefined } as never })
  on('ui.notify', (_, e) => {
    w.notes.push(String((e as { text?: string }).text ?? JSON.stringify(e)))
    return { value: w.notifySent ? { isSent: true, channel: 'iterm2' } : { isSent: false, reason: 'no-surface' } } as never
  })
  on('audio.play', (_, e) => { w.sounds.push(JSON.stringify(e)); return { value: undefined } as never })
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
    if (e.init?.method === 'PUT') {
      const url = 'https://ntfy.sh/file/f' + w.uploads.size + '.txt'
      w.uploads.set(url, String(e.init.body))
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ attachment: { url } }) } }
    }
    if (e.url.startsWith('https://ntfy.sh/file/')) return { value: { status: 200, ok: true, headers: {}, text: w.uploads.get(e.url) ?? '' } }
    w.gets++
    const source = e.url.includes('buddy-chat-link-') ? w.linkFeed : w.feed
    const lines = source.splice(0).map(m => JSON.stringify({ id: 'ev' + n++, event: 'message', time: 1_800_000_000, message: m }))
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

// Finds a Text element by its text.
async function shows(ui: { find: (q: never) => Promise<unknown> }, query: { type: 'Text'; text: RegExp }) {
  return (await ui.find(query as never)) as { text?: string } | undefined
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
  const texts = sent(w, ayse).map(p => opened(p, ayse)).filter(p => p?.t === 'dm')
  expect(texts.map(p => p?.text)).toEqual(['selam kanka', 'ikinci'])
  // Accepted: my profile followed, so a name set after the request still reaches her.
  expect(sent(w, ayse).map(p => opened(p, ayse)).some(p => p?.t === 'profile')).toBe(true)
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
  await ui.press({ key: 'tab-chats' })
  await ui.press({ key: 'tab-settings' })
  await ui.press({ key: 'lang-en' })
  await ui.press({ key: 'tab-chats' })
  await ui.press({ key: 'tab-people' })
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

test('desktop: the chat shows what fits the pane, pages older messages and holds the pane on its rest row', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  const conv = 'dm:' + idOf(ahmet)
  const inbox = Array.from({ length: 200 }, (_, i) =>
    ({ key: 'p' + i, conv, from: idOf(ahmet), name: 'A', text: 'satır ' + i, at: (i + 1) * 1000, mine: false }))
  const offsets: number[] = []
  on('ui.scroll', (_, e) => { offsets.push((e as { offset: number }).offset); return {} as never })
  const w = setup(on, { ...V4, contacts: [friend(ahmet, 'Ahmet')], inbox })
  await start($)
  const wide = { ...pane('desktop'), props: { ...pane('desktop').props, bodyColumns: 140 } }
  const ui = await $.ui.mount(wide)
  await openChat(ui, 'conv-' + conv)
  expect(await ui.find({ key: 'chat-top' })).not.toBeUndefined()
  expect(await ui.find({ key: 'scroll-row-top' })).not.toBeUndefined()
  expect(await ui.find({ key: 'scroll-row' })).not.toBeUndefined()
  expect(await ui.find({ key: 'compose-' + conv })).not.toBeUndefined()
  expect(await shows(ui, { type: 'Text', text: /^satır 199$/ })).not.toBeUndefined()
  expect(await shows(ui, { type: 'Text', text: /^satır 100$/ })).toBeUndefined()

  // A tick counts as one row, and the messages move once the rows add up to a message.
  const tick = () => $.ui.scroll({ component: 'Pane', requestId: 'buddy-chat', offset: 0, by: -1, bodyRows: 40, contentRows: 42, origin: { kind: 'person' } } as never)
  await tick()
  await w.clock.advance(100)
  await ui.redraw()
  expect(offsets.at(-1)).toBe(1)
  expect(await shows(ui, { type: 'Text', text: /^satır 199$/ })).toBeDefined()
  // A burst of ticks is summed and moves the messages after a short pause, four at most; the rest follows.
  for (let i = 0; i < 12; i++) await tick()
  await ui.redraw()
  expect(await shows(ui, { type: 'Text', text: /^satır 199$/ })).toBeDefined()
  await w.clock.advance(90)
  await ui.redraw()
  expect(await shows(ui, { type: 'Text', text: /^satır 199$/ })).toBeUndefined()
  expect((await ui.find({ key: 'newer' }))?.text).toContain('4')
  await w.clock.advance(90)
  await ui.redraw()
  expect(Number(/\d+/.exec((await ui.find({ key: 'newer' }))?.text ?? '')?.[0])).toBeGreaterThan(4)

  for (let i = 0; i < 6 && await ui.find({ key: 'newer' }); i++) await ui.press({ key: 'newer' })
  expect(await shows(ui, { type: 'Text', text: /^satır 199$/ })).not.toBeUndefined()
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

test('desktop: long messages and markup stay text', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  const conv = 'dm:' + idOf(ahmet)
  const evil = `<img src="https://evil.example/t.png">`
  const inbox = [
    ...Array.from({ length: 150 }, (_, i) => ({ key: 'l' + i, conv, from: idOf(ahmet), name: 'A', text: 'x'.repeat(3000), at: (i + 1) * 1000, mine: false })),
    { key: 'evil', conv, from: idOf(ahmet), name: 'A', text: evil, at: 999_999, mine: false },
  ]
  setup(on, { ...V4, contacts: [friend(ahmet, 'Ahmet')], inbox })
  await start($)
  const ui = await $.ui.mount(pane('desktop'))
  await openChat(ui, 'conv-' + conv)
  expect((await shows(ui, { type: 'Text', text: /evil\.example/ }))?.text).toBe(evil)
  expect((await ui.find({ key: 'older' }))?.text).toBeDefined()
  await ui.unmount()
})

test('message states: sending then sent, delivered and read from receipts, read hidden while my receipts are off', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  const w = setup(on, { ...V4, contacts: [friend(ahmet, 'Ahmet')] })
  const me = await start($)
  const ui = await $.ui.mount(pane('desktop'))
  await openChat(ui, 'conv-dm:' + idOf(ahmet))
  await ui.input({ key: 'compose-dm:' + idOf(ahmet), text: 'merh', kind: 'change' })
  await ui.input({ key: 'compose-dm:' + idOf(ahmet), text: 'merha', kind: 'change' })
  expect(to(w, ahmet).filter(p => opened(p, ahmet)?.t === 'typing').length).toBe(1)
  await ui.input({ key: 'compose-dm:' + idOf(ahmet), text: 'merhaba' })
  const mine = opened(sent(w, ahmet).find(p => opened(p, ahmet)?.t === 'dm'), ahmet)
  expect(to(w, ahmet).some(p => opened(p, ahmet)?.t === 'typing')).toBe(true)
  await ui.redraw()
  expect(await shows(ui, { type: 'Text', text: /^ ✓$/ })).toBeDefined()

  w.feed.push(envelope(ahmet, me, { t: 'receipt', id: 'r1', kind: 'delivered', refs: [mine.id] }))
  await w.clock.advance(8000)
  await ui.redraw()
  expect((await shows(ui, { type: 'Text', text: /^ ✓✓$/ }) as { props?: { weight?: string } })?.props?.weight).toBeUndefined()

  // A stranger's receipt changes nothing; the friend's read receipt does.
  const stranger = nacl.box.keyPair()
  w.feed.push(envelope(stranger, me, { t: 'receipt', id: 'r2', kind: 'read', refs: [mine.id] }))
  w.feed.push(envelope(ahmet, me, { t: 'receipt', id: 'r3', kind: 'read', refs: [mine.id] }))
  await w.clock.advance(8000)
  await ui.redraw()
  expect((await shows(ui, { type: 'Text', text: /^ ✓✓$/ }) as { props?: { weight?: string } })?.props?.weight).toBe('bold')

  await ui.press({ key: 'back' })
  await ui.press({ key: 'tab-settings' })
  await ui.press({ key: 'toggle-read' })
  await ui.press({ key: 'tab-chats' })
  await openChat(ui, 'conv-dm:' + idOf(ahmet))
  expect((await shows(ui, { type: 'Text', text: /^ ✓✓$/ }) as { props?: { weight?: string } })?.props?.weight).toBeUndefined()
  await ui.unmount()
})

test('receipts out: delivered on arrival, read when the chat is drawn, no read receipt while turned off', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  const veli = nacl.box.keyPair()
  const w = setup(on, { ...V4, contacts: [friend(ahmet, 'Ahmet'), friend(veli, 'Veli')], privacy: { readReceipts: true, typing: true } })
  const me = await start($)
  w.feed.push(envelope(ahmet, me, { t: 'dm', id: 'aaaaaaaaaaaaaaa1', name: 'A', text: 'selam' }))
  w.feed.push(envelope(veli, me, { t: 'dm', id: 'bbbbbbbbbbbbbbb1', name: 'V', text: 'hey' }))
  await w.clock.advance(8000)
  const receipts = (kp: KP) => to(w, kp).map(p => opened(p, kp)).filter(p => p?.t === 'receipt')
  expect(receipts(ahmet)).toEqual([expect.objectContaining({ kind: 'delivered', refs: ['aaaaaaaaaaaaaaa1'] })])

  const ui = await $.ui.mount(pane('desktop'))
  await openChat(ui, 'conv-dm:' + idOf(ahmet))
  await w.clock.settle()
  expect(receipts(ahmet).at(-1)).toMatchObject({ kind: 'read', refs: ['aaaaaaaaaaaaaaa1'] })

  await ui.press({ key: 'back' })
  await ui.press({ key: 'tab-settings' })
  await ui.press({ key: 'toggle-read' })
  await ui.press({ key: 'tab-chats' })
  await openChat(ui, 'conv-dm:' + idOf(veli))
  await w.clock.settle()
  expect(receipts(veli).map(r => r.kind)).toEqual(['delivered'])
  await ui.unmount()
})

test('typing: shown when received, cleared by the message, ignored while turned off', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  const w = setup(on, { ...V4, contacts: [friend(ahmet, 'Ahmet')] })
  const me = await start($)
  const ui = await $.ui.mount(pane('desktop'))
  await openChat(ui, 'conv-dm:' + idOf(ahmet))

  w.feed.push(envelope(ahmet, me, { t: 'typing', id: 't1' }))
  await w.clock.advance(8000)
  await ui.redraw()
  expect(await shows(ui, { type: 'Text', text: /^yazıyor…$/ })).toBeDefined()

  w.feed.push(envelope(ahmet, me, { t: 'dm', id: 'ccccccccccccccc1', name: 'A', text: 'geldim' }))
  await w.clock.advance(8000)
  await ui.redraw()
  expect(await shows(ui, { type: 'Text', text: /^yazıyor…$/ })).toBeUndefined()

  await ui.press({ key: 'back' })
  await ui.press({ key: 'tab-settings' })
  await ui.press({ key: 'toggle-typing' })
  await ui.press({ key: 'tab-chats' })
  await openChat(ui, 'conv-dm:' + idOf(ahmet))
  w.feed.push(envelope(ahmet, me, { t: 'typing', id: 't2' }))
  await w.clock.advance(8000)
  await ui.redraw()
  expect(await shows(ui, { type: 'Text', text: /^yazıyor…$/ })).toBeUndefined()
  await ui.unmount()
})

test('copy: every message has a copy button', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  const w = setup(on, { ...V4, contacts: [friend(ahmet, 'Ahmet')] })
  const me = await start($)
  w.feed.push(envelope(ahmet, me, { t: 'dm', id: 'ddddddddddddddd1', name: 'A', text: 'kopyala beni' }))
  await w.clock.advance(8000)
  const ui = await $.ui.mount(pane('desktop'))
  await openChat(ui, 'conv-dm:' + idOf(ahmet))
  await ui.press({ key: 'copy-ddddddddddddddd1' })
  expect(w.toasts).toContain('Mesaj kopyalandı.')
  await ui.unmount()
})

test('stream: a message pushed down the held-open request arrives without a poll', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  const holder = { me: '', spawned: 0, argv: [] as string[] }
  const w = setup(on, { ...V4, contacts: [friend(ahmet, 'Ahmet')] }, 's1', async function* (e) {
    holder.spawned++
    holder.argv = e.argv
    yield { stream: 'stdout', text: JSON.stringify({ event: 'open' }) + '\n' }
    const line = JSON.stringify({ id: 's1', event: 'message', time: 1_800_000_000, message: envelope(ahmet, holder.me, { t: 'dm', id: 'eeeeeeeeeeeeeee1', name: 'A', text: 'anında' }) })
    yield { stream: 'stdout', text: line.slice(0, 40) }
    yield { stream: 'stdout', text: line.slice(40) + '\n' }
    await new Promise(() => {})
  })
  holder.me = await start($)
  await w.clock.advance(8000)
  await w.clock.settle()
  expect(holder.spawned).toBe(1)
  expect(holder.argv[0]).toBe('curl')
  const ui = await $.ui.mount(pane('desktop'))
  await openChat(ui, 'conv-dm:' + idOf(ahmet))
  expect(await shows(ui, { type: 'Text', text: /^anında$/ })).toBeDefined()
  const before = w.gets
  await w.clock.advance(16000)
  expect(w.gets).toBe(before)
  await ui.unmount()
})

test('notifications: a muted chat, the open chat and the global switch stay quiet', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  const veli = nacl.box.keyPair()
  const w = setup(on, { ...V4, contacts: [friend(ahmet, 'Ahmet'), friend(veli, 'Veli')] })
  const me = await start($)
  const ui = await $.ui.mount(pane('desktop'))

  await openChat(ui, 'conv-dm:' + idOf(ahmet))
  await ui.press({ key: 'mute' })
  await ui.press({ key: 'back' })
  w.feed.push(envelope(ahmet, me, { t: 'dm', id: 'fffffffffffffff1', name: 'A', text: 'sessiz' }))
  await w.clock.advance(8000)
  expect(w.notes.some(n => n.includes('sessiz'))).toBe(false)
  expect(w.toasts.some(n => n.includes('sessiz'))).toBe(false)

  await openChat(ui, 'conv-dm:' + idOf(veli))
  w.feed.push(envelope(veli, me, { t: 'dm', id: 'fffffffffffffff2', name: 'V', text: 'ekranda' }))
  await w.clock.advance(8000)
  expect(w.toasts.some(n => n.includes('ekranda'))).toBe(false)
  await ui.press({ key: 'back' })
  w.feed.push(envelope(veli, me, { t: 'dm', id: 'fffffffffffffff3', name: 'V', text: 'kapalıyken' }))
  await w.clock.advance(8000)
  expect(w.notes.some(n => n.includes('kapalıyken'))).toBe(true)

  await ui.press({ key: 'tab-settings' })
  await ui.press({ key: 'toggle-notify' })
  w.feed.push(envelope(veli, me, { t: 'dm', id: 'fffffffffffffff4', name: 'V', text: 'hiç' }))
  await w.clock.advance(8000)
  expect(w.notes.some(n => n.includes('hiç'))).toBe(false)
  expect(w.toasts.some(n => n.includes('hiç'))).toBe(false)
  await ui.unmount()
})

test('a pane left open opens again in the next session', async ($, on) => {
  const w = setup(on, { ...V4 })
  await start($)
  expect(w.opens).toEqual([])
  await run($, 'buddy')
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  expect(w.opens.length).toBe(2)
})

const linkKeyOf = (secret: Uint8Array) => nacl.hash(new Uint8Array([...secret, ...enc('buddy-chat link v1')])).slice(0, 32)
const linkTopicOf = (secret: Uint8Array) => 'https://ntfy.sh/buddy-chat-link-' + hex(nacl.hash(new Uint8Array([...secret, ...enc('buddy-chat link topic')]))).slice(0, 32)

test('resend: a message nobody confirmed goes out again after 11 hours, only to people who send receipts', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  const veli = nacl.box.keyPair()
  const mine = nacl.box.keyPair()
  const now = 1_800_000_000_000
  const inbox = [
    { key: 'a1a1a1a1a1a1a1a1', conv: 'dm:' + idOf(ahmet), from: idOf(mine), name: 'Ben', text: 'kayıp mı', at: now - 11.5 * 3_600_000, mine: true },
    { key: 'b1b1b1b1b1b1b1b1', conv: 'dm:' + idOf(veli), from: idOf(mine), name: 'Ben', text: 'eski sürüm', at: now - 11.5 * 3_600_000, mine: true },
  ]
  const w = setup(on, { ...V4, secretKey: b64(mine.secretKey), contacts: [{ ...friend(ahmet, 'Ahmet'), acks: true }, friend(veli, 'Veli')], inbox })
  await start($)
  await w.clock.advance(8000)
  const again = sent(w, ahmet).map(p => opened(p, ahmet)).filter(p => p?.t === 'dm')
  expect(again).toEqual([expect.objectContaining({ id: 'a1a1a1a1a1a1a1a1', text: 'kayıp mı' })])
  expect(sent(w, veli).length).toBe(0)
  await w.clock.advance(8000)
  expect(sent(w, ahmet).filter(p => opened(p, ahmet)?.t === 'dm').length).toBe(1)
})

test('link, old device: the code gets a sealed snapshot of the identity, contacts and messages', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  const mine = nacl.box.keyPair()
  const w = setup(on, { ...V4, secretKey: b64(mine.secretKey), contacts: [friend(ahmet, 'Ahmet')],
    inbox: [{ key: 'c1c1c1c1c1c1c1c1', conv: 'dm:' + idOf(ahmet), from: idOf(ahmet), name: 'A', text: 'merhaba', at: 1000, mine: false }] })
  await start($)
  const secret = nacl.randomBytes(32)
  w.answer.value = 'Bağla'
  const reply = await run($, 'buddy-link', 'buddylink-' + b64(secret))
  expect(reply.text).toContain('Gönderildi')
  const frames = w.posts.filter(p => p.url === linkTopicOf(secret)).map(p => JSON.parse(p.body))
  expect(frames.length).toBeGreaterThan(0)
  const bytes = frames.sort((a, b) => a.i - b.i).flatMap(f => [...nacl.secretbox.open(unb64(f.box), unb64(f.nonce), linkKeyOf(secret))!])
  const snap = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes)))
  expect(snap.secretKey).toBe(b64(mine.secretKey))
  expect(snap.contacts.map((c: { id: string }) => c.id)).toEqual([idOf(ahmet)])
  expect(snap.inbox.map((m: { text: string }) => m.text)).toEqual(['merhaba'])
  // Nothing readable goes to the relay.
  expect(w.posts.some(p => p.body.includes('merhaba'))).toBe(false)
  expect(w.statuses.at(-1)).toContain('bekleniyor')

  w.feed.push(envelope(mine, idOf(mine), { t: 'self', id: 'l1', dev: 'new-device', kind: 'linked' }))
  await w.clock.advance(8000)
  expect(w.toasts.some(t => t.includes('Yeni cihazın bağlandı'))).toBe(true)
})

test('link, new device: the snapshot replaces the identity and keeps the history quiet', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  const old = nacl.box.keyPair()
  const w = setup(on, { ...V4 })
  const before = await start($)
  const reply = await run($, 'buddy-link')
  const code = /buddylink-([A-Za-z0-9_-]{43})/.exec(reply.text ?? '')![1]!
  expect(w.statuses.at(-1)).toContain('bekleniyor')
  const secret = unb64(code)
  const snap = {
    v: 1, secretKey: b64(old.secretKey), kemSeed: b64(nacl.randomBytes(64)), lastSeen: 'ev7', lang: 'tr',
    contacts: [friend(ahmet, 'Ahmet')], groups: [], gone: {}, blocked: [], profile: { username: 'deniz', displayName: 'Deniz' },
    muted: [], privacy: { readReceipts: true, typing: true, notifications: true }, readAt: {}, at: {},
    inbox: [{ key: 'd1d1d1d1d1d1d1d1', conv: 'dm:' + idOf(ahmet), from: idOf(ahmet), name: 'A', text: 'eski mesaj', at: 1000, mine: false }],
  }
  const bytes = enc(JSON.stringify(snap))
  const n = Math.ceil(bytes.length / 300)
  for (let i = 0; i < n; i++) {
    const nonce = nacl.randomBytes(24)
    const box = nacl.secretbox(bytes.slice(i * 300, (i + 1) * 300), nonce, linkKeyOf(secret))
    w.linkFeed.push(JSON.stringify({ v: 1, set: 'x', i, n, nonce: b64(nonce), box: b64(box) }))
  }
  await w.clock.advance(8000)
  const after = /(?:ID'n|ID): (\S{43})/.exec((await run($, 'buddy-id')).text ?? '')?.[1]
  expect(after).toBe(idOf(old))
  expect(after).not.toBe(before)
  expect(await list($)).toContain('Ahmet')
  expect(w.toasts.some(t => t.includes('eski mesaj'))).toBe(false)
  expect(w.toasts.some(t => t.includes('hesabını kullanıyor'))).toBe(true)
  expect(w.statuses.some(x => x.includes('Bağlandı'))).toBe(true)
  // The old device hears that the new one took the account.
  const told = w.posts.filter(p => p.url === topicOf(idOf(old))).map(p => opened(p, old)).filter(p => p?.t === 'self')
  expect(told.some(p => p.kind === 'linked')).toBe(true)
})

test('linked devices: sent copies, missed-message requests and state from the primary', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  const mine = nacl.box.keyPair()
  const me = idOf(mine)
  const w = setup(on, { ...V4, secretKey: b64(mine.secretKey), linked: true, primary: false, activeAt: 1_800_000_000_000, contacts: [friend(ahmet, 'Ahmet')] })
  await start($)
  const self = (payload: object) => envelope(mine, me, { t: 'self', id: 's' + Math.random(), dev: 'other-device', ...payload })

  w.feed.push(self({ kind: 'sent', msg: { key: 'e1e1e1e1e1e1e1e1', conv: 'dm:' + idOf(ahmet), from: me, name: 'Ben', text: 'öbür cihazdan', at: 2000, mine: true } }))
  w.feed.push(self({ kind: 'state', primary: true, state: {
    contacts: [{ ...friend(ahmet, 'Kanka'), pq: b64(nacl.randomBytes(32)), changed: 5 }], groups: [], gone: {}, blocked: [],
    profile: { username: '', displayName: '' }, muted: [], privacy: { readReceipts: true, typing: true, notifications: true }, readAt: {}, at: {},
  } }))
  await w.clock.advance(8000)
  const ui = await $.ui.mount(pane('desktop'))
  await openChat(ui, 'conv-dm:' + idOf(ahmet))
  expect(await shows(ui, { type: 'Text', text: /^öbür cihazdan$/ })).toBeDefined()
  expect(await list($)).toContain('Kanka')
  expect(await list($)).toContain('kuantuma dayanıklı')
  await ui.unmount()

  // Another device asks for what it missed; this one answers with its messages, sealed for itself.
  w.feed.push(self({ kind: 'want', since: 0 }))
  await w.clock.advance(8000)
  const answers = w.posts.filter(p => p.url === topicOf(me)).map(p => opened(p, mine)).filter(p => p?.t === 'self')
  expect(answers.some(p => p.kind === 'have' || p.kind === 'part')).toBe(true)
})

test('a bare /buddy-link on a device with contacts explains the steps instead of starting over', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  const w = setup(on, { ...V4, contacts: [friend(ahmet, 'Ahmet')] })
  await start($)
  const reply = await run($, 'buddy-link')
  expect(reply.text).toContain('kodu bu cihaz alır')
  expect(w.posts.some(p => p.url.includes('buddy-chat-link-'))).toBe(false)
})

test('devices: the main device lists linked devices and removes one; a linked device can unlink itself', async ($, on) => {
  const mine = nacl.box.keyPair()
  const me = idOf(mine)
  const self = (payload: object) => envelope(mine, me, { t: 'self', id: 's' + Math.random(), ...payload })

  const w = setup(on, { ...V4, secretKey: b64(mine.secretKey), linked: true, primary: true, activeAt: 1_800_000_000_000 })
  await start($)
  w.feed.push(self({ dev: 'laptop-dev', kind: 'hello', name: 'laptop', primary: false }))
  await w.clock.advance(8000)
  const ui = await $.ui.mount(pane('desktop'))
  await ui.press({ key: 'tab-settings' })
  expect(await shows(ui, { type: 'Text', text: /^laptop/ })).toBeDefined()
  expect(await ui.find({ key: 'link-start' })).toBeUndefined()

  w.answer.value = 'Çıkar'
  await ui.press({ key: 'device-remove-laptop-dev' })
  const byes = w.posts.filter(p => p.url === topicOf(me)).map(p => opened(p, mine)).filter(p => p?.kind === 'bye')
  expect(byes.at(-1)).toMatchObject({ target: 'laptop-dev' })
  expect(await ui.find({ key: 'device-remove-laptop-dev' })).toBeUndefined()
  await ui.unmount()
})

test('devices: a linked device that unlinks deletes the account and starts over', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  const mine = nacl.box.keyPair()
  const w = setup(on, { ...V4, secretKey: b64(mine.secretKey), linked: true, primary: false, activeAt: 1_800_000_000_000, contacts: [friend(ahmet, 'Ahmet')] })
  const before = await start($)
  expect(before).toBe(idOf(mine))
  const ui = await $.ui.mount(pane('desktop'))
  await ui.press({ key: 'tab-settings' })
  w.answer.value = 'Ayır'
  await ui.press({ key: 'device-leave' })
  const byes = w.posts.filter(p => p.url === topicOf(idOf(mine))).map(p => opened(p, mine)).filter(p => p?.kind === 'bye')
  expect(byes.length).toBe(1)
  const after = /(?:ID'n|ID): (\S{43})/.exec((await run($, 'buddy-id')).text ?? '')?.[1]
  expect(after).not.toBe(before)
  expect(await list($)).not.toContain('Ahmet')
  await ui.unmount()
})

test('sound: auto chimes only when the notification was not shown; on always; off never', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  const w = setup(on, { ...V4, contacts: [friend(ahmet, 'Ahmet')] })
  const me = await start($)
  const say = async (id: string) => {
    w.feed.push(envelope(ahmet, me, { t: 'dm', id, name: 'A', text: 'ses ' + id }))
    await w.clock.advance(8000)
  }
  await say('a0a0a0a0a0a0a0a1')
  expect(w.sounds.length).toBe(0)
  w.notifySent = false
  await say('a0a0a0a0a0a0a0a2')
  expect(w.sounds.length).toBe(1)
  expect(w.sounds[0]).toContain('sounds/message.wav')

  const ui = await $.ui.mount(pane('desktop'))
  await ui.press({ key: 'tab-settings' })
  await ui.press({ key: 'toggle-sound' })
  w.notifySent = true
  await say('a0a0a0a0a0a0a0a3')
  expect(w.sounds.length).toBe(2)
  await ui.press({ key: 'toggle-sound' })
  w.notifySent = false
  await say('a0a0a0a0a0a0a0a4')
  expect(w.sounds.length).toBe(2)
  await ui.unmount()
})

test('history: messages past the store cap go to files and come back when scrolling past the top', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  const conv = 'dm:' + idOf(ahmet)
  const files = new Map<string, string>()
  on('env.get', (_, e) => ({ value: (e as { name: string }).name === 'HOME' ? '/home/test' : undefined }) as never)
  on('fs.write', (_, e) => { const { path, text } = e as { path: string; text: string }; files.set(path, text); return { value: undefined } as never })
  on('fs.list', (_, e) => {
    const dir = (e as { path: string }).path + '/'
    const names = [...files.keys()].filter(p => p.startsWith(dir)).map(p => p.slice(dir.length))
    return { value: names.map(name => ({ name, kind: 'file', size: 1, mtimeMs: 0, isLink: false })) } as never
  })
  on('fs.read', (_, e) => ({ value: files.get((e as { path: string }).path) ?? '' }) as never)

  const inbox = Array.from({ length: 300 }, (_, i) =>
    ({ key: 'h' + String(i).padStart(15, '0'), conv, from: idOf(ahmet), name: 'A', text: 'eski ' + i, at: (i + 1) * 1000, mine: false }))
  const w = setup(on, { ...V4, contacts: [friend(ahmet, 'Ahmet')], inbox })
  const me = await start($)
  for (let i = 0; i < 5; i++) w.feed.push(envelope(ahmet, me, { t: 'dm', id: 'f' + String(i).padStart(15, '0'), name: 'A', text: 'yeni ' + i }))
  await w.clock.advance(8000)

  expect(files.size).toBe(1)
  const [path, text] = [...files.entries()][0]!
  expect(path.startsWith('/home/test/.claude/buddy-chat/history/')).toBe(true)
  expect(JSON.parse(text).map((m: { text: string }) => m.text)).toEqual(Array.from({ length: 51 }, (_, i) => 'eski ' + i))

  const ui = await $.ui.mount(pane('desktop'))
  await openChat(ui, 'conv-' + conv)
  await ui.redraw()
  expect(await shows(ui, { type: 'Text', text: /^eski 0$/ })).toBeUndefined()
  for (let i = 0; i < 80 && !(await shows(ui, { type: 'Text', text: /^eski 0$/ })); i++) {
    await ui.press({ key: 'older' })
    await ui.redraw()
  }
  expect(await shows(ui, { type: 'Text', text: /^eski 0$/ })).toBeDefined()
  await ui.unmount()
})

// An in-memory file system and HOME for tests that read and write files.
function memoryFs(on: Parameters<typeof setup>[0], files: Map<string, string>) {
  on('env.get', (_, e) => ({ value: (e as { name: string }).name === 'HOME' ? '/home/test' : undefined }) as never)
  on('fs.write', (_, e) => { const { path, text } = e as { path: string; text: string }; files.set(path, text); return { value: undefined } as never })
  on('fs.read', (_, e) => {
    const text = files.get((e as { path: string }).path)
    if (text === undefined) throw new Error('missing')
    return { value: text } as never
  })
  on('fs.list', (_, e) => {
    const dir = (e as { path: string }).path + '/'
    const entries = new Map<string, string>()
    for (const p of files.keys()) {
      if (!p.startsWith(dir)) continue
      const rest = p.slice(dir.length)
      const slash = rest.indexOf('/')
      entries.set(slash < 0 ? rest : rest.slice(0, slash), slash < 0 ? 'file' : 'dir')
    }
    return { value: [...entries].map(([name, kind]) => ({ name, kind, size: 1, mtimeMs: 0, isLink: false })) } as never
  })
}

const wordsShown = async (ui: { findAll: (q: never) => Promise<{ text?: string }[]> }) =>
  (await ui.findAll({ type: 'Text', text: /^\s?\d+\. [a-z]+$/ } as never)).map(t => (t.text ?? '').trim().split(' ')[1]!)

test('recovery: a new identity has 12 words that make the same keys; an older one has 24', async ($, on) => {
  const w = setup(on, { ...V4 })
  const me = await start($)
  const ui = await $.ui.mount(pane('desktop'))
  await ui.press({ key: 'tab-settings' })
  w.answer.value = 'Göster'
  await ui.press({ key: 'words-show' })
  const words = await wordsShown(ui as never)
  expect(words.length).toBe(12)
  const entropy = fromWords(words.join(' '))!
  expect(b64(nacl.box.keyPair.fromSecretKey(keysFromEntropy(entropy).secretKey).publicKey)).toBe(me)
  // One wrong word fails the checksum or the list.
  expect(fromWords([...words.slice(0, 11), words[11] === 'zoo' ? 'abandon' : 'zoo'].join(' '))).toBeUndefined()
  await ui.unmount()
})

test('recovery: 24 words of an older identity hold its secret key', async ($, on) => {
  const mine = nacl.box.keyPair()
  const w = setup(on, { ...V4, secretKey: b64(mine.secretKey) })
  await start($)
  const ui = await $.ui.mount(pane('desktop'))
  await ui.press({ key: 'tab-settings' })
  w.answer.value = 'Göster'
  await ui.press({ key: 'words-show' })
  const words = await wordsShown(ui as never)
  expect(words.length).toBe(24)
  expect(b64(fromWords(words.join(' '))!)).toBe(b64(mine.secretKey))
  await ui.unmount()
})

test('recovery: restoring from words brings back the Buddy ID', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  const w = setup(on, { ...V4, contacts: [friend(ahmet, 'Ahmet')] })
  const before = await start($)
  const entropy = nacl.randomBytes(16)
  const expected = b64(nacl.box.keyPair.fromSecretKey(keysFromEntropy(entropy).secretKey).publicKey)
  const ui = await $.ui.mount(pane('desktop'))
  await ui.press({ key: 'tab-settings' })
  w.answer.value = 'Geri yükle'
  await ui.input({ key: 'restore-words', text: toWords(entropy).join(' ') })
  const after = /(?:ID'n|ID): (\S{43})/.exec((await run($, 'buddy-id')).text ?? '')?.[1]
  expect(after).toBe(expected)
  expect(after).not.toBe(before)
  expect(await list($)).not.toContain('Ahmet')
  await ui.unmount()
})

test('backup: written sealed to the chosen folder, and loaded back after a restore', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  const mine = nacl.box.keyPair()
  const files = new Map<string, string>()
  memoryFs(on, files)
  setup(on, { ...V4, secretKey: b64(mine.secretKey), contacts: [friend(ahmet, 'Ahmet')],
    inbox: [{ key: 'b2b2b2b2b2b2b2b2', conv: 'dm:' + idOf(ahmet), from: idOf(ahmet), name: 'A', text: 'yedekteki mesaj', at: 1000, mine: false }] })
  await start($)
  const reply = await run($, 'buddy-backup', '~/Backups/buddy')
  expect(reply.text).toContain('/home/test/Backups/buddy/')
  const [path, text] = [...files.entries()].find(([p]) => p.endsWith('account.backup'))!
  expect(text.includes('yedekteki mesaj')).toBe(false)
  const file = JSON.parse(text)
  const snap = JSON.parse(new TextDecoder().decode(nacl.secretbox.open(unb64(file.box), unb64(file.nonce), backupKey(mine.secretKey))!))
  expect(snap.contacts.map((c: { id: string }) => c.id)).toEqual([idOf(ahmet)])
  expect(path.startsWith('/home/test/Backups/buddy/buddy-chat-')).toBe(true)

  // Archived history goes into the backup too, sealed, a file at a time.
  const archived = [...files.keys()].find(p => p.includes('/.claude/buddy-chat/history/'))
  expect(archived).toBeUndefined()
  files.set('/home/test/.claude/buddy-chat/history/' + hex(nacl.hash(enc(idOf(mine)))).slice(0, 16) + '/c0nv/000000000001000-x.json', '[{"text":"arşivdeki"}]')
  await run($, 'buddy-backup', 'now')
  const copy = [...files.entries()].find(([p]) => p.includes('/history/c0nv/') && p.endsWith('.backup'))
  expect(copy).toBeDefined()
  expect(copy![1].includes('arşivdeki')).toBe(false)
})

test('backup: a restored identity loads its backup and stays the main device', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  const mine = nacl.box.keyPair()
  const files = new Map<string, string>()
  memoryFs(on, files)
  const snap = {
    v: 1, secretKey: b64(mine.secretKey), kemSeed: b64(nacl.randomBytes(64)), lastSeen: 'ev1', lang: 'tr',
    contacts: [friend(ahmet, 'Ahmet')], groups: [], gone: {}, blocked: [], profile: { username: 'deniz', displayName: 'Deniz' },
    muted: [], privacy: { readReceipts: true, typing: true, notifications: true, sound: 'auto' }, readAt: {}, at: {},
    inbox: [{ key: 'c3c3c3c3c3c3c3c3', conv: 'dm:' + idOf(ahmet), from: idOf(ahmet), name: 'A', text: 'geri geldi', at: 1000, mine: false }],
  }
  const nonce = nacl.randomBytes(24)
  const box = nacl.secretbox(enc(JSON.stringify(snap)), nonce, backupKey(mine.secretKey))
  files.set('/home/test/old/account.backup', JSON.stringify({ v: 1, kind: 'buddy-chat-backup', id: idOf(mine), nonce: b64(nonce), box: b64(box) }))
  const hNonce = nacl.randomBytes(24)
  const hBox = nacl.secretbox(enc('[{"text":"eski arşiv"}]'), hNonce, backupKey(mine.secretKey))
  files.set('/home/test/old/history/c0nv/000000000001000-x.backup', JSON.stringify({ v: 1, kind: 'buddy-chat-backup', id: idOf(mine), nonce: b64(hNonce), box: b64(hBox) }))
  const w = setup(on, { ...V4, secretKey: b64(mine.secretKey) })
  await start($)
  const reply = await run($, 'buddy-backup', 'load ~/old')
  expect(reply.text).toContain('1 dosyası')
  expect([...files.entries()].find(([p]) => p.endsWith('/history/' + hex(nacl.hash(enc(idOf(mine)))).slice(0, 16) + '/c0nv/000000000001000-x.json'))?.[1]).toBe('[{"text":"eski arşiv"}]')
  expect(reply.text).toContain('Yedek yüklendi')
  expect(await list($)).toContain('Ahmet')
  expect(w.toasts.some(t => t.includes('geri geldi'))).toBe(false)
  const other = nacl.box.keyPair()
  files.set('/home/test/other/account.backup', JSON.stringify({ v: 1, kind: 'buddy-chat-backup', id: idOf(other), nonce: b64(nonce), box: b64(box) }))
  expect((await run($, 'buddy-backup', 'load ~/other')).text).toContain('başka bir hesaba')
})

test('backup: the folder comes from the system dialog; without one a path field appears', async ($, on) => {
  const mine = nacl.box.keyPair()
  const files = new Map<string, string>()
  memoryFs(on, files)
  let dialog = true
  on('process.run', (_, e) => {
    const argv = (e as { argv: string[] }).argv
    if (argv[0] === 'osascript' && dialog) return { value: { exitCode: 0, stdout: '/Users/test/Yedek/\n', stderr: '' } } as never
    throw new Error('not found')
  })
  setup(on, { ...V4, secretKey: b64(mine.secretKey) })
  await start($)
  const ui = await $.ui.mount(pane('desktop'))
  await ui.press({ key: 'tab-settings' })
  expect(await ui.find({ key: 'backup-path' })).toBeUndefined()
  await ui.press({ key: 'backup-choose' })
  expect([...files.keys()].some(p => p.startsWith('/Users/test/Yedek/buddy-chat-') && p.endsWith('/account.backup'))).toBe(true)

  dialog = false
  await ui.press({ key: 'backup-load' })
  await ui.redraw()
  expect(await ui.find({ key: 'backup-path' })).toBeDefined()
  await ui.unmount()
})

test('no toast while the pane is shown; one when it is not', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  let shownPane = true
  on('ui.panes', () => ({ value: [{ id: 'buddy-chat', title: 'Buddy chat', isShown: shownPane, isFocused: false }] }) as never)
  const w = setup(on, { ...V4, contacts: [friend(ahmet, 'Ahmet')] })
  const me = await start($)
  w.feed.push(envelope(ahmet, me, { t: 'dm', id: 'd4d4d4d4d4d4d4d1', name: 'A', text: 'pane açık' }))
  await w.clock.advance(8000)
  expect(w.toasts.some(t => t.includes('pane açık'))).toBe(false)
  shownPane = false
  w.feed.push(envelope(ahmet, me, { t: 'dm', id: 'd4d4d4d4d4d4d4d2', name: 'A', text: 'pane kapalı' }))
  await w.clock.advance(8000)
  expect(w.toasts.some(t => t.includes('pane kapalı'))).toBe(true)
})

test('settings show the plugin version from plugin.json', async ($, on) => {
  on('fs.read', (_, e) => {
    if ((e as { path: string }).path.endsWith('/.claude-plugin/plugin.json')) return { value: '{"name":"buddy-chat","version":"9.8.7"}' } as never
    throw new Error('missing')
  })
  setup(on, { ...V4 })
  await start($)
  const ui = await $.ui.mount(pane('desktop'))
  await ui.press({ key: 'tab-settings' })
  expect(await shows(ui, { type: 'Text', text: /^buddy-chat 9\.8\.7$/ })).toBeDefined()
  await ui.unmount()
})

test('files: picked, size-checked, sealed on the relay, received, saved and opened', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  const disk = new Map<string, string>()
  const photo = nacl.randomBytes(1234)
  let picked = '/Users/test/foto.jpg'
  const opens: string[] = []
  const marks: string[] = []
  on('env.get', (_, e) => ({ value: (e as { name: string }).name === 'HOME' ? '/home/test' : undefined }) as never)
  on('fs.write', (_, e) => { const { path, text } = e as { path: string; text: string }; disk.set(path, text); return { value: undefined } as never })
  on('fs.stat', (_, e) => ({ value: { kind: 'file', size: (e as { path: string }).path.includes('big') ? 4_000_000 : photo.length, mtimeMs: 0, isLink: false } }) as never)
  on('fs.read', (_, e) => {
    if ((e as { path: string }).path === '/Users/test/foto.jpg') return { value: { base64: btoa(String.fromCharCode(...photo)) } } as never
    throw new Error('missing')
  })
  on('process.run', (_, e) => {
    const { argv, stdin } = e as { argv: string[]; stdin?: string }
    if (argv[0] === 'osascript') return { value: { exitCode: 0, stdout: picked + '\n', stderr: '' } } as never
    if (argv[0] === 'base64') { disk.set(argv[3]!, 'BYTES:' + stdin); return { value: { exitCode: 0, stdout: '', stderr: '' } } as never }
    if (argv[0] === 'open') { opens.push(argv.slice(1).join(' ')); return { value: { exitCode: 0, stdout: '', stderr: '' } } as never }
    if (argv[0] === 'xattr') { marks.push(argv[argv.length - 1]!); return { value: { exitCode: 0, stdout: '', stderr: '' } } as never }
    throw new Error('not found')
  })
  const w = setup(on, { ...V4, contacts: [friend(ahmet, 'Ahmet')] })
  const me = await start($)
  const ui = await $.ui.mount(pane('desktop'))
  await openChat(ui, 'conv-dm:' + idOf(ahmet))

  picked = '/Users/test/big.mov'
  await ui.press({ key: 'attach' })
  expect(w.toasts.at(-1)).toContain('3 MB')

  picked = '/Users/test/foto.jpg'
  await ui.press({ key: 'attach' })
  const msg = sent(w, ahmet).map(p => opened(p, ahmet)).find(p => p?.file)
  expect(msg.file).toMatchObject({ name: 'foto.jpg', mime: 'image/jpeg', size: photo.length })
  const stored = w.uploads.get(msg.file.url)!
  expect(stored.includes(btoa(String.fromCharCode(...photo.slice(0, 30))))).toBe(false)
  const back = nacl.secretbox.open(unb64(stored), unb64(msg.file.nonce), unb64(msg.file.key))!
  expect(b64(back)).toBe(b64(photo))

  // The other way: a friend's file arrives, is saved under Downloads and opens.
  w.feed.push(envelope(ahmet, me, { t: 'dm', id: 'e5e5e5e5e5e5e5e5', name: 'A', text: '📎 tatil.png', file: msg.file && { ...msg.file, name: 'tatil.png' } }))
  await w.clock.advance(8000)
  await w.clock.settle()
  const savedPath = [...disk.keys()].find(p => p.startsWith('/home/test/Downloads/buddy-chat/') && p.endsWith('tatil.png') && disk.get(p)!.startsWith('BYTES:'))
  expect(savedPath).toBeDefined()
  await ui.redraw()
  await ui.press({ key: 'file-open-e5e5e5e5e5e5e5e5' })
  expect(opens).toEqual([savedPath])
  expect(marks).toContain(savedPath)

  // A file that would run is shown in its folder, never opened.
  w.feed.push(envelope(ahmet, me, { t: 'dm', id: 'e6e6e6e6e6e6e6e6', name: 'A', text: '📎 kur.command', file: { ...msg.file, name: 'kur.command' } }))
  await w.clock.advance(8000)
  await w.clock.settle()
  await ui.redraw()
  expect(await ui.find({ key: 'file-open-e6e6e6e6e6e6e6e6' })).toBeUndefined()
  await ui.press({ key: 'file-show-e6e6e6e6e6e6e6e6' })
  expect(opens.at(-1)?.startsWith('-R ')).toBe(true)
  await ui.unmount()
})

test('desktop: the text field grows with what is typed, up to 6 rows, and shrinks after sending', async ($, on) => {
  const ahmet = nacl.box.keyPair()
  setup(on, { ...V4, contacts: [friend(ahmet, 'Ahmet')] })
  await start($)
  const ui = await $.ui.mount(pane('desktop'))
  await openChat(ui, 'conv-dm:' + idOf(ahmet))
  const field = async () => (await ui.find({ key: 'compose-dm:' + idOf(ahmet) }) ?? (await ui.findAll({ type: 'Input' } as never))[0]) as { props?: { rows?: number } }
  expect((await field())?.props?.rows).toBe(2)
  await ui.input({ key: 'compose-dm:' + idOf(ahmet), text: 'x'.repeat(150), kind: 'change' })
  expect((await field())?.props?.rows).toBe(4)
  await ui.input({ key: 'compose-dm:' + idOf(ahmet), text: 'x'.repeat(2000), kind: 'change' })
  expect((await field())?.props?.rows).toBe(6)
  await ui.input({ key: 'compose-dm:' + idOf(ahmet), text: 'gönder' })
  const fields = (await ui.findAll({ type: 'Input' } as never)) as { props?: { rows?: number } }[]
  expect(fields.some(f => f.props?.rows === 2)).toBe(true)
  await ui.unmount()
})
