import type { EngineInterface, Register, RenderChildren } from 'claude-code'
import nacl from './vendor/nacl.js'
import { ml_kem768 } from './vendor/mlkem.js'
import { LANGS, LANG_NAMES, isKey, isLang, translate, type Key, type Lang, type Vars } from './i18n.js'
import type { ChatRowProps } from './chat-row.tsx'

// buddy-chat
// No server of our own. Relay: ntfy.sh (free, no sign-up). Each person's inbox is a topic derived from their public key.
// ID = X25519 public key. Every message is sealed to its recipient with nacl.box: only the recipient can open it,
// and the sender is authenticated. A group message is sealed and sent to each member on its own.
// Friends run an ML-KEM-768 handshake; after it, the message key comes from both the X25519 and the ML-KEM
// secrets (hybrid, quantum-resistant).
// Nicknames stay on this machine and are never sent.
// Messages never reach Claude on their own: the user presses "↗" in the pane.

const RELAY = 'https://ntfy.sh'
const PANE = 'buddy-chat'
const WIRE_VERSION = 3
const STORE_VERSION = 4
// ntfy.sh gives each IP 60 requests, then adds one every 5 seconds; polling less often than that never runs dry.
const POLL_MS = 8000
const POLLER_STALE_MS = POLL_MS * 3
// The stream is one request ntfy holds open; curl ends it after this long and it opens again.
const STREAM_MAX_S = 900
const STREAM_RETRY_MS = 3000
// A typing signal goes out at most this often per chat; a received one shows for this long.
const TYPING_SEND_MS = 5000
const TYPING_SHOW_MS = 9000
const MSG_KEY_RE = /^[0-9a-f]{16}$/
const MAX_REFS = 60
const BACKOFF_MS = 60_000
// ntfy turns a body over 4096 bytes into an attachment, which the poller cannot read.
const MAX_BODY_BYTES = 3800
const MAX_GROUP = 8
const ID_RE = /^[A-Za-z0-9_-]{43}$/
const GROUP_RE = /^[0-9a-f]{16}$/
const USERNAME_RE = /^[a-z0-9_.]{2,24}$/

type Profile = { username: string; displayName: string }
// Off means neither side's: with read receipts off you send none and see none, as in WhatsApp.
// notifications covers toasts and OS notifications; a muted chat is silenced on its own.
type Privacy = { readReceipts: boolean; typing: boolean; notifications: boolean }
type Typing = { conv: string; from: string; until: number }
type ReceiptKind = 'delivered' | 'read'
type Contact = {
  id: string
  state: 'friend' | 'outgoing' | 'incoming'
  profile: Profile
  nickname?: string
  at: number
  pq?: string
  pqPrev?: string
}
type Member = { id: string; name: string }
type Group = { id: string; title: string; owner: string; members: Member[] }
type Sys = { key: Key; vars?: Vars }
type Msg = {
  key: string
  conv: string
  from: string
  name: string
  text: string
  at: number
  mine: boolean
  system?: boolean
  // System lines are stored as a translation key, so they follow the language the user picks later.
  sys?: Sys
  forwarded?: boolean
  edited?: boolean
  deleted?: boolean
  // Mine: 'sending' until ntfy has taken it; then the people it reached and the people who read it.
  state?: 'sending'
  deliveredTo?: string[]
  readBy?: string[]
  // Theirs: shown in an open chat, so its read receipt is sent (or, with receipts off, never will be).
  seen?: boolean
}
type Notice = { key: string; sys: Sys }
type Envelope = { v: number; from: string; nonce: string; box: string; h?: number }
type Payload =
  | { t: 'request' | 'accept' | 'profile'; id: string; profile: Profile }
  | { t: 'kem'; id: string; kem: string }
  | { t: 'pq'; id: string; ct: string }
  | { t: 'unfriend'; id: string }
  | { t: 'dm'; id: string; name: string; text: string }
  | { t: 'edit'; id: string; ref: string; text: string }
  | { t: 'delete'; id: string; ref: string }
  | { t: 'group'; id: string; g: string; name: string; text: string }
  | { t: 'invite'; id: string; g: string; title: string; name: string; members: Member[] }
  | { t: 'leave'; id: string; g: string; name: string }
  | { t: 'receipt'; id: string; kind: ReceiptKind; refs: string[] }
  | { t: 'typing'; id: string }
type Status = { state: 'ok' | 'limited' | 'error'; at: number }
type Conv = { id: string; title: string; isGroup: boolean; last: number; unread: number }
type PostError = { code: 'tooLong' | 'limited' | 'http' | 'net'; detail: string }
// sent: the message went out to at least one person, so the text field can be cleared.
type Outcome = { ok: boolean; text: string; sent?: boolean }

let keys: { publicKey: Uint8Array; secretKey: Uint8Array } | undefined
let kemKeys: { publicKey: Uint8Array; secretKey: Uint8Array } | undefined
let me = ''
let lang: Lang = 'en'
let profile: Profile = { username: '', displayName: '' }
let contacts: Contact[] = []
let blocked: string[] = []
let groups: Group[] = []
let inbox: Msg[] = []
let readAt: Record<string, number> = {}
let status: Status | undefined
let privacy: Privacy = { readReceipts: true, typing: true, notifications: true }
let muted: string[] = []
let typing: Typing[] = []
// Receipts wait here until the batch they arrived in is handled, then go out one post per person and kind.
const receiptQueue = new Map<string, Set<string>>()
const typingSentAt = new Map<string, number>()
// streaming: a stream loop runs; streamLive: ntfy has opened it, so the poller can rest. streamOff: no curl here.
let streaming = false
let streamLive = false
let streamOff = false
let view: 'chats' | 'people' = 'chats'
let selected = ''
let renaming = ''
let threadOpen = false
let editingProfile = false
let filter = ''
// Bumped after a send so the text field is drawn fresh and empty; a field keeps what was typed while its value stays the same.
let composeSeq = 0
let addSeq = 0
let groupSeq = 0
let pollerAt = 0
// Terminal: the message j/k marked; its actions take one key (e, x, f). Empty: no mark.
let cursor = ''
// The chat fills the pane's height with the composer at the bottom, so it pages instead of scrolling the pane.
// newerSkip is how many of the newest messages sit below the window (0 shows the newest); hiddenAbove, how many above it.
let newerSkip = 0
let hiddenAbove = 0
// Set while a chat is drawn: the ui.scroll hook then turns the scroll into paging.
let chatShown = false
const PAGE_STEP = 8
// Desktop scrolls a pane's body natively and raises ui.scroll only after a move, and only when the body has room
// to move. So the chat is drawn between two blank rows and held on the row under the top one: the wheel can always
// move it one row either way, and the hook pages the messages and puts the pane back.
// restOffset is that row (0 in the terminal, which has only the row below); restedFor, the chat already put there.
let restOffset = 0
let restedFor = ''
// Desktop: the wheel is summed in rows and the window moves a message once the rows add up to one, so a long
// message takes more wheel than a short one, as in a scrolled page. avgRows: the rows a message on screen takes.
let wheelRows = 0
let avgRows = 3
const WHEEL_ROWS = 3
let newestOpen = ''

const composeKey = (conv: string) => 'compose-' + conv + (composeSeq ? '-' + composeSeq : '')
let lineCopied = false
let editing = ''
let session = ''
let polling = false
let pauseUntil = 0
let signature = ''
const groupPick = new Set<string>()
const shown = new Set<string>()
const sharedKeys = new Map<string, Uint8Array>()
const hybridKeys = new Map<string, Uint8Array>()
const topics = new Map<string, string>()
// Handshake messages always use the classic box; everything else uses the hybrid key once there is one.
const HANDSHAKE = new Set(['request', 'accept', 'kem', 'pq'])

const t = (key: Key, vars?: Vars) => translate(lang, key, vars)
const encode = (s: string) => new TextEncoder().encode(s)
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
const newId = () => hex(nacl.randomBytes(8))
const shortId = (id: string) => id.slice(0, 6) + '…' + id.slice(-4)
const clock = (at: number) => new Date(at).toTimeString().slice(0, 5)
const convOf = (id: string) => 'dm:' + id
const groupConv = (id: string) => 'g:' + id
const friends = () => contacts.filter(c => c.state === 'friend')
const contactOf = (id: string) => contacts.find(c => c.id === id)
const isFriend = (id: string) => contactOf(id)?.state === 'friend'
const cleanUsername = (s: string) => {
  const u = s.trim().replace(/^@/, '').toLowerCase()
  return USERNAME_RE.test(u) ? u : ''
}
const cleanText = (s: string, max: number) => s.replace(/\s+/g, ' ').trim().slice(0, max)

function cleanProfile(value: unknown): Profile {
  const p = (value && typeof value === 'object' ? value : {}) as Partial<Profile>
  return { username: cleanUsername(String(p.username ?? '')), displayName: cleanText(String(p.displayName ?? ''), 40) }
}

// The name sent to others in groups and messages: the person's own profile, never our nickname for them.
const ownName = (p: Profile) => p.displayName || (p.username ? '@' + p.username : '')
const myPublicName = () => ownName(profile) || t('unnamed')

function nameOf(id: string, fallback = ''): string {
  if (id === me) return t('you')
  const c = contactOf(id)
  return c?.nickname || (c && ownName(c.profile)) || fallback || shortId(id)
}

const textOf = (m: Msg) => (m.sys && isKey(m.sys.key) ? t(m.sys.key, m.sys.vars) : m.text)

function b64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function unb64(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4))
  return Uint8Array.from(bin, c => c.charCodeAt(0))
}

function topicUrl(id: string): string {
  let topic = topics.get(id)
  if (!topic) {
    topic = 'buddy-chat-' + hex(nacl.hash(encode(id))).slice(0, 32)
    topics.set(id, topic)
  }
  return RELAY + '/' + topic
}

function sharedKey(id: string): Uint8Array {
  let key = sharedKeys.get(id)
  if (!key) {
    key = nacl.box.before(unb64(id), keys!.secretKey)
    sharedKeys.set(id, key)
  }
  return key
}

function validId(id: string): boolean {
  if (!ID_RE.test(id) || id === me) return false
  try {
    sharedKey(id)
    return true
  } catch {
    return false
  }
}

// The message key joins two secrets: if one breaks (X25519 to a quantum computer, ML-KEM to a bug), the other still holds.
function hybridKey(id: string, pq: string): Uint8Array {
  const cacheKey = id + ':' + pq
  let key = hybridKeys.get(cacheKey)
  if (!key) {
    const x = sharedKey(id)
    const q = unb64(pq)
    const label = encode('buddy-chat hybrid v1')
    const input = new Uint8Array(x.length + q.length + label.length)
    input.set(x)
    input.set(q, x.length)
    input.set(label, x.length + q.length)
    key = nacl.hash(input).slice(0, 32)
    hybridKeys.set(cacheKey, key)
  }
  return key
}

function seal(to: string, payload: Payload): string {
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const plain = encode(JSON.stringify(payload))
  const pq = HANDSHAKE.has(payload.t) ? undefined : contactOf(to)?.pq
  const box = pq ? nacl.secretbox(plain, nonce, hybridKey(to, pq)) : nacl.box.after(plain, nonce, sharedKey(to))
  return JSON.stringify({ v: WIRE_VERSION, from: me, nonce: b64(nonce), box: b64(box), ...(pq ? { h: 1 } : {}) })
}

function unseal(env: Envelope): { p: Payload; hybrid: boolean } | undefined {
  try {
    const box = unb64(env.box)
    const nonce = unb64(env.nonce)
    let plain: Uint8Array | null = null
    if (env.h === 1) {
      // While the key is being renewed, messages already on the way still open with the previous one.
      const c = contactOf(env.from)
      for (const pq of [c?.pq, c?.pqPrev]) if (pq && !plain) plain = nacl.secretbox.open(box, nonce, hybridKey(env.from, pq))
    } else {
      plain = nacl.box.open.after(box, nonce, sharedKey(env.from))
    }
    if (!plain) return undefined
    const p = JSON.parse(new TextDecoder().decode(plain))
    return p && typeof p === 'object' && typeof p.t === 'string' && typeof p.id === 'string' ? { p, hybrid: env.h === 1 } : undefined
  } catch {
    return undefined
  }
}

function parseEnvelope(message: string): Envelope | undefined {
  let env: Envelope
  try { env = JSON.parse(message) } catch { return undefined }
  if (!env || typeof env !== 'object' || env.v !== WIRE_VERSION) return undefined
  if (typeof env.from !== 'string' || !ID_RE.test(env.from) || env.from === me) return undefined
  return typeof env.nonce === 'string' && typeof env.box === 'string' ? env : undefined
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

// Every session on the machine shares $.store; each write reads the latest value first so it does not undo another session's write.
async function mutate<T>($: EngineInterface, key: string, fn: (current: T[]) => T[]): Promise<T[]> {
  const next = fn(asArray<T>(await $.store.get(key)))
  await $.store.set(key, next)
  return next
}

async function saveContact($: EngineInterface, contact: Contact) {
  contacts = await mutate<Contact>($, 'contacts', cur => [...cur.filter(c => c.id !== contact.id), contact])
}

async function dropContact($: EngineInterface, id: string) {
  contacts = await mutate<Contact>($, 'contacts', cur => cur.filter(c => c.id !== id))
  if (selected === convOf(id)) selected = ''
}

async function addMessages($: EngineInterface, msgs: Msg[]) {
  if (!msgs.length) return
  inbox = await mutate<Msg>($, 'inbox', current => {
    const seen = new Set(current.map(m => m.key))
    return [...current, ...msgs.filter(m => !seen.has(m.key))].slice(-300)
  })
}

async function patchMessage($: EngineInterface, key: string, from: string, patch: Partial<Msg>): Promise<boolean> {
  let hit = false
  inbox = await mutate<Msg>($, 'inbox', current =>
    current.map(m => {
      if (m.key !== key || m.from !== from || m.deleted) return m
      hit = true
      return { ...m, ...patch }
    }))
  return hit
}

const systemMsg = (key: string, conv: string, sys: Sys, at: number): Msg =>
  ({ key, conv, from: '', name: '', text: '', sys, at, mine: false, system: true })

function queueReceipt(to: string, kind: ReceiptKind, ref: string) {
  const k = kind + ':' + to
  receiptQueue.set(k, (receiptQueue.get(k) ?? new Set<string>()).add(ref))
}

async function flushReceipts($: EngineInterface) {
  const batches = [...receiptQueue]
  receiptQueue.clear()
  for (const [k, refs] of batches) {
    const at = k.indexOf(':')
    const kind = k.slice(0, at) as ReceiptKind
    const list = [...refs]
    for (let i = 0; i < list.length; i += MAX_REFS) await post($, k.slice(at + 1), { t: 'receipt', id: newId(), kind, refs: list.slice(i, i + MAX_REFS) })
  }
}

// A receipt counts only from someone the message went to; read implies delivered.
async function ackMessages($: EngineInterface, from: string, kind: ReceiptKind, refs: string[]) {
  const keys = new Set(refs)
  inbox = await mutate<Msg>($, 'inbox', current =>
    current.map(m => {
      if (!m.mine || !keys.has(m.key) || !recipients(m.conv).some(r => r.id === from)) return m
      const deliveredTo = m.deliveredTo?.includes(from) ? m.deliveredTo : [...(m.deliveredTo ?? []), from]
      const readBy = kind !== 'read' || m.readBy?.includes(from) ? m.readBy : [...(m.readBy ?? []), from]
      return { ...m, deliveredTo, readBy }
    }))
}

// until 0 clears the person's typing mark in that chat.
async function setTyping($: EngineInterface, conv: string, from: string, until: number) {
  const now = await $.clock.now()
  const had = typing.some(x => x.conv === conv && x.from === from && x.until > now)
  if (!until && !had) return
  typing = await mutate<Typing>($, 'typing', current => [
    ...current.filter(x => x.until > now && !(x.conv === conv && x.from === from)),
    ...(until > now ? [{ conv, from, until }] : []),
  ])
  $.ui.invalidate('ui.render')
  if (until > now) void $.clock.sleep(until - now + 100).then(() => $.ui.invalidate('ui.render')).catch(() => {})
}

// The open chat's new messages from others are read: their senders get one receipt each, unless receipts are off.
async function markRead($: EngineInterface, conv: string) {
  const unseen = inbox.filter(m => m.conv === conv && !m.mine && !m.system && !m.deleted && !m.seen)
  if (!unseen.length) return
  const keys = new Set(unseen.map(m => m.key))
  inbox = await mutate<Msg>($, 'inbox', current => current.map(m => (keys.has(m.key) ? { ...m, seen: true } : m)))
  if (!privacy.readReceipts) return
  for (const m of unseen) queueReceipt(m.from, 'read', m.key)
  await flushReceipts($)
}

async function sendTyping($: EngineInterface, conv: string, value: string) {
  // Direct chats only: a group would spend a post per member every few seconds of typing.
  if (!privacy.typing || !value.trim() || !conv.startsWith('dm:') || !isFriend(conv.slice(3))) return
  const now = await $.clock.now()
  if (now - (typingSentAt.get(conv) ?? 0) < TYPING_SEND_MS) return
  typingSentAt.set(conv, now)
  await post($, conv.slice(3), { t: 'typing', id: newId() })
}

async function toggleMute($: EngineInterface, conv: string) {
  muted = await mutate<string>($, 'muted', current => (current.includes(conv) ? current.filter(c => c !== conv) : [...current, conv]))
  $.ui.invalidate('ui.render')
}

async function setPrivacy($: EngineInterface, patch: Partial<Privacy>) {
  privacy = { ...privacy, ...patch }
  await $.store.set('privacy', privacy)
  if (!privacy.typing) typing = []
  $.ui.invalidate('ui.render')
}

// Only the polling session calls this, so each machine gets one OS notification.
const isOnScreen = (conv: string) => threadOpen && selected === conv

// conv: the chat it is about, so a muted chat stays quiet.
function notify($: EngineInterface, title: string, text: string, conv?: string) {
  if (!privacy.notifications || (conv && (muted.includes(conv) || isOnScreen(conv)))) return
  void $.ui.notify(text.slice(0, 200), { title }).catch(() => {})
}

// Events that belong to no chat; every session shows each one once as a toast.
async function addNotice($: EngineInterface, key: string, sys: Sys) {
  await mutate<Notice>($, 'notices', cur => [...cur.filter(n => n.key !== key), { key, sys }].slice(-20))
}

async function saveGroup($: EngineInterface, group: Group) {
  groups = await mutate<Group>($, 'groups', current => [...current.filter(g => g.id !== group.id), group])
}

async function dropGroup($: EngineInterface, id: string) {
  groups = await mutate<Group>($, 'groups', current => current.filter(g => g.id !== id))
  if (selected === groupConv(id)) selected = ''
}

function cleanMembers(value: unknown): Member[] {
  const seen = new Set<string>()
  return asArray<Member>(value)
    .filter(m => m && typeof m.id === 'string' && ID_RE.test(m.id) && !seen.has(m.id) && seen.add(m.id))
    .map(m => ({ id: m.id, name: cleanText(String(m.name ?? ''), 40) || shortId(m.id) }))
    .slice(0, MAX_GROUP)
}

async function receive($: EngineInterface, env: Envelope, at: number) {
  if (blocked.includes(env.from)) return
  const opened = unseal(env)
  if (!opened) return
  const { p, hybrid } = opened
  const c = contactOf(env.from)
  // Once the quantum-resistant key exists, classic-sealed content from that person is refused.
  if (c?.pq && !hybrid && !HANDSHAKE.has(p.t)) return

  switch (p.t) {
    case 'request': {
      const theirs = cleanProfile(p.profile)
      if (c && c.state !== 'incoming') {
        // We both added each other, or we are friends and they lost their data: accept and redo the ML-KEM handshake.
        await saveContact($, { ...c, state: 'friend', profile: theirs, pq: undefined, pqPrev: undefined })
        await post($, env.from, { t: 'accept', id: newId(), profile })
        await sendKem($, env.from)
        if (c.state === 'outgoing') {
          await addMessages($, [systemMsg(p.id, convOf(env.from), { key: 'sysFriends' }, at)])
          notify($, 'buddy-chat', t('notifyNowFriends', { name: nameOf(env.from) }))
        }
      } else {
        await saveContact($, { id: env.from, state: 'incoming', profile: theirs, nickname: c?.nickname, at })
        if (!c) notify($, 'buddy-chat', t('notifyWantsToAdd', { name: ownName(theirs) || shortId(env.from) }))
      }
      return
    }
    case 'accept':
      if (!c || c.state === 'incoming') return
      await saveContact($, { ...c, state: 'friend', profile: cleanProfile(p.profile) })
      if (c.state === 'outgoing') {
        await sendKem($, env.from)
        // The request carried the profile as it was then; the name may have been set since.
        if (ownName(profile)) await post($, env.from, { t: 'profile', id: newId(), profile })
        await addMessages($, [systemMsg(p.id, convOf(env.from), { key: 'sysFriends' }, at)])
        notify($, 'buddy-chat', t('notifyAccepted', { name: nameOf(env.from) }))
      }
      return
    case 'kem': {
      if (c?.state !== 'friend') return
      if (me < env.from) {
        // The side with the smaller ID always encapsulates, so two handshakes started at once still agree on one secret.
        let enc: { cipherText: Uint8Array; sharedSecret: Uint8Array }
        try { enc = ml_kem768.encapsulate(unb64(String(p.kem))) } catch { return }
        await saveContact($, { ...c, pq: b64(enc.sharedSecret), pqPrev: c.pq })
        await post($, env.from, { t: 'pq', id: newId(), ct: b64(enc.cipherText) })
      } else if (!c.pq) {
        await sendKem($, env.from)
      }
      return
    }
    case 'pq': {
      if (c?.state !== 'friend' || !(env.from < me)) return
      let secret: Uint8Array
      try { secret = ml_kem768.decapsulate(unb64(String(p.ct)), kemKeys!.secretKey) } catch { return }
      await saveContact($, { ...c, pq: b64(secret), pqPrev: c.pq })
      return
    }
    case 'profile':
      if (c?.state === 'friend' || c?.state === 'incoming') await saveContact($, { ...c, profile: cleanProfile(p.profile) })
      return
    case 'unfriend': {
      if (!c) return
      const name = nameOf(env.from, ownName(c.profile))
      await dropContact($, env.from)
      if (c.state === 'friend') {
        await addNotice($, p.id, { key: 'notifyUnfriended', vars: { name } })
        notify($, 'buddy-chat', t('notifyUnfriended', { name }))
      }
      return
    }
    case 'dm': {
      if (c?.state !== 'friend') return
      const text = String(p.text ?? '')
      await addMessages($, [{ key: p.id, conv: convOf(env.from), from: env.from, name: ownName(c.profile), text, at, mine: false }])
      queueReceipt(env.from, 'delivered', p.id)
      await setTyping($, convOf(env.from), env.from, 0)
      notify($, nameOf(env.from), text, convOf(env.from))
      return
    }
    case 'receipt': {
      const refs = asArray<unknown>(p.refs).filter((r): r is string => typeof r === 'string' && MSG_KEY_RE.test(r)).slice(0, MAX_REFS)
      if (refs.length && (p.kind === 'delivered' || p.kind === 'read')) await ackMessages($, env.from, p.kind, refs)
      return
    }
    case 'typing': {
      if (c?.state !== 'friend' || !privacy.typing) return
      const now = await $.clock.now()
      // A signal the poller brings in late is already over.
      if (now - at < TYPING_SHOW_MS) await setTyping($, convOf(env.from), env.from, now + TYPING_SHOW_MS)
      return
    }
    case 'edit':
      await patchMessage($, String(p.ref), env.from, { text: String(p.text ?? ''), edited: true })
      return
    case 'delete':
      await patchMessage($, String(p.ref), env.from, { text: '', deleted: true })
      return
  }

  if (typeof p.g !== 'string' || !GROUP_RE.test(p.g)) return
  const group = groups.find(g => g.id === p.g)

  if (p.t === 'invite') {
    if (c?.state !== 'friend') return
    if (group && group.owner !== env.from) return
    const name = nameOf(env.from)
    const members = cleanMembers(p.members)
    if (!members.some(m => m.id === me)) {
      if (group) {
        await dropGroup($, group.id)
        await addMessages($, [systemMsg(p.id, groupConv(p.g), { key: 'sysRemovedFromGroup', vars: { name } }, at)])
      }
      return
    }
    const title = cleanText(String(p.title ?? ''), 40) || t('groupFallbackTitle')
    await saveGroup($, { id: p.g, title, owner: env.from, members })
    const sys: Sys = group ? { key: 'sysGroupUpdated', vars: { name } } : { key: 'sysAddedToGroup', vars: { name, title } }
    await addMessages($, [systemMsg(p.id, groupConv(p.g), sys, at)])
    return
  }

  if (!group) return
  const member = group.members.find(m => m.id === env.from)
  if (!member) return
  if (p.t === 'group') {
    const text = String(p.text ?? '')
    await addMessages($, [{ key: p.id, conv: groupConv(group.id), from: env.from, name: member.name, text, at, mine: false }])
    queueReceipt(env.from, 'delivered', p.id)
    notify($, '# ' + group.title, nameOf(env.from, member.name) + ': ' + text, groupConv(group.id))
  } else if (p.t === 'leave') {
    await saveGroup($, { ...group, members: group.members.filter(m => m.id !== env.from) })
    await addMessages($, [systemMsg(p.id, groupConv(group.id), { key: 'sysLeftGroup', vars: { name: nameOf(env.from, member.name) } }, at)])
  }
}

// quiet: on session start, what is already stored counts as seen, so a new session does not toast old messages.
async function refresh($: EngineInterface, quiet = false) {
  const savedLang = await $.store.get('lang')
  lang = isLang(savedLang) ? savedLang : 'en'
  profile = cleanProfile(await $.store.get('profile'))
  contacts = asArray<Contact>(await $.store.get('contacts'))
  blocked = asArray<string>(await $.store.get('blocked'))
  groups = asArray<Group>(await $.store.get('groups'))
  inbox = asArray<Msg>(await $.store.get('inbox'))
  const savedRead = await $.store.get('readAt')
  readAt = savedRead && typeof savedRead === 'object' ? (savedRead as Record<string, number>) : {}
  status = (await $.store.get('status')) as Status | undefined
  const savedPrivacy = (await $.store.get('privacy')) as Partial<Privacy> | undefined
  privacy = {
    readReceipts: savedPrivacy?.readReceipts !== false,
    typing: savedPrivacy?.typing !== false,
    notifications: savedPrivacy?.notifications !== false,
  }
  muted = asArray<string>(await $.store.get('muted'))
  typing = privacy.typing ? asArray<Typing>(await $.store.get('typing')) : []
  pollerAt = ((await $.store.get('poller')) as { at?: number } | undefined)?.at ?? 0
  if (selected && !conversations().some(c => c.id === selected)) selected = ''

  for (const m of inbox) {
    if (shown.has(m.key)) continue
    shown.add(m.key)
    // A toast over an open chat would cover its composer and repeat what is already on screen.
    if (quiet || m.mine || m.deleted || !privacy.notifications || muted.includes(m.conv) || isOnScreen(m.conv)) continue
    const group = groups.find(g => groupConv(g.id) === m.conv)
    $.ui.toast((group ? group.title + ' · ' : '') + (m.system ? textOf(m) : nameOf(m.from, m.name) + ': ' + m.text).slice(0, 90))
  }
  for (const c of contacts) {
    if (c.state !== 'incoming' || shown.has('req:' + c.id)) continue
    shown.add('req:' + c.id)
    if (!quiet && privacy.notifications) $.ui.toast(t('notifyWantsToAdd', { name: ownName(c.profile) || shortId(c.id) }))
  }
  for (const n of asArray<Notice>(await $.store.get('notices'))) {
    if (shown.has('notice:' + n.key)) continue
    shown.add('notice:' + n.key)
    if (!quiet && privacy.notifications && n.sys && isKey(n.sys.key)) $.ui.toast(t(n.sys.key, n.sys.vars))
  }

  const next = JSON.stringify([
    lang, profile, contacts, blocked, groups, status?.state, privacy, typing, muted,
    inbox.map(m => [m.key, m.text.length, m.forwarded, m.edited, m.deleted, m.state, m.deliveredTo?.length, m.readBy?.length]),
  ])
  if (next !== signature) {
    signature = next
    $.ui.invalidate('ui.render')
  }
  // A new message in the open chat brings it to the bottom, unless the user loaded older pages to read.
  const newest = inbox.filter(m => m.conv === selected).reduce((a, m) => (m.at >= a.at ? m : a), { key: '', at: -1 } as { key: string; at: number }).key
  if (newest !== newestOpen) {
    const moved = !!newestOpen
    newestOpen = newest
    if (moved && threadOpen && newerSkip === 0) scrollToRest($)
  }
}

async function setStatus($: EngineInterface, state: Status['state']) {
  if (status?.state === state) return
  status = { state, at: await $.clock.now() }
  await $.store.set('status', status)
}

// With several sessions open on one machine, only one polls; the others read the store.
async function claimPoller($: EngineInterface, now: number): Promise<boolean> {
  const current = (await $.store.get('poller')) as { session: string; at: number } | undefined
  if (current && current.session !== session && now - current.at < POLLER_STALE_MS) return false
  await $.store.set('poller', { session, at: now })
  return true
}

async function poll($: EngineInterface) {
  const savedLast = await $.store.get('lastSeen')
  const since = typeof savedLast === 'string' && savedLast ? savedLast : '12h'
  let res
  try {
    res = await $.http.fetch(topicUrl(me) + '/json?poll=1&since=' + encodeURIComponent(since))
  } catch {
    await setStatus($, 'error')
    return
  }
  if (res.status === 429) {
    pauseUntil = (await $.clock.now()) + BACKOFF_MS
    await setStatus($, 'limited')
    return
  }
  if (!res.ok) {
    await setStatus($, 'error')
    return
  }
  await setStatus($, 'ok')

  let last = since
  for (const line of res.text.split('\n')) last = (await handleLine($, line)) ?? last
  if (last !== since) await $.store.set('lastSeen', last)
  await flushReceipts($)
}

// One line of ntfy's JSON feed, from a poll or the stream. Resolves to the message's id, the place to resume from.
async function handleLine($: EngineInterface, line: string): Promise<string | undefined> {
  if (!line.trim()) return undefined
  let ev: { id?: string; event?: string; time?: number; message?: string }
  try { ev = JSON.parse(line) } catch { return undefined }
  if (ev?.event === 'open' || ev?.event === 'keepalive') {
    streamLive = true
    await setStatus($, 'ok')
    return undefined
  }
  if (!ev || ev.event !== 'message' || !ev.id || !ev.message) return undefined
  const env = parseEnvelope(ev.message)
  if (env) await receive($, env, (ev.time ?? 0) * 1000)
  return ev.id
}

// ntfy pushes each message down one held-open request the moment it is posted. $.http.fetch returns only a
// finished body, so curl holds the request; where curl cannot start, the poller carries on alone.
async function runStream($: EngineInterface) {
  streaming = true
  let failures = 0
  try {
    while (failures < 3) {
      const current = (await $.store.get('poller')) as { session?: string } | undefined
      if (current?.session !== session) break
      const savedLast = await $.store.get('lastSeen')
      const since = typeof savedLast === 'string' && savedLast ? savedLast : '12h'
      const url = topicUrl(me) + '/json?since=' + encodeURIComponent(since)
      let buffer = ''
      streamLive = false
      for await (const piece of $.process.spawn({ argv: ['curl', '-sSN', '--max-time', String(STREAM_MAX_S), url] })) {
        if (!('text' in piece) || piece.stream !== 'stdout') continue
        buffer += piece.text
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        await serial(async () => {
          for (const line of lines) {
            const id = await handleLine($, line)
            if (id) await $.store.set('lastSeen', id)
          }
          await flushReceipts($)
          await refresh($)
        })
      }
      failures = streamLive ? 0 : failures + 1
      streamLive = false
      await $.clock.sleep(STREAM_RETRY_MS)
    }
  } catch {
    streamOff = true
  } finally {
    streaming = false
    streamLive = false
  }
}

// The stream and the timer both read and write the store; one at a time keeps their reads and writes apart.
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => {})
  return run
}

async function tick($: EngineInterface) {
  if (polling) return
  polling = true
  try {
    await serial(async () => {
      await refresh($)
      const now = await $.clock.now()
      if (!(await claimPoller($, now))) return
      if (!streaming && !streamOff) void runStream($)
      if (!streamLive && now >= pauseUntil) {
        await poll($)
        await refresh($)
      }
    })
  } catch {
    // tries again on the next tick
  } finally {
    polling = false
  }
}

async function sendKem($: EngineInterface, id: string) {
  await post($, id, { t: 'kem', id: newId(), kem: b64(kemKeys!.publicKey) })
}

async function post($: EngineInterface, to: string, payload: Payload): Promise<PostError | undefined> {
  const body = seal(to, payload)
  if (encode(body).length > MAX_BODY_BYTES) return { code: 'tooLong', detail: '' }
  try {
    const res = await $.http.fetch(topicUrl(to), { method: 'POST', body })
    if (res.status === 429) return { code: 'limited', detail: '' }
    if (!res.ok) return { code: 'http', detail: String(res.status) }
  } catch (err) {
    return { code: 'net', detail: String(err) }
  }
  return undefined
}

function errorText(err: PostError): string {
  switch (err.code) {
    case 'tooLong': return t('errTooLong')
    case 'limited': return t('errLimited')
    case 'http': return t('errHttp', { status: err.detail })
    case 'net': return t('errNet', { detail: err.detail })
  }
}

// The other side of a chat: the friend in a direct chat, the members who are not blocked in a group.
function recipients(conv: string): Member[] {
  if (conv.startsWith('dm:')) {
    const id = conv.slice(3)
    return isFriend(id) ? [{ id, name: nameOf(id) }] : []
  }
  const group = groups.find(g => groupConv(g.id) === conv)
  return (group?.members ?? []).filter(m => m.id !== me && !blocked.includes(m.id)).map(m => ({ id: m.id, name: nameOf(m.id, m.name) }))
}

// Resolves to a failure (nothing went out), or to the names it did not reach (empty when it reached everyone).
async function fanOut($: EngineInterface, conv: string, make: () => Payload): Promise<{ error?: string; missed: string[] }> {
  const targets = recipients(conv)
  if (!targets.length) return { error: t('errNoRecipients'), missed: [] }
  const missed: string[] = []
  for (const m of targets) {
    const err = await post($, m.id, make())
    if (err?.code === 'tooLong') return { error: errorText(err), missed: [] }
    if (err) missed.push(m.name)
  }
  if (missed.length === targets.length) return { error: t('errNobody'), missed }
  return { missed }
}

const partialText = (missed: string[]) => t('partial', { names: missed.join(', ') })

function conversations(): Conv[] {
  const last = new Map<string, number>()
  for (const m of inbox) last.set(m.conv, Math.max(last.get(m.conv) ?? 0, m.at))
  const unread = (conv: string) =>
    conv === selected && threadOpen ? 0 : inbox.filter(m => m.conv === conv && !m.mine && !m.system && !m.deleted && m.at > (readAt[conv] ?? 0)).length
  return [
    ...friends().map(f => ({ id: convOf(f.id), title: nameOf(f.id), isGroup: false })),
    ...groups.map(g => ({ id: groupConv(g.id), title: g.title, isGroup: true })),
  ]
    .map(c => ({ ...c, last: last.get(c.id) ?? 0, unread: unread(c.id) }))
    .sort((a, b) => b.last - a.last || a.title.localeCompare(b.title))
}

// Finds a person by nickname, display name or @username.
function aliases(conv: Conv): string[] {
  if (conv.isGroup) return [conv.title]
  const c = contactOf(conv.id.slice(3))
  return [conv.title, c?.profile.displayName ?? '', c?.profile.username ? '@' + c.profile.username : '', c?.profile.username ?? '']
    .filter(Boolean)
}

function matchConv(text: string): { conv: Conv; rest: string } | undefined {
  const lower = text.trim().toLowerCase()
  let best: { conv: Conv; rest: string; len: number } | undefined
  for (const conv of conversations()) {
    for (const alias of aliases(conv)) {
      const a = alias.toLowerCase()
      if ((lower === a || lower.startsWith(a + ' ')) && (!best || a.length > best.len)) {
        best = { conv, rest: text.trim().slice(a.length).trim(), len: a.length }
      }
    }
  }
  return best && { conv: best.conv, rest: best.rest }
}

async function sendText($: EngineInterface, conv: string, text: string): Promise<Outcome> {
  if (!text.trim()) return { ok: false, text: t('emptyMessage') }
  if (!recipients(conv).length) return { ok: false, text: t('errNoRecipients') }
  const id = newId()
  const group = groups.find(g => groupConv(g.id) === conv)
  shown.add(id)
  typingSentAt.delete(conv)
  await addMessages($, [{ key: id, conv, from: me, name: myPublicName(), text, at: await $.clock.now(), mine: true, state: 'sending' }])
  newerSkip = 0
  $.ui.invalidate('ui.render')
  scrollToRest($)
  const result = await fanOut($, conv, () =>
    group ? { t: 'group', id, g: group.id, name: myPublicName(), text } : { t: 'dm', id, name: myPublicName(), text })
  if (result.error) {
    inbox = await mutate<Msg>($, 'inbox', current => current.filter(m => m.key !== id))
    $.ui.invalidate('ui.render')
    return { ok: false, text: result.error }
  }
  await patchMessage($, id, me, { state: undefined })
  $.ui.invalidate('ui.render')
  return result.missed.length ? { ok: false, text: partialText(result.missed), sent: true } : { ok: true, text: t('sent'), sent: true }
}

async function editMessage($: EngineInterface, msg: Msg, text: string): Promise<Outcome> {
  if (!text.trim()) return { ok: false, text: t('editEmpty') }
  if (text === msg.text) return { ok: false, text: t('noChange') }
  const result = await fanOut($, msg.conv, () => ({ t: 'edit', id: newId(), ref: msg.key, text }))
  if (result.error) return { ok: false, text: result.error }
  await patchMessage($, msg.key, me, { text, edited: true })
  $.ui.invalidate('ui.render')
  return result.missed.length ? { ok: false, text: partialText(result.missed) } : { ok: true, text: t('editedOk') }
}

async function deleteMessage($: EngineInterface, msg: Msg): Promise<Outcome> {
  const result = await fanOut($, msg.conv, () => ({ t: 'delete', id: newId(), ref: msg.key }))
  if (result.error) return { ok: false, text: result.error }
  await patchMessage($, msg.key, me, { text: '', deleted: true })
  $.ui.invalidate('ui.render')
  return result.missed.length ? { ok: false, text: partialText(result.missed) } : { ok: true, text: t('deletedOk') }
}

async function confirm($: EngineInterface, question: string, yes: string): Promise<boolean> {
  try {
    return (await $.ui.ask(question, [yes, t('answerCancel')])) === yes
  } catch {
    return false
  }
}

async function addContact($: EngineInterface, id: string, nickname = ''): Promise<string> {
  if (!validId(id)) return id === me ? t('ownId') : t('badId')
  if (blocked.includes(id)) blocked = await mutate<string>($, 'blocked', cur => cur.filter(b => b !== id))
  const c = contactOf(id)
  const nick = cleanText(nickname, 40) || c?.nickname
  if (c?.state === 'friend') {
    if (nick !== c.nickname) await saveContact($, { ...c, nickname: nick })
    return t('alreadyFriend', { name: nameOf(id) })
  }
  if (c?.state === 'incoming') return acceptContact($, id, nick)

  await saveContact($, { id, state: 'outgoing', profile: c?.profile ?? { username: '', displayName: '' }, nickname: nick, at: await $.clock.now() })
  const err = await post($, id, { t: 'request', id: newId(), profile })
  $.ui.invalidate('ui.render')
  return err ? t('requestFailed', { error: errorText(err) }) : t('requestSent')
}

async function acceptContact($: EngineInterface, id: string, nickname?: string): Promise<string> {
  const c = contactOf(id)
  if (!c) return t('requestNotFound')
  await saveContact($, { ...c, state: 'friend', nickname: nickname ?? c.nickname })
  const err = await post($, id, { t: 'accept', id: newId(), profile })
  if (!err) await sendKem($, id)
  await addMessages($, [systemMsg(newId(), convOf(id), { key: 'sysFriends' }, await $.clock.now())])
  selected = convOf(id)
  view = 'chats'
  threadOpen = true
  $.ui.invalidate('ui.render')
  return err ? t('acceptedNoNotice', { error: errorText(err) }) : t('nowFriend', { name: nameOf(id) })
}

async function unfriend($: EngineInterface, id: string) {
  if (isFriend(id)) await post($, id, { t: 'unfriend', id: newId() })
  await dropContact($, id)
  $.ui.invalidate('ui.render')
}

// Blocking is silent: the other side is not told; their messages and requests are dropped here.
async function block($: EngineInterface, id: string) {
  blocked = await mutate<string>($, 'blocked', cur => [...cur.filter(b => b !== id), id])
  await dropContact($, id)
  $.ui.invalidate('ui.render')
}

async function unblock($: EngineInterface, id: string) {
  blocked = await mutate<string>($, 'blocked', cur => cur.filter(b => b !== id))
  $.ui.invalidate('ui.render')
}

async function setNickname($: EngineInterface, id: string, nickname: string) {
  const c = contactOf(id)
  if (!c) return
  await saveContact($, { ...c, nickname: cleanText(nickname, 40) || undefined })
  $.ui.invalidate('ui.render')
}

async function setProfile($: EngineInterface, patch: Partial<Profile>): Promise<string> {
  profile = cleanProfile({ ...profile, ...patch })
  await $.store.set('profile', profile)
  await broadcastProfile($)
  $.ui.invalidate('ui.render')
  return t('profileSaved', { name: myPublicName(), username: profile.username ? ' (@' + profile.username + ')' : '' })
}

async function setLang($: EngineInterface, next: Lang): Promise<string> {
  lang = next
  await $.store.set('lang', lang)
  $.ui.invalidate('ui.render')
  return t('langSet')
}

async function broadcastProfile($: EngineInterface) {
  const sent = JSON.stringify(profile)
  if (!ownName(profile) || (await $.store.get('profileSent')) === sent) return
  await $.store.set('profileSent', sent)
  // People we asked get it too, so a request sent before the name was set does not stay nameless.
  const to = contacts.filter(c => c.state === 'friend' || c.state === 'outgoing')
  for (const c of to) await post($, c.id, { t: 'profile', id: newId(), profile })
}

async function sendInvites($: EngineInterface, group: Group): Promise<string[]> {
  const failed: string[] = []
  for (const m of group.members) {
    if (m.id === me) continue
    const err = await post($, m.id, { t: 'invite', id: newId(), g: group.id, title: group.title, name: myPublicName(), members: group.members })
    if (err) failed.push(nameOf(m.id, m.name))
  }
  return failed
}

const memberOf = (id: string): Member => ({ id, name: id === me ? myPublicName() : ownName(contactOf(id)?.profile ?? profile) || shortId(id) })

async function createGroup($: EngineInterface, rawTitle: string, memberIds: string[]): Promise<string> {
  const title = cleanText(rawTitle, 40)
  if (!title) return t('groupNameEmpty')
  const picked = friends().filter(f => memberIds.includes(f.id))
  if (!picked.length) return t('pickOne')
  if (picked.length + 1 > MAX_GROUP) return t('groupMax', { max: MAX_GROUP })

  const group: Group = { id: newId(), title, owner: me, members: [memberOf(me), ...picked.map(f => memberOf(f.id))] }
  await saveGroup($, group)
  const failed = await sendInvites($, group)
  const names = picked.map(f => nameOf(f.id)).join(', ')
  await addMessages($, [systemMsg(newId(), groupConv(group.id), { key: 'sysGroupCreated', vars: { names } }, await $.clock.now())])
  selected = groupConv(group.id)
  view = 'chats'
  threadOpen = true
  groupPick.clear()
  $.ui.invalidate('ui.render')
  return t('groupCreated', { title }) + (failed.length ? t('invitesFailed', { names: failed.join(', ') }) : '')
}

async function addToGroup($: EngineInterface, group: Group, id: string): Promise<string> {
  if (group.members.length >= MAX_GROUP) return t('groupFull')
  const updated = { ...group, members: [...group.members, memberOf(id)] }
  await saveGroup($, updated)
  const failed = await sendInvites($, updated)
  await addMessages($, [systemMsg(newId(), groupConv(group.id), { key: 'sysMemberAdded', vars: { name: nameOf(id) } }, await $.clock.now())])
  $.ui.invalidate('ui.render')
  return failed.length ? t('updateFailed', { names: failed.join(', ') }) : t('memberAdded', { name: nameOf(id) })
}

async function leaveGroup($: EngineInterface, group: Group) {
  for (const m of group.members) {
    if (m.id !== me) await post($, m.id, { t: 'leave', id: newId(), g: group.id, name: myPublicName() })
  }
  await dropGroup($, group.id)
  $.ui.invalidate('ui.render')
}

async function select($: EngineInterface, conv: string) {
  const now = await $.clock.now()
  const marks = { ...readAt, [conv]: now }
  if (selected) marks[selected] = now
  readAt = marks
  selected = conv
  editing = ''
  newerSkip = 0
  cursor = ''
  view = 'chats'
  threadOpen = true
  restedFor = ''
  await $.store.set('readAt', readAt)
  $.ui.invalidate('ui.render')
}

// Puts the pane on the chat's first row, so the header shows at the top and the composer at the bottom.
const scrollToRest = ($: EngineInterface) => {
  void $.ui.scroll({ to: { key: 'chat-top' }, in: PANE, block: 'start' }).catch(() => {})
}

// Moves the message window: a positive step goes to older messages, a negative one back toward the newest.
function pageBy($: EngineInterface, step: number) {
  const next = Math.max(0, Math.min(newerSkip + step, hiddenAbove + newerSkip))
  if (next === newerSkip) return
  newerSkip = next
  $.ui.invalidate('ui.render')
}

async function closeThread($: EngineInterface) {
  if (selected) {
    readAt = { ...readAt, [selected]: await $.clock.now() }
    await $.store.set('readAt', readAt)
  }
  threadOpen = false
  editing = ''
  newerSkip = 0
  cursor = ''
  restedFor = ''
  $.ui.invalidate('ui.render')
}

async function migrate($: EngineInterface) {
  const version = await $.store.get('version')
  if (version === STORE_VERSION) return
  if (version === 3) {
    // 0.3: the names in "friends" were the names we gave them, so they become nicknames.
    const old = asArray<{ name: string; id: string }>(await $.store.get('friends'))
    const now = await $.clock.now()
    await $.store.set('contacts', old
      .filter(f => ID_RE.test(f.id))
      .map(f => ({ id: f.id, state: 'friend', profile: { username: '', displayName: '' }, nickname: f.name, at: now })))
    const name = await $.store.get('name')
    await $.store.set('profile', { username: '', displayName: typeof name === 'string' && name !== 'ben' ? name : '' })
    for (const key of ['friends', 'pending', 'name']) await $.store.delete(key)
  } else {
    // 0.1 and 0.2 data does not fit this protocol; all of it goes except the name.
    const name = await $.store.get('name')
    for (const key of await $.store.keys()) await $.store.delete(key)
    if (typeof name === 'string' && name !== 'ben') await $.store.set('profile', { username: '', displayName: name })
  }
  await $.store.set('version', STORE_VERSION)
}

async function loadIdentity($: EngineInterface) {
  const saved = await $.store.get('secretKey')
  if (typeof saved === 'string') {
    try { keys = nacl.box.keyPair.fromSecretKey(unb64(saved)) } catch { keys = undefined }
  }
  if (!keys) {
    keys = nacl.box.keyPair()
    await $.store.set('secretKey', b64(keys.secretKey))
  }
  me = b64(keys.publicKey)

  let seed: Uint8Array | undefined
  const savedSeed = await $.store.get('kemSeed')
  if (typeof savedSeed === 'string') {
    try { seed = unb64(savedSeed) } catch { seed = undefined }
  }
  if (seed?.length !== 64) {
    seed = nacl.randomBytes(64)
    await $.store.set('kemSeed', b64(seed))
  }
  kemKeys = ml_kem768.keygen(seed)
}

const addLine = () => '/buddy-add ' + me

const ME_COLOR = '#d97757'
// Desktop chat colours: Claude's orange for your own bubbles, and translucent greys that read on light and dark themes.
const ACCENT = '#d97757'
const MINE_SOFT = '#ffffffc0'
const READ_COLOR = '#1d4ed8'
const BUBBLE_BG = '#8e8e9326'
const HOVER_BG = '#8e8e931a'
const SELECTED_BG = '#d977572e'
// Panes at least this many columns wide show the chat list beside the open chat.
const SPLIT_COLUMNS = 90
const PALETTE = ['#e8590c', '#2f9e44', '#1c7ed6', '#ae3ec9', '#f08c00', '#0c8599', '#d6336c', '#5c7cfa']

function colorOf(id: string): string {
  if (id === me) return ME_COLOR
  let sum = 0
  for (const ch of id) sum = (sum * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[sum % PALETTE.length]!
}

function initials(name: string): string {
  const words = name.replace(/^[@#]\s*/, '').trim().split(/\s+/).filter(Boolean)
  const letters = words.slice(0, 2).map(w => Array.from(w)[0] ?? '').join('')
  return (letters || name.trim().slice(0, 1) || '?').toUpperCase()
}

const xml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)

function avatarSvg(name: string, color: string): string {
  const text = name === '#' ? '#' : initials(name)
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="20" fill="' + color + '"/>' +
    '<text x="20" y="26" text-anchor="middle" font-family="-apple-system, Segoe UI, Helvetica, sans-serif" font-size="' +
    (text.length > 1 ? 15 : 18) + '" font-weight="600" fill="#ffffff">' + xml(text) + '</text></svg>'
}

function parseAddLine(text: string): { id: string; nickname: string } | undefined {
  const id = text.match(/[A-Za-z0-9_-]{43}/)?.[0]
  if (!id) return undefined
  return { id, nickname: text.replace('/buddy-add', '').replace(id, '').trim() }
}

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString()

function dayLabel(at: number, now: number): string {
  if (sameDay(at, now)) return t('today')
  if (sameDay(at, now - 86_400_000)) return t('yesterday')
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear()
}

function shortWhen(at: number, now: number): string {
  if (sameDay(at, now)) return clock(at)
  if (sameDay(at, now - 86_400_000)) return t('yesterday')
  return dayLabel(at, now).slice(0, 5)
}

const security = (c: Contact | undefined) => (c?.pq ? t('securityPq') : t('securityClassic'))

function subtitle(c: Contact): string {
  const parts = [c.profile.username ? '@' + c.profile.username : '', c.nickname ? c.profile.displayName : '']
  return parts.filter(Boolean).join(' · ') || shortId(c.id)
}

async function registerCommands($: EngineInterface) {
  await $.command.register({ name: 'buddy', description: t('cmdBuddy') })
  await $.command.register({ name: 'buddy-id', description: t('cmdId') })
  await $.command.register({ name: 'buddy-name', description: t('cmdName'), argumentHint: t('cmdNameHint') })
  await $.command.register({ name: 'buddy-username', description: t('cmdUsername'), argumentHint: t('cmdUsernameHint') })
  await $.command.register({ name: 'buddy-add', description: t('cmdAdd'), argumentHint: t('cmdAddHint') })
  await $.command.register({ name: 'buddy-list', description: t('cmdList') })
  await $.command.register({ name: 'buddy-send', description: t('cmdSend'), argumentHint: t('cmdSendHint') })
  await $.command.register({ name: 'buddy-group', description: t('cmdGroup'), argumentHint: t('cmdGroupHint') })
  await $.command.register({ name: 'buddy-lang', description: t('cmdLang'), argumentHint: t('cmdLangHint') })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    session = await $.session.id()
    view = 'chats'
    selected = editing = renaming = cursor = ''
    threadOpen = false
    editingProfile = false
    filter = ''
    await migrate($)
    await loadIdentity($)
    await refresh($, true)
    void broadcastProfile($).catch(() => {})
    // Handshake with friends who have no quantum-resistant key yet, such as those updated from 0.4.
    void (async () => { for (const f of friends()) if (!f.pq) await sendKem($, f.id) })().catch(() => {})

    $.clock.every(POLL_MS, () => tick($))

    try {
      await registerCommands($)
      await $.tool.register({
        name: 'send_to_buddy',
        description:
          "Send a short text message to one of the user's buddies or buddy groups (other people's Claude Code sessions on other computers). " +
          'Only use when the user explicitly asks to message a buddy. `to` is a buddy name, @username or group title from the list. ' +
          'The user confirms every message before it is sent.',
        inputSchema: {
          type: 'object',
          properties: { to: { type: 'string' }, text: { type: 'string' } },
          required: ['to', 'text'],
        },
      })
    } catch (err) {
      $.ui.log(t('registerError', { error: String(err) }))
    }
    return next(e)
  })

  on('command.run', { command: 'buddy' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Buddy chat', focus: true })
    return {}
  })

  on('command.run', { command: 'buddy-id' }, async () => {
    return { text: t('idReply', { id: me, line: addLine() }) }
  })

  on('command.run', { command: 'buddy-name' }, async ($, e) => {
    if (!e.args.trim()) return { text: t('usageName') }
    return { text: await setProfile($, { displayName: e.args }) }
  })

  on('command.run', { command: 'buddy-username' }, async ($, e) => {
    const username = cleanUsername(e.args)
    if (!username) return { text: t('usernameRule') }
    return { text: await setProfile($, { username }) }
  })

  on('command.run', { command: 'buddy-add' }, async ($, e) => {
    const parsed = parseAddLine(e.args)
    if (!parsed) return { text: t('usageAdd') }
    return { text: await addContact($, parsed.id, parsed.nickname) }
  })

  on('command.run', { command: 'buddy-lang' }, async ($, e) => {
    const next = e.args.trim().toLowerCase()
    if (!isLang(next)) return { text: t('usageLang') }
    return { text: await setLang($, next) }
  })

  on('command.run', { command: 'buddy-list' }, async () => {
    const lines = [t('listMe', { name: myPublicName(), username: profile.username ? ' (@' + profile.username + ')' : '', id: me })]
    lines.push(t('listFriends', { count: friends().length }))
    for (const c of friends()) lines.push('  ' + nameOf(c.id) + ' · ' + subtitle(c) + ' · ' + security(c))
    const incoming = contacts.filter(c => c.state === 'incoming')
    const outgoing = contacts.filter(c => c.state === 'outgoing')
    if (incoming.length) lines.push(t('listIncoming', { names: incoming.map(c => ownName(c.profile) || shortId(c.id)).join(', ') }))
    if (outgoing.length) lines.push(t('listOutgoing', { names: outgoing.map(c => nameOf(c.id)).join(', ') }))
    lines.push(t('listGroups', { count: groups.length }))
    for (const g of groups) lines.push('  ' + g.title + ' · ' + g.members.map(m => nameOf(m.id, m.name)).join(', '))
    if (blocked.length) lines.push(t('listBlocked', { count: blocked.length }))
    return { text: lines.join('\n') }
  })

  on('command.run', { command: 'buddy-send' }, async ($, e) => {
    const hit = matchConv(e.args)
    if (!hit || !hit.rest) return { text: t('usageSend') }
    return { text: (await sendText($, hit.conv.id, hit.rest)).text }
  })

  on('command.run', { command: 'buddy-group' }, async ($, e) => {
    const [title, ...names] = e.args.trim().split(/\s+/)
    if (!title || !names.length) return { text: t('usageGroup') }
    const hits = names.map(n => matchConv(n)?.conv)
    const missing = names.filter((_, i) => !hits[i] || hits[i]!.isGroup)
    if (missing.length) return { text: t('friendNotFound', { names: missing.join(', ') }) }
    return { text: await createGroup($, title, hits.map(c => c!.id.slice(3))) }
  })

  on('tool.call', { tool: 'mcp__buddy-chat__send_to_buddy' }, async ($, e) => {
    const input = e as unknown as { to?: string; text?: string }
    const to = String(input.to ?? '')
    const text = String(input.text ?? '')
    const conv = matchConv(to)?.conv
    if (!conv) return { result: t('toolNotFound', { to }) }

    // A forwarded buddy message can steer the model into sending data out, so every send asks the user first.
    const preview = text.length > 300 ? text.slice(0, 300) + '…' : text
    const question = conv.isGroup ? t('toolAskGroup', { title: conv.title, text: preview }) : t('toolAskDm', { name: conv.title, text: preview })
    let answer = ''
    try {
      answer = await $.ui.ask(question, [t('toolSend'), t('toolDontSend')])
    } catch {
      // dismissed, or no one to ask
    }
    if (answer !== t('toolSend')) return { result: t('toolDeclined') }
    return { result: (await sendText($, conv.id, text)).text }
  })

  // The chat is drawn taller than the pane (see restOffset), so the wheel, the arrows and the page keys raise ui.scroll.
  // The pane is held at its rest row and the scroll moves the messages instead: a tick or an arrow by one, a page key by a page.
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    if (!chatShown || e.by === 0 || e.origin?.kind !== 'person') return next(e)
    if (restOffset === 0) {
      const step = Math.min(PAGE_STEP, Math.max(1, Math.round(Math.abs(e.by))))
      pageBy($, e.by < 0 ? step : -step)
    } else {
      // The pane has one row to move, so by reads 1 per tick; a tick of a page scrolls about three.
      const rows = Math.sign(e.by) * Math.max(WHEEL_ROWS, Math.abs(e.by))
      if (Math.sign(wheelRows) === Math.sign(rows)) wheelRows += rows
      else wheelRows = rows
      const steps = Math.trunc(wheelRows / avgRows)
      if (steps) {
        wheelRows -= steps * avgRows
        pageBy($, -Math.max(-PAGE_STEP, Math.min(PAGE_STEP, steps)))
      }
    }
    return next({ ...e, offset: restOffset })
  })

  // A Desktop chat row posts { open } when it is clicked anywhere.
  on('ui.message', { requestId: PANE }, async ($, e) => {
    const open = (e.data as { open?: unknown } | null)?.open
    if (typeof open === 'string' && conversations().some(c => c.id === open)) await select($, open)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    // resolve hands over every element on every surface; what a surface can draw is decided by the surface.
    const Input = e.surface !== 'mobile' && 'Input' in els ? els.Input : undefined
    // Desktop, VS Code and mobile get the graphic layout; the terminal gets the compact, keyboard-first one.
    const graphic = e.surface !== 'terminal'
    const Svg = graphic && 'Svg' in els ? els.Svg : undefined
    const Client = e.surface === 'desktop' && 'Client' in els ? els.Client : undefined
    const cols = Math.max(20, e.props.bodyColumns)
    // Set again below only when a chat is drawn, so People and the list keep their own scrolling.
    chatShown = false
    // The rows the pane gives its body: the chat is drawn this tall so it never scrolls the list and the header away.
    const fullHeight = e.props.scroll?.bodyRows || undefined
    const now = await $.clock.now()
    if (!selected && !graphic) selected = conversations()[0]?.id ?? ''
    const convs = conversations()
    const incoming = contacts.filter(c => c.state === 'incoming')
    const outgoing = contacts.filter(c => c.state === 'outgoing')
    const current = convs.find(c => c.id === selected) ?? convs[0]
    const redraw = () => $.ui.invalidate('ui.render')
    const toast = (text: string) => $.ui.toast(text)
    const isTyping = (conv: string) => privacy.typing && typing.some(x => x.conv === conv && x.until > now)

    const copy = async (text: string, surface: typeof e.surface, done: string) => {
      const r = await $.ui.copy({ text, surface })
      toast(r.isCopied ? done : t('copyFailed'))
    }

    const avatar = (key: string, label: string, color: string, size: number) =>
      Svg
        ? <Svg key={'avatar-' + key} alt={label} width={size} height={size} source={avatarSvg(label, color)} />
        : <Text color={color} weight="bold">{initials(label)}</Text>

    const section = (title: string, count?: number, color?: string) =>
      graphic
        ? <Text size="heading" weight="semibold" color={color}>{title}{count !== undefined ? <Text dimColor> {count}</Text> : ''}</Text>
        : <Text weight="bold" color={color ?? 'claude'}>{title}{count !== undefined ? ' (' + count + ')' : ''}</Text>

    const statusView =
      status?.state === 'ok' && now - pollerAt < POLLER_STALE_MS * 2
        ? <Text color="success" size="caption">{t('statusOk')}</Text>
        : status?.state === 'limited'
          ? <Text color="warning" size="caption">{t('statusLimited')}</Text>
          : status?.state === 'error'
            ? <Text color="error" size="caption">{t('statusError')}</Text>
            : <Text dimColor size="caption">{t('statusWaiting')}</Text>

    const tab = (key: string, label: string, hotkey: string, active: boolean, onPress: () => void, badge = 0) =>
      graphic
        ? <Button key={key} variant={active ? 'primary' : 'secondary'} hotkey={hotkey} onPress={onPress}>
            {label}{badge ? <Text color="warning"> ●{badge}</Text> : ''}
          </Button>
        : <Button key={key} plain hotkey={hotkey} dimColor={!active} onPress={onPress}>
            {label}{badge ? <Text color="warning"> ●{badge}</Text> : ''}
          </Button>

    const header = (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" rowGap={graphic ? 1 : 0}>
        <Box flexDirection="row" columnGap={graphic ? 1 : 2} alignItems="center">
          {tab('tab-chats', t('tabChats'), 's', view === 'chats', () => { view = 'chats'; redraw() })}
          {tab('tab-people', t('tabPeople'), 'p', view === 'people', () => { view = 'people'; redraw() }, incoming.length)}
        </Box>
        {statusView}
      </Box>
    )

    // Fields carry no side label: labels of different lengths left the boxes out of line.
    const addInput = Input
      ? <Input key={'add-contact' + (addSeq ? '-' + addSeq : '')} placeholder={t('addContactPlaceholder')} value="" submitLabel={t('addSubmit')}
          onSubmit={async (value: string) => {
            const parsed = parseAddLine(value)
            if (!parsed) return toast(t('addLineUnknown'))
            toast(await addContact($, parsed.id, parsed.nickname))
            addSeq++
            redraw()
          }} />
      : <Text dimColor>{t('addHintNoInput')}</Text>

    // The ID keeps to one line: on a narrow pane it is cut in the middle, and the copy buttons always copy it whole.
    const shareRow = (
      <Box flexDirection="column" rowGap={graphic ? 1 : 0}>
        <Box flexDirection="row" columnGap={1}>
          <Text dimColor size="caption">{t('buddyIdLabel')}</Text>
          <Box flexShrink={1}><Text mono size="caption" wrap="truncate-middle">{me}</Text></Box>
        </Box>
        <Box flexDirection="row" columnGap={graphic ? 1 : 2} alignItems="center" flexWrap="wrap">
          <Button key="copy-line" label={t('copyLine')} plain={graphic ? undefined : true} variant={graphic ? 'primary' : undefined}
            hotkey="c" onPress={async press => { await copy(addLine(), press.surface, t('copiedLine')); lineCopied = true; redraw() }} />
          <Button key="copy-id" label={t('copyId')} plain={graphic ? undefined : true} dimColor
            onPress={press => copy(me, press.surface, t('copiedId'))} />
        </Box>
      </Box>
    )

    const profileEditor = Input
      ? (
        <Box flexDirection="column">
          <Input key="display-name" placeholder={t('namePlaceholderFull')} value={profile.displayName} submitLabel={t('save')}
            autoFocus={!profile.displayName ? true : undefined}
            onSubmit={async (value: string) => { if (value.trim()) toast(await setProfile($, { displayName: value })) }} />
          <Input key="username" placeholder={t('usernamePlaceholderFull')} value={profile.username} submitLabel={t('save')}
            onSubmit={async (value: string) => {
              const username = cleanUsername(value)
              toast(username ? await setProfile($, { username }) : t('usernameRule'))
            }} />
          {editingProfile && (
            <Button key="profile-done" label={t('done')} plain={graphic ? undefined : true} onPress={() => { editingProfile = false; redraw() }} />
          )}
        </Box>
      )
      : <Text dimColor>{t('usageName')}</Text>

    const profileSummary = (
      <Box flexDirection="row" columnGap={graphic ? 2 : 1} alignItems="center">
        {avatar('me', profile.displayName || profile.username || '?', ME_COLOR, 44)}
        <Box flexDirection={graphic ? 'column' : 'row'} columnGap={1} flexGrow={1} flexShrink={1}>
          <Text size="heading" weight="semibold">{profile.displayName}</Text>
          <Text dimColor size="caption">{profile.username ? '@' + profile.username : t('noUsername')}</Text>
        </Box>
        <Button key="edit-profile" label={t('editProfile')} plain={graphic ? undefined : true} dimColor={graphic ? undefined : true}
          onPress={() => { editingProfile = true; redraw() }} />
      </Box>
    )

    const profileBlock = editingProfile || !profile.displayName ? profileEditor : profileSummary

    const languagePicker = (
      <Box flexDirection="row" columnGap={1} alignItems="center" flexWrap="wrap">
        <Text dimColor size="caption">{t('languageLabel')}</Text>
        {LANGS.map(l => (
          <Button key={'lang-' + l} label={LANG_NAMES[l]} plain dimColor={l !== lang} onPress={() => setLang($, l)} />
        ))}
      </Box>
    )

    const privacyPicker = (
      <Box flexDirection="row" columnGap={1} alignItems="center" flexWrap="wrap">
        <Text dimColor size="caption">{t('privacyLabel')}</Text>
        <Button key="toggle-read" label={t(privacy.readReceipts ? 'readReceiptsOn' : 'readReceiptsOff')} plain dimColor={!privacy.readReceipts}
          onPress={() => setPrivacy($, { readReceipts: !privacy.readReceipts })} />
        <Button key="toggle-typing" label={t(privacy.typing ? 'typingOn' : 'typingOff')} plain dimColor={!privacy.typing}
          onPress={() => setPrivacy($, { typing: !privacy.typing })} />
        <Button key="toggle-notify" label={t(privacy.notifications ? 'notificationsOn' : 'notificationsOff')} plain dimColor={!privacy.notifications}
          onPress={() => setPrivacy($, { notifications: !privacy.notifications })} />
      </Box>
    )

    const footer = (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" columnGap={2}>
        <Text dimColor size="caption">{t('e2eBadge')}</Text>
        {privacyPicker}
        {languagePicker}
      </Box>
    )

    const card = (key: string, title: RenderChildren, body: RenderChildren, color = 'inactive') => (
      <Box key={key} flexDirection="column" borderStyle="round" borderColor={color}
        padding={graphic ? 'md' : undefined} paddingX={graphic ? undefined : 1} rowGap={graphic ? 1 : 0}>
        {title}
        {body}
      </Box>
    )

    const stepTitle = (n: number, title: string, done: boolean) => (
      <Box flexDirection="row" columnGap={1} alignItems="center">
        <Text weight="bold" color={done ? 'success' : 'claude'}>{done ? '✓' : n + '.'}</Text>
        <Text weight="semibold" size={graphic ? 'heading' : undefined}>{title}</Text>
      </Box>
    )

    const actions = (...buttons: ({ key: string; label: string; onPress: () => unknown; primary?: boolean })[]) => (
      <Box flexDirection="row" columnGap={graphic ? 1 : 2} flexWrap="wrap">
        {buttons.map(b => graphic
          ? <Button key={b.key} label={b.label} variant={b.primary ? 'primary' : 'secondary'} onPress={b.onPress} />
          : <Button key={b.key} label={b.label} plain dimColor={!b.primary} onPress={b.onPress} />)}
      </Box>
    )

    const personRow = (key: string, id: string, title: string, sub: string, extra: RenderChildren, buttons: RenderChildren) => (
      <Box key={key} flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" columnGap={1}>
          <Box flexDirection="row" columnGap={1} alignItems="center">
            {avatar(key, title, colorOf(id), 28)}
            <Box flexDirection={graphic ? 'column' : 'row'} columnGap={1}>
              <Text weight="semibold">{title}</Text>
              <Text dimColor size="caption">{sub}{extra}</Text>
            </Box>
          </Box>
          {buttons}
        </Box>
      </Box>
    )

    if (view === 'people') {
      const peopleHeader = graphic
        ? (
          <Box flexDirection="row" justifyContent="space-between" alignItems="center">
            <Box flexDirection="row" columnGap={1} alignItems="center">
              <Button key="tab-chats" label={'← ' + t('tabChats')} plain hotkey="s" onPress={() => { view = 'chats'; redraw() }} />
              <Text size="title" weight="bold">{t('tabPeople')}</Text>
            </Box>
            {statusView}
          </Box>
        )
        : header
      return (
        <Box flexDirection="column" rowGap={1}>
          {peopleHeader}
          {card('me-card', profileBlock, shareRow, 'claude')}
          {card('add-card', <Text weight="semibold">{t('addContactLabel')}</Text>, addInput)}

          {incoming.length > 0 && (
            <Box flexDirection="column" rowGap={graphic ? 1 : 0}>
              {section(t('requestsTitle'), incoming.length, 'warning')}
              {incoming.map(c => personRow('req-' + c.id, c.id, ownName(c.profile) || shortId(c.id), subtitle(c), '',
                actions(
                  { key: 'req-accept-' + c.id, label: t('accept'), primary: true, onPress: async () => toast(await acceptContact($, c.id)) },
                  { key: 'req-decline-' + c.id, label: t('decline'), onPress: async () => { await dropContact($, c.id); redraw() } },
                  { key: 'req-block-' + c.id, label: t('block'), onPress: () => block($, c.id) },
                )))}
            </Box>
          )}

          {outgoing.length > 0 && (
            <Box flexDirection="column" rowGap={graphic ? 1 : 0}>
              {section(t('outgoingTitle'), outgoing.length)}
              {outgoing.map(c => personRow('out-' + c.id, c.id, nameOf(c.id), t('requestSentShort'), '',
                actions(
                  {
                    key: 'out-retry-' + c.id, label: t('retry'), onPress: async () => {
                      const err = await post($, c.id, { t: 'request', id: newId(), profile })
                      toast(err ? errorText(err) : t('requestResent'))
                    },
                  },
                  { key: 'out-cancel-' + c.id, label: t('cancel'), onPress: async () => { await dropContact($, c.id); redraw() } },
                )))}
            </Box>
          )}

          <Box flexDirection="column" rowGap={graphic ? 1 : 0}>
            {section(t('friendsTitle'), friends().length)}
            {friends().length === 0 && <Text dimColor>{t('noFriends')}</Text>}
            {friends().map(c => (
              <Box key={'friend-' + c.id} flexDirection="column">
                {personRow('friend-row-' + c.id, c.id, nameOf(c.id), subtitle(c),
                  c.pq ? <Text color="success">{t('pqReady')}</Text> : <Text dimColor>{t('pqPending')}</Text>,
                  actions(
                    { key: 'friend-open-' + c.id, label: t('message'), primary: true, onPress: () => select($, convOf(c.id)) },
                    { key: 'friend-nick-' + c.id, label: t('nickname'), onPress: () => { renaming = renaming === c.id ? '' : c.id; redraw() } },
                    {
                      key: 'friend-remove-' + c.id, label: t('remove'), onPress: async () => {
                        if (await confirm($, t('confirmRemove', { name: nameOf(c.id) }), t('answerRemove'))) await unfriend($, c.id)
                      },
                    },
                    {
                      key: 'friend-block-' + c.id, label: t('block'), onPress: async () => {
                        if (await confirm($, t('confirmBlock', { name: nameOf(c.id) }), t('answerBlock'))) await block($, c.id)
                      },
                    },
                  ))}
                {renaming === c.id && Input && (
                  <Input key={'nick-' + c.id} label={t('nicknameLabel')} placeholder={ownName(c.profile) || t('nicknamePlaceholder')}
                    value={c.nickname ?? ''} submitLabel={t('save')} autoFocus
                    onSubmit={async (value: string) => { renaming = ''; await setNickname($, c.id, value) }} />
                )}
              </Box>
            ))}
          </Box>

          <Box flexDirection="column" rowGap={graphic ? 1 : 0}>
            {section(t('groupsTitle'), groups.length)}
            {groups.length === 0 && <Text dimColor>{t('noGroups')}</Text>}
            {groups.map(g => (
              <Box key={'group-' + g.id} flexDirection="column">
                {personRow('group-row-' + g.id, g.id, '# ' + g.title,
                  t('groupMeta', { count: g.members.length }) + (g.owner === me ? t('groupOwned') : '') + ' · ' +
                    g.members.map(m => nameOf(m.id, m.name)).join(', '), '',
                  actions(
                    { key: 'group-open-' + g.id, label: t('open'), primary: true, onPress: () => select($, groupConv(g.id)) },
                    {
                      key: 'group-leave-' + g.id, label: t('leave'), onPress: async () => {
                        if (await confirm($, t('confirmLeave', { title: g.title }), t('answerLeave'))) await leaveGroup($, g)
                      },
                    },
                  ))}
                {g.owner === me && g.members.length < MAX_GROUP && (
                  <Box flexDirection="row" columnGap={graphic ? 1 : 2} flexWrap="wrap" paddingLeft={graphic ? 0 : 2}>
                    {friends().filter(f => !g.members.some(m => m.id === f.id)).map(f => (
                      <Button key={'group-add-' + g.id + '-' + f.id} label={'+ ' + nameOf(f.id)} plain={graphic ? undefined : true} dimColor
                        onPress={async () => toast(await addToGroup($, g, f.id))} />
                    ))}
                  </Box>
                )}
              </Box>
            ))}
          </Box>

          {friends().length > 0 && (
            <Box flexDirection="column" rowGap={graphic ? 1 : 0}>
              {section(t('newGroupTitle'))}
              <Box flexDirection="row" columnGap={graphic ? 1 : 2} flexWrap="wrap">
                {friends().map(f => (
                  <Button key={'pick-' + f.id} label={(groupPick.has(f.id) ? (graphic ? '✓ ' : '[x] ') : (graphic ? '' : '[ ] ')) + nameOf(f.id)}
                    plain={graphic ? undefined : true} variant={graphic && groupPick.has(f.id) ? 'primary' : undefined}
                    dimColor={!groupPick.has(f.id)}
                    onPress={() => {
                      if (groupPick.has(f.id)) groupPick.delete(f.id)
                      else groupPick.add(f.id)
                      redraw()
                    }} />
                ))}
              </Box>
              {Input
                ? <Input key={'group-title' + (groupSeq ? '-' + groupSeq : '')} label={t('groupTitleLabel')} placeholder={t('groupTitlePlaceholder')}
                    value="" submitLabel={t('create')}
                    onSubmit={async (value: string) => { toast(await createGroup($, value, [...groupPick])); groupSeq++; redraw() }} />
                : <Text dimColor>{t('groupHintNoInput')}</Text>}
            </Box>
          )}

          {blocked.length > 0 && (
            <Box flexDirection="column" rowGap={graphic ? 1 : 0}>
              {section(t('blockedTitle'), blocked.length)}
              {blocked.map(id => personRow('blocked-' + id, id, shortId(id), t('blockedSub'), '',
                actions({ key: 'unblock-' + id, label: t('unblock'), onPress: () => unblock($, id) })))}
            </Box>
          )}
          {footer}
        </Box>
      )
    }

    if (!current) {
      const named = !!profile.displayName
      return (
        <Box flexDirection="column" rowGap={1}>
          {header}
          <Box flexDirection="column">
            <Text weight="bold" size="title">{t('welcomeTitle')}</Text>
            <Text dimColor>{t('welcomeSub')}</Text>
          </Box>
          {incoming.length > 0 && (
            <Button key="go-requests" label={t('requestsButton', { count: incoming.length })} variant="primary" plain={graphic ? undefined : true}
              onPress={() => { view = 'people'; redraw() }} />
          )}
          {card('step-profile', stepTitle(1, t('stepProfile'), named && !editingProfile), profileBlock, named && !editingProfile ? 'success' : 'claude')}
          {card('step-share', stepTitle(2, t('stepShare'), lineCopied),
            <Box flexDirection="column" rowGap={graphic ? 1 : 0}>
              <Text dimColor size="footnote">{t('shareHint')}</Text>
              {shareRow}
            </Box>, lineCopied ? 'success' : named ? 'claude' : 'inactive')}
          {card('step-add', stepTitle(3, t('stepAdd'), outgoing.length > 0),
            <Box flexDirection="column" rowGap={graphic ? 1 : 0}>
              <Text dimColor size="footnote">{t('addHint')}</Text>
              {addInput}
              {outgoing.length > 0 && <Text dimColor size="caption">{t('outgoingWaiting', { count: outgoing.length })}</Text>}
            </Box>, outgoing.length > 0 ? 'success' : lineCopied ? 'claude' : 'inactive')}
          {footer}
        </Box>
      )
    }

    const convColor = (c: Conv) => (c.isGroup ? '#5c7cfa' : colorOf(c.id.slice(3)))
    const lastOf = (conv: string) => {
      let last: Msg | undefined
      for (const m of inbox) if (m.conv === conv && (!last || m.at >= last.at)) last = m
      return last
    }
    const previewOf = (m: Msg | undefined) =>
      !m ? t('noMessagesPreview') : m.deleted ? t('deletedMsg') : m.system ? textOf(m) : (m.mine ? t('youPrefix') : '') + m.text

    // Desktop: a wide pane splits into the chat list and the open chat, as chat apps do; a narrow one shows one at a time.
    const split = graphic && cols >= SPLIT_COLUMNS
    const needle = filter.trim().toLowerCase()
    const listed = needle ? convs.filter(c => c.title.toLowerCase().includes(needle)) : convs

    const unreadPill = (n: number) => (
      <Box backgroundColor={ACCENT} borderStyle="round" borderColor={ACCENT} paddingX={1}>
        <Text size="caption" weight="bold" color="#ffffff">{n > 99 ? '99+' : String(n)}</Text>
      </Box>
    )

    const chatRow = (c: Conv, i: number) => {
      const last = lastOf(c.id)
      const active = (split || threadOpen) && c.id === current?.id
      return (
        <Box key={'row-' + c.id} flexDirection="row" columnGap={1} alignItems="center" padding="sm"
          backgroundColor={active ? SELECTED_BG : undefined} hover={{ backgroundColor: active ? SELECTED_BG : HOVER_BG }}>
          {avatar(c.id, c.isGroup ? '#' : c.title, convColor(c), 40)}
          {Client
            ? (
              // The whole text area takes the click on Desktop; VS Code and mobile have no Client and keep the name button.
              // The Client sizes to its text unless the box around it holds it to the row's width.
              <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
                <Client key={'conv-' + c.id} module="./chat-row.tsx" flexGrow={1}
                  props={{
                    conv: c.id,
                    title: (c.isGroup ? '# ' : '') + c.title + (muted.includes(c.id) ? ' 🔕' : ''),
                    preview: isTyping(c.id) ? t('typingNow') : previewOf(last),
                    when: last ? shortWhen(last.at, now) : '',
                    unread: c.unread,
                    accent: ACCENT,
                  } satisfies ChatRowProps} />
              </Box>
            )
            : (
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
              <Button key={'conv-' + c.id} plain onPress={() => select($, c.id)}>
                <Text weight="semibold">{(c.isGroup ? '# ' : '') + c.title + (muted.includes(c.id) ? ' 🔕' : '')}</Text>
              </Button>
              <Text dimColor={c.unread === 0} color={c.unread > 0 ? ACCENT : undefined} size="caption">{last ? shortWhen(last.at, now) : ''}</Text>
            </Box>
            <Box flexDirection="row" justifyContent="space-between" columnGap={1} alignItems="center">
              {isTyping(c.id)
                ? <Text color={ACCENT} size="footnote" italic>{t('typingNow')}</Text>
                : <Text dimColor={c.unread === 0} size="footnote" wrap="truncate-end">{previewOf(last)}</Text>}
              {c.unread > 0 && unreadPill(c.unread)}
            </Box>
          </Box>
            )}
        </Box>
      )
    }

    const sidebar = (
      <Box key="sidebar" flexDirection="column" width={split ? '36%' : undefined} flexShrink={0} rowGap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text size="title" weight="bold">{t('tabChats')}</Text>
          {statusView}
        </Box>
        {Input && convs.length > 5 && (
          <Input key="search" placeholder={t('searchPlaceholder')} value={filter} submitLabel={t('searchPlaceholder')}
            onInput={(value: string) => { filter = value; redraw() }}
            onSubmit={(value: string) => { filter = value; redraw() }} />
        )}
        {incoming.length > 0 && (
          <Button key="go-requests" label={t('requestsButton', { count: incoming.length })} variant="primary"
            onPress={() => { view = 'people'; redraw() }} />
        )}
        <Box flexDirection="column">{listed.map(chatRow)}</Box>
        {listed.length === 0 && <Text dimColor>{t('noMatches')}</Text>}
        <Box flexDirection="row" columnGap={1} alignItems="center" marginTop={1}>
          {avatar('me-mini', profile.displayName || profile.username || '?', ME_COLOR, 28)}
          <Box flexGrow={1} flexShrink={1}>
            <Text weight="semibold" wrap="truncate-end">{myPublicName()}</Text>
          </Box>
          {tab('tab-people', t('tabPeople'), 'p', false, () => { view = 'people'; redraw() }, incoming.length)}
        </Box>
      </Box>
    )

    // With no chat open, the right side is home: your Buddy ID, adding a friend, requests.
    const home = (
      <Box key="home" flexDirection="column" flexGrow={1} flexShrink={1} rowGap={1} paddingLeft={split ? 2 : 0}>
        <Text size="title" weight="bold">Buddy chat</Text>
        {incoming.length > 0 && (
          <Button key="home-requests" label={t('requestsButton', { count: incoming.length })} variant="primary"
            onPress={() => { view = 'people'; redraw() }} />
        )}
        {card('me-card', profileBlock, shareRow, 'claude')}
        {card('add-card', <Text weight="semibold">{t('addContactLabel')}</Text>, addInput)}
        {footer}
      </Box>
    )

    if (graphic && !threadOpen) {
      if (!split) return sidebar
      return (
        <Box flexDirection="row" columnGap={1}>
          {sidebar}
          {home}
        </Box>
      )
    }


    const group = current.isGroup ? groups.find(g => groupConv(g.id) === current.id) : undefined
    const peer = current.isGroup ? undefined : contactOf(current.id.slice(3))
    // Polls bring replies in batches, so the store's order is not time order: sort by time, keeping the stored order for ties.
    const thread = inbox
      .map((m, i) => ({ m, i }))
      .filter(x => x.m.conv === current.id)
      .sort((a, b) => a.m.at - b.m.at || a.i - b.i)
      .map(x => x.m)
    // Drawn means shown: what this chat holds from others is read now.
    void markRead($, current.id).catch(() => {})
    const editTarget = thread.find(m => m.key === editing && m.mine && !m.deleted)
    const end = Math.max(0, thread.length - newerSkip)
    // The window holds what fits between the header and the composer, counted in the pane's rows, so it follows the
    // pane's size on any screen. In the terminal rows are cells and the count is exact.
    const lineWidth = Math.max(10, graphic ? Math.floor(cols * 0.8) - 4 : cols - 8)
    const linesOf = (text: string) => text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / lineWidth)), 0)
    const rowsOf = (m: Msg, prev: Msg | undefined) => {
      const newDay = !prev || !sameDay(prev.at, m.at)
      const sameRun = !!prev && !newDay && !prev.system && !m.system && prev.from === m.from && m.at - prev.at < 5 * 60_000
      // Desktop draws text taller than a row, and a bubble adds its frame, its time line and a gap.
      if (graphic) {
        return (newDay ? 2.5 : 0) + (m.system ? 1.2 : linesOf(textOf(m)) * 1.4 + (sameRun ? 2 : 2.8))
          + (!m.mine && !m.system && !!group && !sameRun ? 1.2 : 0)
      }
      // An incoming message's quote bar adds a blank row above and below it.
      return (newDay ? 1 : 0) + (m.system || sameRun ? 0 : 1) + linesOf(textOf(m)) + (m.system || m.mine ? 0 : 2)
    }
    const chipRows = Math.ceil(convs.reduce((n, c) => n + c.title.length + 6, 0) / cols)
    // Desktop overfills a little: the list hangs from the bottom and clips at the top, which is better than a gap.
    const room = graphic ? Math.max(6, (fullHeight ?? 40) - 16) * 1.2 : Math.max(4, (fullHeight ?? 24) - 11 - chipRows)
    let start = end
    let used = 0
    while (start > 0) {
      const rowsNeeded = rowsOf(thread[start - 1]!, thread[start - 2])
      if (used + rowsNeeded > room && start < end) break
      used += rowsNeeded
      start--
    }
    hiddenAbove = start
    const visible = thread.slice(start, end)
    if (graphic && visible.length) avgRows = Math.max(1, used / visible.length)
    const below = thread.length - end
    // At the start of the chat the messages hang from the top, so going back never opens a gap above them.
    const align = start === 0 && newerSkip > 0 ? 'flex-start' : 'flex-end'
    chatShown = view === 'chats' && !!fullHeight
    restOffset = graphic ? 1 : 0
    const olderButton = start > 0 && (
      <Box justifyContent="center">
        <Button key="older" label={t('olderMessages', { count: start })} plain dimColor hotkey={graphic ? undefined : 'o'}
          onPress={() => pageBy($, PAGE_STEP)} />
      </Box>
    )
    // The pane rests with these rows out of view; they only give the wheel and the scroll keys room to raise ui.scroll.
    const scrollRow = fullHeight ? <Box key="scroll-row" height={1} /> : null
    const scrollRowTop = fullHeight && graphic ? <Box key="scroll-row-top" height={1} /> : null
    const newerButton = below > 0 && (
      <Box justifyContent="center">
        <Button key="newer" label={t('newerMessages', { count: below })} plain dimColor onPress={() => pageBy($, -PAGE_STEP)} />
      </Box>
    )
    const isMuted = muted.includes(current.id)
    const muteButton = (
      <Button key="mute" label={graphic ? (isMuted ? '🔕' : '🔔') : (isMuted ? t('unmute') : t('mute'))} plain dimColor={!isMuted}
        hotkey="m" onPress={() => toggleMute($, current.id)} />
    )
    const securityLine = group
      ? group.members.map(m => nameOf(m.id, m.name)).join(', ') + ' · ' + t('groupSecurity')
      : (peer ? subtitle(peer) + ' · ' : '') + security(peer)

    const msgActions = (m: Msg) => {
      if (m.deleted) return null
      const marked = m.key === cursor
      const copyButton = (
        <Button key={'copy-' + m.key} label={graphic ? t('copyButton') : '⧉'} plain dimColor={!marked} hotkey={marked ? 'c' : undefined}
          onPress={press => copy(m.text, press.surface, t('copiedMsg'))} />
      )
      if (m.mine) {
        return (
          <Box flexDirection="row" columnGap={1}>
            {copyButton}
            <Button key={'edit-' + m.key} label="✎" plain dimColor={!marked} hotkey={marked ? 'e' : undefined}
              onPress={() => { editing = m.key; redraw() }} />
            <Button key={'del-' + m.key} label="✕" plain dimColor={!marked} hotkey={marked ? 'x' : undefined}
              onPress={async () => {
                if (await confirm($, t('confirmDelete'), t('answerDelete'))) toast((await deleteMessage($, m)).text)
              }} />
          </Box>
        )
      }
      if (m.forwarded) {
        return (
          <Box flexDirection="row" columnGap={1}>
            {copyButton}
            <Text dimColor size="caption">{t('forwarded')}</Text>
          </Box>
        )
      }
      return (
        <Box flexDirection="row" columnGap={1}>
        {copyButton}
        <Button key={'fwd-' + m.key} label={graphic ? t('forwardButton') : '↗'} plain dimColor={!marked} hotkey={marked ? 'f' : undefined}
          onPress={async () => {
            inbox = await mutate<Msg>($, 'inbox', cur => cur.map(x => (x.key === m.key ? { ...x, forwarded: true } : x)))
            redraw()
            const name = nameOf(m.from, m.name)
            void $.prompt.submit({
              text: group ? t('forwardGroup', { group: group.title, name, text: m.text }) : t('forwardDm', { name, text: m.text }),
            })
          }} />
        </Box>
      )
    }

    // ◷ sending, ✓ sent, ✓✓ reached everyone, blue ✓✓ read by everyone (shown only while my own receipts are on).
    const ticks = (m: Msg) => {
      if (!m.mine || m.system || m.deleted) return null
      if (m.state === 'sending') return <Text size="caption" color={graphic ? MINE_SOFT : undefined} dimColor={!graphic}>{' ◷'}</Text>
      const targets = recipients(m.conv).map(r => r.id)
      const all = (list?: string[]) => targets.length > 0 && targets.every(id => list?.includes(id))
      if (privacy.readReceipts && all(m.readBy)) return <Text size="caption" weight="bold" color={READ_COLOR}>{' ✓✓'}</Text>
      const mark = all(m.deliveredTo) ? ' ✓✓' : ' ✓'
      return <Text size="caption" color={graphic ? MINE_SOFT : undefined} dimColor={!graphic}>{mark}</Text>
    }

    const body = (m: Msg) => m.deleted
      ? <Text dimColor italic>{t('deletedMsg')}</Text>
      : <Text wrap="wrap" color={m.key === editing ? 'warning' : undefined}>{m.text}{m.edited ? <Text dimColor>{t('edited')}</Text> : ''}</Text>

    const rowsView = visible.map((m, i) => {
      const prev = visible[i - 1]
      const newDay = !prev || !sameDay(prev.at, m.at)
      const sameRun = prev && !newDay && !prev.system && !m.system && prev.from === m.from && m.at - prev.at < 5 * 60_000
      const day = newDay
        ? <Box key={'day-' + m.key} justifyContent="center" marginY={graphic ? 1 : 0}><Text dimColor size="caption">── {dayLabel(m.at, now)} ──</Text></Box>
        : null

      if (m.system) {
        return (
          <Box key={'msg-' + m.key} flexDirection="column">
            {day}
            <Box justifyContent="center"><Text dimColor italic size="caption">{textOf(m)}</Text></Box>
          </Box>
        )
      }

      const color = m.mine ? 'suggestion' : colorOf(m.from)
      const name = nameOf(m.from, m.name)

      if (graphic) {
        // Desktop: chat bubbles; actions show on hover; in groups other people's messages carry an avatar and a name.
        const showFace = !m.mine && !!group
        return (
          <Box key={'msg-' + m.key} flexDirection="column" alignItems={m.mine ? 'flex-end' : 'flex-start'} marginTop={sameRun ? 'xs' : 'md'}>
            {day}
            {showFace && !sameRun && (
              <Box paddingLeft={5}><Text size="caption" weight="semibold" color={color}>{name}</Text></Box>
            )}
            <Box key={'msgrow-' + m.key} flexDirection={m.mine ? 'row-reverse' : 'row'} columnGap={1} alignItems="flex-end" width="80%"
              justifyContent="flex-start">
              {showFace && (sameRun ? <Box width={32} /> : avatar('msg-' + m.key, name, color, 32))}
              <Box flexDirection="column" flexShrink={1} backgroundColor={m.mine ? ACCENT : BUBBLE_BG}
                borderStyle="round" borderColor={m.mine ? ACCENT : BUBBLE_BG} paddingX={1}>
                {m.deleted
                  ? <Text italic color={m.mine ? MINE_SOFT : undefined} dimColor={!m.mine}>{t('deletedMsg')}</Text>
                  : <Text wrap="wrap" color={m.mine ? '#ffffff' : undefined}>{m.text}</Text>}
                <Box flexDirection="row" justifyContent="flex-end">
                  <Text size="caption" color={m.mine ? MINE_SOFT : undefined} dimColor={!m.mine}>
                    {(m.edited ? t('editedShort') + ' · ' : '') + clock(m.at)}
                  </Text>
                  {ticks(m)}
                </Box>
              </Box>
            </Box>
            {/* Under the bubble, on its side, shown while the pointer is over the message. */}
            <Box display="none" hover={{ display: 'flex' }} flexDirection="row" columnGap={1} paddingLeft={showFace ? 5 : 1} paddingRight={1}>
              {msgActions(m)}
            </Box>
          </Box>
        )
      }

      // Terminal: the header line once per run, and a bar in the sender's colour beside incoming messages.
      return (
        <Box key={'msg-' + m.key} flexDirection="column" alignItems={m.mine ? 'flex-end' : 'flex-start'}>
          {day}
          {!sameRun && (
            <Box flexDirection="row" columnGap={1}>
              <Text weight="bold" color={color}>{name}</Text>
              <Text dimColor>{clock(m.at)}</Text>
            </Box>
          )}
          <Box flexDirection={m.mine ? 'row-reverse' : 'row'} columnGap={1}
            borderStyle={m.mine ? undefined : 'quote'} borderColor={m.mine ? undefined : color}>
            {m.key === cursor && <Text color="claude" weight="bold">{m.mine ? '‹' : '›'}</Text>}
            {ticks(m)}
            {body(m)}
            {msgActions(m)}
          </Box>
        </Box>
      )
    })

    const composer = !Input
      ? <Text dimColor>{t('noInputHint')}</Text>
      : editTarget
        ? (
          <Box flexDirection="column">
            <Input key={'editing-' + editTarget.key} label={t('editLabel')} value={editTarget.text} submitLabel={t('save')} autoFocus
              onSubmit={async (value: string) => {
                const r = await editMessage($, editTarget, value)
                editing = ''
                redraw()
                if (!r.ok) toast(r.text)
              }} />
            <Button key="edit-cancel" label={t('stopEditing')} plain dimColor onPress={() => { editing = ''; redraw() }} />
          </Box>
        )
        : <Input key={composeKey(current.id)}
            label={graphic ? undefined : '→ ' + (current.isGroup ? '# ' : '') + current.title}
            placeholder={t('composePlaceholder', { title: (current.isGroup ? '# ' : '') + current.title })} value="" submitLabel={t('send')}
            autoFocus={graphic ? true : undefined} rows={graphic ? 2 : undefined}
            onInput={(value: string) => { void sendTyping($, current.id, value).catch(() => {}) }}
            onSubmit={async (value: string) => {
              const r = await sendText($, current.id, value)
              if (!r.ok) toast(r.text)
              if (r.sent) {
                composeSeq++
                redraw()
                // The fresh field replaces the old one, so the focus moves to it and the user keeps typing.
                void $.ui.focus({ requestId: PANE, key: composeKey(current.id) }).catch(() => {})
              }
            }} />

    // k walks up from the newest message, j walks back down; past the newest the mark clears and the window follows new messages again.
    const moveCursor = (step: 1 | -1) => {
      const marks = thread.filter(m => !m.system)
      const at = cursor ? marks.findIndex(m => m.key === cursor) : marks.length
      const to = at + step
      if (to < 0) return
      cursor = to >= marks.length ? '' : marks[to]?.key ?? ''
      if (!cursor) {
        newerSkip = 0
      } else {
        // When the mark leaves the window, the window follows so the marked message is the newest one shown.
        const index = thread.findIndex(m => m.key === cursor)
        if (index < start || index >= end) newerSkip = thread.length - index - 1
      }
      redraw()
    }

    if (graphic) {
      // The bar previews the marked message, or the newest one; the marked bubble's buttons take e, x and f.
      const target = (cursor ? thread.find(m => m.key === cursor) : undefined)
        ?? [...thread].reverse().find(m => !m.system && !m.deleted)
      const actionBar = target && (
        <Box flexDirection="row" columnGap={1} alignItems="center">
          <Button key="nav-up" label="↑" plain dimColor hotkey="k" onPress={() => moveCursor(-1)} />
          <Button key="nav-down" label="↓" plain dimColor hotkey="j" onPress={() => moveCursor(1)} />
          <Box flexGrow={1} flexShrink={1}>
            <Text dimColor={!cursor} color={cursor ? ACCENT : undefined} size="caption" wrap="truncate-end">
              {nameOf(target.from, target.name) + ': ' + textOf(target)}
            </Text>
          </Box>
        </Box>
      )

      if (fullHeight && restedFor !== current.id) {
        restedFor = current.id
        // After this drawing lands, so the key is there to scroll to.
        void $.clock.sleep(50).then(() => scrollToRest($)).catch(() => {})
      }

      return (
        <Box flexDirection="column">
          {scrollRowTop}
          <Box key="chat-top" flexDirection="column" height={fullHeight} overflow="hidden" rowGap={1}>
            <Box flexDirection="row" columnGap={1} alignItems="center" flexShrink={0}>
              <Button key="back" label="←" plain hotkey="b" onPress={() => closeThread($)} />
              {avatar('head-' + current.id, current.isGroup ? '#' : current.title, convColor(current), 40)}
              <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                <Text size="heading" weight="semibold" wrap="truncate-end">{(current.isGroup ? '# ' : '') + current.title}</Text>
                {isTyping(current.id)
                  ? <Text color={ACCENT} size="caption" italic>{t('typingNow')}</Text>
                  : <Text dimColor size="caption" wrap="truncate-end">{'🔒 ' + securityLine}</Text>}
              </Box>
              {muteButton}
              {statusView}
            </Box>
            {olderButton}
            {thread.length === 0
              ? (
                <Box flexDirection="column" alignItems="center" justifyContent="center" rowGap={1} flexGrow={1}>
                  {avatar('empty-' + current.id, current.isGroup ? '#' : current.title, convColor(current), 72)}
                  <Text size="title" weight="semibold">{(current.isGroup ? '# ' : '') + current.title}</Text>
                  <Text dimColor size="caption">{'🔒 ' + securityLine}</Text>
                  <Text dimColor>{t('sayHi')}</Text>
                </Box>
              )
              : (
                <Box key="messages" flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} justifyContent={align} overflow="hidden">
                  {rowsView}
                </Box>
              )}
            {newerButton}
            {actionBar}
            <Box flexDirection="column" alignItems="stretch" width="100%" flexShrink={0}>{composer}</Box>
          </Box>
          {scrollRow}
        </Box>
      )
    }

    const rule = <Text dimColor>{'─'.repeat(cols)}</Text>
    return (
      <Box flexDirection="column">
      <Box key="chat-top" flexDirection="column" height={fullHeight} overflow="hidden">
        {header}
        <Box flexDirection="row" columnGap={2} flexWrap="wrap" marginTop={1}>
          {convs.map((c, i) => (
            <Button key={'conv-' + c.id} plain hotkey={i < 9 ? String(i + 1) : undefined} dimColor={c.id !== current.id}
              onPress={() => select($, c.id)}>
              {(c.isGroup ? '# ' : '') + c.title + (muted.includes(c.id) ? ' 🔕' : '')}{c.unread ? <Text color="warning"> ●{c.unread}</Text> : ''}
            </Button>
          ))}
        </Box>
        {rule}
        {isTyping(current.id)
          ? <Text color="claude" italic wrap="truncate-end">{t('typingNow')}</Text>
          : <Text dimColor wrap="truncate-end">{securityLine}</Text>}
        {olderButton}
        <Box flexDirection="column" flexGrow={1} flexShrink={1} justifyContent={align} overflow="hidden">
          {thread.length === 0 && <Text dimColor>{t('emptyThread')}</Text>}
          {rowsView}
        </Box>
        {newerButton}
        {rule}
        <Box flexDirection="row" columnGap={1}>
          <Box flexGrow={1} flexShrink={1}>{composer}</Box>
          {Input && !editTarget && (
            <Button key="write" label={t('writeButton')} plain hotkey="i"
              onPress={() => { void $.ui.focus({ requestId: PANE, key: composeKey(current.id) }).catch(() => {}) }} />
          )}
          <Button key="nav-down" label="↓" plain dimColor hotkey="j" onPress={() => moveCursor(1)} />
          <Button key="nav-up" label="↑" plain dimColor hotkey="k" onPress={() => moveCursor(-1)} />
          {muteButton}
        </Box>
        <Text dimColor wrap="truncate-end">{t('terminalHint')}</Text>
        <Text dimColor wrap="truncate-end">{t('terminalHint2')}</Text>
      </Box>
      {scrollRow}
      </Box>
    )
  })
}
