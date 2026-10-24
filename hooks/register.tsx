import type { EngineInterface, Register, RenderChildren } from 'claude-code'
import nacl from './vendor/nacl.js'
import { ml_kem768 } from './vendor/mlkem.js'
import { LANGS, LANG_NAMES, isKey, isLang, translate, type Key, type Lang, type Vars } from './i18n.js'
import { backupKey, fromWords, keysFromEntropy, toWords } from './recovery.js'
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
// ntfy keeps a message 12 hours; a message nobody confirmed goes out again before that, for up to a week.
const RETRY_MS = 11 * 3_600_000
const RETRY_MAX_MS = 7 * 86_400_000
const RETRY_PER_TICK = 5
// Linked devices: a device back after this long asks the others for what it missed.
const CATCHUP_GAP_MS = 5 * 60_000
const CATCHUP_MAX = 100
const LINK_TTL_MS = 10 * 60_000
const LINK_RE = /buddylink-([A-Za-z0-9_-]{43})/
// A payload longer than this goes out in parts; each sealed part stays under ntfy's 4096-byte limit.
const PART_CHARS = 2000
// The mod reads at most 4 MiB from a file; 3 MB leaves room for the sealing and the base64 around it.
const MAX_FILE_BYTES = 3 * 1024 * 1024
const FILE_URL_RE = /^https:\/\/ntfy\.sh\/file\/[A-Za-z0-9]+(\.[a-z0-9]+)?$/
const SNAPSHOT_MAX_CHARS = 60_000
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
// sound: 'auto' plays our chime only when the notification made no sound of its own (not sent, as in the desktop app).
type Sound = 'auto' | 'on' | 'off'
type Privacy = { readReceipts: boolean; typing: boolean; notifications: boolean; sound: Sound }
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
  // When this device last changed the entry; linked devices keep the newer one.
  changed?: number
  // They have sent a receipt, so they run a version that confirms delivery and a resend is worth it.
  acks?: boolean
}
type Member = { id: string; name: string }
type Group = { id: string; title: string; owner: string; members: Member[]; changed?: number }
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
  // Mine: the device that sent it, and when it last went out again.
  dev?: string
  tried?: number
  // An attached file, sealed on the relay, and where this computer saved it.
  file?: FileRef
  saved?: string
}
// The relay holds the file sealed with `key`, a key of its own that only the sealed message carries.
type FileRef = { url: string; key: string; nonce: string; name: string; mime: string; size: number }
type Notice = { key: string; sys: Sys }
type Envelope = { v: number; from: string; nonce: string; box: string; h?: number }
type Payload =
  | { t: 'request' | 'accept' | 'profile'; id: string; profile: Profile }
  | { t: 'kem'; id: string; kem: string }
  | { t: 'pq'; id: string; ct: string }
  | { t: 'unfriend'; id: string }
  | { t: 'dm'; id: string; name: string; text: string; file?: FileRef }
  | { t: 'edit'; id: string; ref: string; text: string }
  | { t: 'delete'; id: string; ref: string }
  | { t: 'group'; id: string; g: string; name: string; text: string; file?: FileRef }
  | { t: 'invite'; id: string; g: string; title: string; name: string; members: Member[] }
  | { t: 'leave'; id: string; g: string; name: string }
  | { t: 'receipt'; id: string; kind: ReceiptKind; refs: string[] }
  | { t: 'typing'; id: string }
  | SelfPayload
// Messages a device seals for itself, to the shared topic, for the other devices linked to the same identity.
type SelfPayload = {
  t: 'self'
  id: string
  dev: string
  kind: 'part' | 'sent' | 'patch' | 'state' | 'want' | 'have' | 'linked' | 'hello' | 'bye'
  name?: string
  target?: string
  set?: string; i?: number; n?: number; data?: string
  msg?: Msg; msgs?: Msg[]
  ref?: string; patch?: { text?: string; edited?: boolean; deleted?: boolean }
  state?: SyncState
  since?: number
  primary?: boolean
}
// The settings a person changes by hand. Lists merge entry by entry; single values go to the newest.
type SyncState = {
  contacts: Contact[]
  groups: Group[]
  gone: Record<string, number>
  blocked: string[]
  profile: Profile
  muted: string[]
  privacy: Privacy
  readAt: Record<string, number>
  at: Record<'blocked' | 'profile' | 'muted' | 'privacy', number>
}
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
let privacy: Privacy = { readReceipts: true, typing: true, notifications: true, sound: 'auto' }
let muted: string[] = []
// Device linking. deviceId stays on this machine; primary: the device the identity was made on, the one that runs
// ML-KEM encapsulation, since two devices encapsulating would agree on two different keys.
let deviceId = ''
let primary = true
let linked = false
let gone: Record<string, number> = {}
let stateAt: SyncState['at'] = { blocked: 0, profile: 0, muted: 0, privacy: 0 }
let linkPending: { secret: string; until: number } | undefined
const parts = new Map<string, string[]>()
let currentStream: { return?: () => unknown } | undefined
// Linking progress, shown in every session's status line and Devices card; linkTimer polls fast while a code waits.
// The devices linked to this identity, this one included, as each last announced itself.
type Device = { name: string; seen: number; primary: boolean }
let devices: Record<string, Device> = {}
let deviceName = ''
let linkStatus = ''
let linkTimer: { cancel: () => void } | undefined
const LINK_POLL_MS = 2000
let typing: Typing[] = []
// Receipts wait here until the batch they arrived in is handled, then go out one post per person and kind.
const receiptQueue = new Map<string, Set<string>>()
const typingSentAt = new Map<string, number>()
// streaming: a stream loop runs; streamLive: ntfy has opened it, so the poller can rest. streamOff: no curl here.
let streaming = false
let streamLive = false
let streamOff = false
let view: 'chats' | 'people' | 'settings' = 'chats'
let selected = ''
let renaming = ''
let threadOpen = false
let editingProfile = false
let filter = ''
// Bumped after a send so the text field is drawn fresh and empty; a field keeps what was typed while its value stays the same.
let composeSeq = 0
let addSeq = 0
let linkSeq = 0
let restoreSeq = 0
// Recovery words show only in the pane, after a confirmation, and only until hidden.
let shownWords: string[] = []
let backupDir = ''
let backupAt = 0
// No folder dialog could open here, so the card shows a field for a typed path.
let pickerMissing = false
let pluginVersion = ''
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
let restQueued = false
let restTries = 0
// Desktop: the wheel is summed in rows and the window moves a message once the rows add up to one, so a long
// message takes more wheel than a short one, as in a scrolled page. avgRows: the rows a message on screen takes.
let wheelRows = 0
let avgRows = 3
const WHEEL_ROWS = 2
// At most this many messages move per settled burst of the wheel, so the list never leaps; the rest carries over.
const WHEEL_MAX_STEP = 4
const WHEEL_SETTLE_MS = 80
let wheelTimer: { cancel: () => void } | undefined
let newestOpen = ''
const STORE_MESSAGES = 300
const ARCHIVE_TO = 250
let historyHome = ''
// Archived messages brought back per chat, the batch files not yet brought back, and the ones that were.
const older = new Map<string, Msg[]>()
const olderChunks = new Map<string, string[]>()
const loadedChunks = new Set<string>()

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
  if (typeof env.from !== 'string' || !ID_RE.test(env.from)) return undefined
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
  const changed = await $.clock.now()
  contacts = await mutate<Contact>($, 'contacts', cur => [...cur.filter(c => c.id !== contact.id), { ...contact, changed }])
}

async function dropContact($: EngineInterface, id: string) {
  contacts = await mutate<Contact>($, 'contacts', cur => cur.filter(c => c.id !== id))
  await markGone($, id)
  if (selected === convOf(id)) selected = ''
}

// A removed contact or group, so a linked device that still has it drops it too.
async function markGone($: EngineInterface, id: string) {
  const saved = (await $.store.get('gone')) as Record<string, number> | undefined
  gone = { ...(saved && typeof saved === 'object' ? saved : {}), [id]: await $.clock.now() }
  await $.store.set('gone', gone)
}

async function touchState($: EngineInterface, field: keyof SyncState['at']) {
  stateAt = { ...stateAt, [field]: await $.clock.now() }
  await $.store.set('stateAt', stateAt)
}

async function addMessages($: EngineInterface, msgs: Msg[]) {
  if (!msgs.length) return
  let overflow: Msg[] = []
  inbox = await mutate<Msg>($, 'inbox', current => {
    const seen = new Set(current.map(m => m.key))
    const all = [...current, ...msgs.filter(m => !seen.has(m.key))]
    // Past the cap the store drops to ARCHIVE_TO, so the archive grows a batch at a time, not a file per message.
    if (all.length <= STORE_MESSAGES) return all
    overflow = all.slice(0, all.length - ARCHIVE_TO)
    return all.slice(-ARCHIVE_TO)
  })
  if (overflow.length) await archive($, overflow).catch(() => {})
}

// ---- History past the store ----
// The shared store keeps the newest STORE_MESSAGES messages of all chats. Older ones move to files, one per batch,
// in a folder per identity and chat, and come back a batch at a time when the person scrolls past the top.

async function historyDir($: EngineInterface): Promise<string> {
  if (!historyHome) historyHome = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''
  return historyHome ? historyHome + '/.claude/buddy-chat/history/' + hex(nacl.hash(encode(me))).slice(0, 16) : ''
}

const convDir = (dir: string, conv: string) => dir + '/' + hex(nacl.hash(encode(conv))).slice(0, 24)

async function archive($: EngineInterface, msgs: Msg[]) {
  const dir = await historyDir($)
  if (!dir) return
  const byConv = new Map<string, Msg[]>()
  for (const m of msgs) byConv.set(m.conv, [...(byConv.get(m.conv) ?? []), m])
  for (const [conv, list] of byConv) {
    list.sort((a, b) => a.at - b.at)
    const first = list[0]!
    const name = String(first.at).padStart(15, '0') + '-' + first.key.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) + '.json'
    await $.fs.write(convDir(dir, conv) + '/' + name, JSON.stringify(list))
    // A chat being read keeps what just left the store on screen; any other lists its files again when opened.
    if (older.has(conv)) {
      loadedChunks.add(conv + '/' + name)
      const have = new Set((older.get(conv) ?? []).map(m => m.key))
      older.set(conv, [...(older.get(conv) ?? []), ...list.filter(m => !have.has(m.key))])
    } else {
      olderChunks.delete(conv)
    }
  }
}

async function listArchive($: EngineInterface, conv: string): Promise<string[]> {
  const known = olderChunks.get(conv)
  if (known) return known
  const dir = await historyDir($)
  let names: string[] = []
  if (dir) {
    try {
      names = (await $.fs.list(convDir(dir, conv))).filter(e => e.kind === 'file' && e.name.endsWith('.json')).map(e => e.name).sort()
    } catch {
      names = []
    }
  }
  names = names.filter(n => !loadedChunks.has(conv + '/' + n))
  olderChunks.set(conv, names)
  return names
}

// Brings back the newest batch not yet on screen; resolves to how many messages came back.
async function loadOlder($: EngineInterface, conv: string): Promise<number> {
  const names = await listArchive($, conv)
  const name = names.pop()
  if (!name) return 0
  loadedChunks.add(conv + '/' + name)
  let list: Msg[] = []
  try {
    list = asArray<unknown>(JSON.parse(await $.fs.read(convDir(await historyDir($), conv) + '/' + name)))
      .map(cleanMsg).filter((m): m is Msg => !!m && m.conv === conv)
  } catch {
    list = []
  }
  const have = new Set([...(older.get(conv) ?? []), ...inbox].map(m => m.key))
  for (const m of list) shown.add(m.key)
  older.set(conv, [...list.filter(m => !have.has(m.key)), ...(older.get(conv) ?? [])])
  $.ui.invalidate('ui.render')
  return list.length
}

function forgetHistory() {
  older.clear()
  olderChunks.clear()
  loadedChunks.clear()
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
  const c = contactOf(from)
  if (c && !c.acks) await saveContact($, { ...c, acks: true })
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
  await touchState($, 'muted')
  void syncState($).catch(() => {})
  $.ui.invalidate('ui.render')
}

async function setPrivacy($: EngineInterface, patch: Partial<Privacy>) {
  privacy = { ...privacy, ...patch }
  await $.store.set('privacy', privacy)
  await touchState($, 'privacy')
  void syncState($).catch(() => {})
  if (!privacy.typing) typing = []
  $.ui.invalidate('ui.render')
}

// Only the polling session calls this, so each machine gets one OS notification.
// ---- Linked devices ----

const CONV_RE = /^(dm:[A-Za-z0-9_-]{43}|g:[0-9a-f]{16})$/
const idList = (value: unknown) => asArray<unknown>(value).filter((x): x is string => typeof x === 'string' && ID_RE.test(x))

function cleanMsg(value: unknown): Msg | undefined {
  const m = value as Partial<Msg> | null
  if (!m || typeof m.key !== 'string' || m.key.length > 64 || typeof m.conv !== 'string' || !CONV_RE.test(m.conv) || typeof m.at !== 'number') return undefined
  const from = typeof m.from === 'string' ? m.from : ''
  const sys = m.sys && typeof m.sys === 'object' && isKey(m.sys.key) ? m.sys : undefined
  return {
    key: m.key, conv: m.conv, from, name: cleanText(String(m.name ?? ''), 40), text: String(m.text ?? '').slice(0, 4000), at: m.at,
    mine: !!from && from === me,
    ...(m.system ? { system: true } : {}),
    ...(sys ? { sys } : {}),
    ...(m.edited ? { edited: true } : {}),
    ...(m.deleted ? { deleted: true } : {}),
    ...(m.forwarded ? { forwarded: true } : {}),
    ...(m.seen ? { seen: true } : {}),
    ...(m.deliveredTo ? { deliveredTo: idList(m.deliveredTo) } : {}),
    ...(m.readBy ? { readBy: idList(m.readBy) } : {}),
    ...(typeof m.dev === 'string' ? { dev: m.dev.slice(0, 32) } : {}),
    ...(cleanFile(m.file) ? { file: cleanFile(m.file)! } : {}),
  }
}

function cleanContact(value: unknown): Contact | undefined {
  const c = value as Partial<Contact> | null
  if (!c || typeof c.id !== 'string' || !ID_RE.test(c.id) || c.id === me) return undefined
  if (c.state !== 'friend' && c.state !== 'outgoing' && c.state !== 'incoming') return undefined
  return {
    id: c.id, state: c.state, profile: cleanProfile(c.profile), at: typeof c.at === 'number' ? c.at : 0,
    ...(typeof c.nickname === 'string' && c.nickname ? { nickname: cleanText(c.nickname, 40) } : {}),
    ...(typeof c.pq === 'string' ? { pq: c.pq } : {}),
    ...(typeof c.pqPrev === 'string' ? { pqPrev: c.pqPrev } : {}),
    ...(typeof c.changed === 'number' ? { changed: c.changed } : {}),
    ...(c.acks ? { acks: true } : {}),
  }
}

function cleanGroup(value: unknown): Group | undefined {
  const g = value as Partial<Group> | null
  if (!g || typeof g.id !== 'string' || !GROUP_RE.test(g.id) || typeof g.owner !== 'string' || !ID_RE.test(g.owner)) return undefined
  return {
    id: g.id, title: cleanText(String(g.title ?? ''), 40) || t('groupFallbackTitle'), owner: g.owner, members: cleanMembers(g.members),
    ...(typeof g.changed === 'number' ? { changed: g.changed } : {}),
  }
}

function numberMap(value: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) if (typeof v === 'number') out[k] = v
  return out
}

const currentState = (): SyncState => ({ contacts, groups, gone, blocked, profile, muted, privacy, readAt, at: stateAt })

// Seals a payload for our own topic. A long one goes in parts that the other devices put back together.
async function postSelf($: EngineInterface, payload: Omit<SelfPayload, 't' | 'id' | 'dev'>) {
  const full: SelfPayload = { t: 'self', id: newId(), dev: deviceId, ...payload }
  const json = JSON.stringify(full)
  if (json.length <= PART_CHARS) {
    await post($, me, full)
    return
  }
  const set = newId()
  const n = Math.ceil(json.length / PART_CHARS)
  for (let i = 0; i < n; i++) {
    await post($, me, { t: 'self', id: newId(), dev: deviceId, kind: 'part', set, i, n, data: json.slice(i * PART_CHARS, (i + 1) * PART_CHARS) })
  }
}

async function syncState($: EngineInterface) {
  if (linked) await postSelf($, { kind: 'state', state: currentState(), primary })
}

async function receiveSelf($: EngineInterface, p: SelfPayload) {
  if (!linked || typeof p.dev !== 'string' || p.dev === deviceId) return
  switch (p.kind) {
    case 'part': {
      const { set, i, n, data } = p
      if (typeof set !== 'string' || typeof data !== 'string' || !Number.isInteger(i) || !Number.isInteger(n)) return
      if (n! < 1 || n! > 200 || i! < 0 || i! >= n!) return
      const got = parts.get(set) ?? Array.from({ length: n! }, () => '')
      got[i!] = data
      parts.set(set, got)
      if (got.some(x => !x)) return
      parts.delete(set)
      let whole: SelfPayload
      try { whole = JSON.parse(got.join('')) } catch { return }
      if (whole?.t === 'self' && whole.kind !== 'part' && whole.dev === p.dev) await receiveSelf($, whole)
      return
    }
    case 'sent': {
      const m = cleanMsg(p.msg)
      if (m?.mine) {
        shown.add(m.key)
        await addMessages($, [m])
      }
      return
    }
    case 'patch': {
      if (typeof p.ref !== 'string' || !p.patch) return
      const patch: Partial<Msg> = {}
      if (typeof p.patch.text === 'string') patch.text = p.patch.text.slice(0, 4000)
      if (p.patch.edited) patch.edited = true
      if (p.patch.deleted) patch.deleted = true
      await patchMessage($, p.ref, me, patch)
      return
    }
    case 'state':
      if (p.state) await mergeState($, p.state, p.primary === true)
      return
    case 'want': {
      if (typeof p.since !== 'number') return
      const msgs = inbox.filter(m => m.at >= p.since!).slice(-CATCHUP_MAX)
      await postSelf($, { kind: 'have', msgs, state: currentState(), primary })
      return
    }
    case 'linked':
      $.ui.toast(t('linkConfirmed'))
      await setLinkStatus($, t('linkStatusConfirmed'), 15_000)
      await saveDevice($, p.dev, { name: cleanText(String(p.name ?? ''), 40) || p.dev.slice(0, 6), seen: await $.clock.now(), primary: false })
      await announce($)
      return
    case 'hello': {
      const known = !!devices[p.dev]
      await saveDevice($, p.dev, { name: cleanText(String(p.name ?? ''), 40) || p.dev.slice(0, 6), seen: await $.clock.now(), primary: p.primary === true })
      // A device we did not know yet learns about this one too.
      if (!known) await announce($)
      return
    }
    case 'bye':
      if (p.target === deviceId) {
        await resetAccount($)
        $.ui.toast(t('removedHere'))
      } else {
        await saveDevice($, typeof p.target === 'string' ? p.target : p.dev, undefined)
      }
      return
    case 'have': {
      const msgs = asArray<unknown>(p.msgs).map(cleanMsg).filter((m): m is Msg => !!m)
      // What another device kept while this one was away is history here, not news.
      for (const m of msgs) shown.add(m.key)
      await addMessages($, msgs)
      if (p.state) await mergeState($, p.state, p.primary === true)
      return
    }
  }
}

// Lists merge entry by entry, the newer change winning; a removal wins over older entries.
async function mergeState($: EngineInterface, st: SyncState, fromPrimary: boolean) {
  const theirGone = numberMap(st.gone)
  const saved = numberMap(await $.store.get('gone'))
  for (const [id, at] of Object.entries(theirGone)) if (at > (saved[id] ?? 0)) saved[id] = at
  gone = saved
  await $.store.set('gone', gone)
  const alive = <T extends { id: string; changed?: number }>(x: T) => !(gone[x.id] && gone[x.id]! >= (x.changed ?? 0))

  const theirContacts = asArray<unknown>(st.contacts).map(cleanContact).filter((c): c is Contact => !!c)
  contacts = await mutate<Contact>($, 'contacts', current => {
    const out = new Map(current.map(c => [c.id, c]))
    for (const c of theirContacts) {
      const mine = out.get(c.id)
      let next = !mine || (c.changed ?? 0) > (mine.changed ?? 0) ? c : mine
      // Only the primary runs encapsulation, so its ML-KEM keys win and another device's copy never replaces them.
      if (fromPrimary && c.pq) next = { ...next, pq: c.pq, pqPrev: c.pqPrev }
      else if (!fromPrimary && mine) next = { ...next, pq: mine.pq, pqPrev: mine.pqPrev }
      out.set(c.id, next)
    }
    return [...out.values()].filter(alive)
  })
  const theirGroups = asArray<unknown>(st.groups).map(cleanGroup).filter((g): g is Group => !!g)
  groups = await mutate<Group>($, 'groups', current => {
    const out = new Map(current.map(g => [g.id, g]))
    for (const g of theirGroups) {
      const mine = out.get(g.id)
      if (!mine || (g.changed ?? 0) > (mine.changed ?? 0)) out.set(g.id, g)
    }
    return [...out.values()].filter(alive)
  })

  const at = numberMap(st.at)
  if ((at.blocked ?? 0) > stateAt.blocked) {
    blocked = idList(st.blocked)
    await $.store.set('blocked', blocked)
  }
  if ((at.profile ?? 0) > stateAt.profile) {
    profile = cleanProfile(st.profile)
    await $.store.set('profile', profile)
    await $.store.set('profileSent', JSON.stringify(profile))
  }
  if ((at.muted ?? 0) > stateAt.muted) {
    muted = asArray<unknown>(st.muted).filter((c): c is string => typeof c === 'string' && CONV_RE.test(c))
    await $.store.set('muted', muted)
  }
  if ((at.privacy ?? 0) > stateAt.privacy && st.privacy && typeof st.privacy === 'object') {
    privacy = cleanPrivacy(st.privacy)
    await $.store.set('privacy', privacy)
  }
  stateAt = {
    blocked: Math.max(stateAt.blocked, at.blocked ?? 0), profile: Math.max(stateAt.profile, at.profile ?? 0),
    muted: Math.max(stateAt.muted, at.muted ?? 0), privacy: Math.max(stateAt.privacy, at.privacy ?? 0),
  }
  await $.store.set('stateAt', stateAt)
  const theirRead = numberMap(st.readAt)
  const marks = { ...readAt }
  for (const [conv, when] of Object.entries(theirRead)) if (CONV_RE.test(conv) && when > (marks[conv] ?? 0)) marks[conv] = when
  readAt = marks
  await $.store.set('readAt', readAt)
  $.ui.invalidate('ui.render')
}

// A message the recipient never confirmed goes out again before ntfy drops the last copy, for up to a week.
// Only to people whose version sends receipts, and only from the device that sent it.
async function retryUnconfirmed($: EngineInterface) {
  const now = await $.clock.now()
  let budget = RETRY_PER_TICK
  for (const m of inbox) {
    if (!budget) break
    if (!m.mine || m.system || m.deleted || m.state || now - m.at > RETRY_MAX_MS || now - (m.tried ?? m.at) < RETRY_MS) continue
    if (m.dev ? m.dev !== deviceId : !primary) continue
    const targets = recipients(m.conv).filter(r => !m.deliveredTo?.includes(r.id) && contactOf(r.id)?.acks)
    if (!targets.length) continue
    budget--
    const group = groups.find(g => groupConv(g.id) === m.conv)
    for (const r of targets) {
      const file = m.file ? { file: m.file } : {}
      await post($, r.id, group ? { t: 'group', id: m.key, g: group.id, name: myPublicName(), text: m.text, ...file } : { t: 'dm', id: m.key, name: myPublicName(), text: m.text, ...file })
    }
    await patchMessage($, m.key, me, { tried: now })
  }
}

function joinBytes(...chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

// The link code is a 32-byte secret: its hash names a one-off topic, and a second hash keys the snapshot.
const linkKey = (secret: Uint8Array) => nacl.hash(joinBytes(secret, encode('buddy-chat link v1'))).slice(0, 32)
const linkTopic = (secret: Uint8Array) => RELAY + '/buddy-chat-link-' + hex(nacl.hash(joinBytes(secret, encode('buddy-chat link topic')))).slice(0, 32)
const linkCode = () => (linkPending ? 'buddylink-' + linkPending.secret : '')

async function setLinkStatus($: EngineInterface, text: string, clearAfterMs = 0) {
  linkStatus = text
  await $.store.set('linkStatus', text)
  $.ui.status(text ? 'buddy-chat: ' + text : undefined)
  $.ui.invalidate('ui.render')
  if (clearAfterMs) $.clock.after(clearAfterMs, () => { if (linkStatus === text) void setLinkStatus($, '').catch(() => {}) })
}

function stopLinkPolling() {
  linkTimer?.cancel()
  linkTimer = undefined
}

async function saveDevice($: EngineInterface, dev: string, entry: Device | undefined) {
  const saved = ((await $.store.get('devices')) as Record<string, Device> | undefined) ?? {}
  const next = { ...saved }
  if (entry) next[dev] = entry
  else delete next[dev]
  devices = next
  await $.store.set('devices', devices)
  $.ui.invalidate('ui.render')
}

async function announce($: EngineInterface) {
  if (!linked) return
  await saveDevice($, deviceId, { name: deviceName, seen: await $.clock.now(), primary })
  await postSelf($, { kind: 'hello', name: deviceName, primary })
}

// Removing a device is a request the device carries out: it deletes the account here and starts over with a new identity.
// A device that is off does it when it comes back; one that was changed to ignore it keeps the keys, which only a new identity fixes.
// With `entropy` the identity those recovery words hold comes back; without it a new one is made.
async function resetAccount($: EngineInterface, entropy?: Uint8Array) {
  for (const key of ['secretKey', 'kemSeed', 'recovery', 'contacts', 'groups', 'inbox', 'blocked', 'gone', 'readAt', 'muted', 'stateAt', 'lastSeen',
    'linked', 'primary', 'devices', 'profile', 'profileSent', 'notices', 'typing', 'linkPending', 'activeAt']) {
    await $.store.delete(key)
  }
  sharedKeys.clear()
  hybridKeys.clear()
  topics.clear()
  forgetHistory()
  keys = undefined
  if (entropy) {
    const derived = keysFromEntropy(entropy)
    await $.store.set('secretKey', b64(derived.secretKey))
    await $.store.set('kemSeed', b64(derived.kemSeed))
    if (entropy.length === 16) await $.store.set('recovery', b64(entropy))
  }
  await loadIdentity($)
  linked = false
  primary = true
  devices = {}
  selected = ''
  threadOpen = false
  currentStream?.return?.()
  streamLive = false
  await refresh($, true)
  $.ui.invalidate('ui.render')
}

async function leaveLink($: EngineInterface): Promise<string> {
  if (!linked || primary) return t('leaveNotLinked')
  if (!(await confirm($, t('leaveConfirm'), t('leaveYes')))) return t('linkCancelled')
  await postSelf($, { kind: 'bye' })
  await resetAccount($)
  return t('leaveDone')
}

async function removeDevice($: EngineInterface, dev: string): Promise<string> {
  const d = devices[dev]
  if (!d || dev === deviceId) return t('removeUnknown')
  if (!(await confirm($, t('removeConfirm', { name: d.name }), t('removeYes')))) return t('linkCancelled')
  await postSelf($, { kind: 'bye', target: dev })
  await saveDevice($, dev, undefined)
  return t('removeSent', { name: d.name })
}

// On the new device: wait for a snapshot. Its own identity is replaced when the snapshot arrives.
async function startLink($: EngineInterface): Promise<string> {
  if (contacts.length && !(await confirm($, t('linkReplaceConfirm'), t('linkReplaceYes')))) return t('linkCancelled')
  linkPending = { secret: b64(nacl.randomBytes(32)), until: (await $.clock.now()) + LINK_TTL_MS }
  await $.store.set('linkPending', linkPending)
  await setLinkStatus($, t('linkStatusWaiting', { min: Math.ceil(LINK_TTL_MS / 60_000) }))
  stopLinkPolling()
  linkTimer = $.clock.every(LINK_POLL_MS, () => { void serial(() => pollLink($)).catch(() => {}) })
  return t('linkStarted', { code: linkCode() })
}

async function cancelLink($: EngineInterface) {
  linkPending = undefined
  stopLinkPolling()
  await $.store.delete('linkPending')
  await setLinkStatus($, '')
}

// On the device that has the identity: seal everything for the code's holder and post it to the code's topic.
async function sendLink($: EngineInterface, text: string): Promise<string> {
  const match = LINK_RE.exec(text)
  if (!match) return t('linkBadCode')
  let secret: Uint8Array
  try { secret = unb64(match[1]!) } catch { return t('linkBadCode') }
  if (secret.length !== 32) return t('linkBadCode')
  if (linkPending && match[1] === linkPending.secret) return t('linkOwnCode')
  if (!(await confirm($, t('linkConfirm'), t('linkConfirmYes')))) return t('linkCancelled')

  const snapshot = {
    v: 1, secretKey: await $.store.get('secretKey'), kemSeed: await $.store.get('kemSeed'), recovery: await $.store.get('recovery'),
    lastSeen: await $.store.get('lastSeen'), lang, ...currentState(), inbox: [...inbox],
  }
  let json = JSON.stringify(snapshot)
  while (json.length > SNAPSHOT_MAX_CHARS && snapshot.inbox.length) {
    snapshot.inbox.splice(0, Math.ceil(snapshot.inbox.length / 4))
    json = JSON.stringify(snapshot)
  }
  const bytes = encode(json)
  const key = linkKey(secret)
  const set = newId()
  const size = 2200
  const n = Math.ceil(bytes.length / size)
  for (let i = 0; i < n; i++) {
    await setLinkStatus($, t('linkStatusSending', { got: i + 1, n }))
    const nonce = nacl.randomBytes(24)
    const box = nacl.secretbox(bytes.slice(i * size, (i + 1) * size), nonce, key)
    const body = JSON.stringify({ v: 1, set, i, n, nonce: b64(nonce), box: b64(box) })
    try {
      const res = await $.http.fetch(linkTopic(secret), { method: 'POST', body })
      if (!res.ok) {
        await setLinkStatus($, '')
        return t('linkFailed', { error: String(res.status) })
      }
    } catch (err) {
      await setLinkStatus($, '')
      return t('linkFailed', { error: String(err) })
    }
  }
  linked = true
  await $.store.set('linked', true)
  await saveDevice($, deviceId, { name: deviceName, seen: await $.clock.now(), primary })
  // The new device says so once it uses the account; until then this waits, and gives up after the code's lifetime.
  await setLinkStatus($, t('linkStatusWaitingNew'), LINK_TTL_MS)
  return t('linkSent')
}

async function pollLink($: EngineInterface) {
  if (!linkPending) return
  const now = await $.clock.now()
  if (now > linkPending.until) {
    await cancelLink($)
    $.ui.toast(t('linkExpired'))
    return
  }
  if (!linkTimer) linkTimer = $.clock.every(LINK_POLL_MS, () => { void serial(() => pollLink($)).catch(() => {}) })
  const secret = unb64(linkPending.secret)
  let res
  try { res = await $.http.fetch(linkTopic(secret) + '/json?poll=1&since=all') } catch { return }
  if (!res.ok) return
  const key = linkKey(secret)
  const sets = new Map<string, Uint8Array[]>()
  let best = { got: 0, n: 0 }
  for (const line of res.text.split('\n')) {
    let frame: { set?: unknown; i?: unknown; n?: unknown; nonce?: unknown; box?: unknown }
    try { frame = JSON.parse(JSON.parse(line).message) } catch { continue }
    const { set, i, n, nonce, box } = frame
    if (typeof set !== 'string' || typeof i !== 'number' || typeof n !== 'number' || typeof nonce !== 'string' || typeof box !== 'string') continue
    if (n < 1 || n > 200 || i < 0 || i >= n) continue
    let plain: Uint8Array | null = null
    try { plain = nacl.secretbox.open(unb64(box), unb64(nonce), key) } catch { plain = null }
    if (!plain) continue
    const got = sets.get(set) ?? new Array<Uint8Array>(n)
    got[i] = plain
    sets.set(set, got)
    const have = got.filter(Boolean).length
    if (have > best.got) best = { got: have, n }
    if (have === n) {
      let snapshot: unknown
      try { snapshot = JSON.parse(new TextDecoder().decode(joinBytes(...got))) } catch { continue }
      await setLinkStatus($, t('linkStatusApplying'))
      if (await applySnapshot($, snapshot)) {
        stopLinkPolling()
        await setLinkStatus($, t('linkStatusDone'), 15_000)
        await saveDevice($, deviceId, { name: deviceName, seen: await $.clock.now(), primary: false })
        await postSelf($, { kind: 'linked', name: deviceName })
        return
      }
    }
  }
  await setLinkStatus($, best.n
    ? t('linkStatusReceiving', best)
    : t('linkStatusWaiting', { min: Math.max(1, Math.ceil((linkPending.until - now) / 60_000)) }))
}

// fromBackup: this device's own backup, so it stays the main device and is linked to nothing.
async function applySnapshot($: EngineInterface, value: unknown, fromBackup = false): Promise<boolean> {
  const snap = value as Partial<SyncState> & {
    v?: number; secretKey?: unknown; kemSeed?: unknown; recovery?: unknown; lastSeen?: unknown; lang?: unknown; inbox?: unknown
  }
  if (!snap || snap.v !== 1 || typeof snap.secretKey !== 'string' || typeof snap.kemSeed !== 'string') return false
  try { nacl.box.keyPair.fromSecretKey(unb64(snap.secretKey)) } catch { return false }

  await $.store.set('secretKey', snap.secretKey)
  await $.store.set('kemSeed', snap.kemSeed)
  if (typeof snap.recovery === 'string') await $.store.set('recovery', snap.recovery)
  else await $.store.delete('recovery')
  sharedKeys.clear()
  hybridKeys.clear()
  topics.clear()
  forgetHistory()
  await loadIdentity($)

  const now = await $.clock.now()
  const msgs = asArray<unknown>(snap.inbox).map(cleanMsg).filter((m): m is Msg => !!m)
  for (const m of msgs) shown.add(m.key)
  await $.store.set('contacts', asArray<unknown>(snap.contacts).map(cleanContact).filter(Boolean))
  await $.store.set('groups', asArray<unknown>(snap.groups).map(cleanGroup).filter(Boolean))
  await $.store.set('inbox', msgs)
  await $.store.set('blocked', idList(snap.blocked))
  await $.store.set('gone', numberMap(snap.gone))
  await $.store.set('readAt', numberMap(snap.readAt))
  await $.store.set('muted', asArray<unknown>(snap.muted).filter((c): c is string => typeof c === 'string' && CONV_RE.test(c)))
  const p = cleanProfile(snap.profile)
  await $.store.set('profile', p)
  await $.store.set('profileSent', JSON.stringify(p))
  if (snap.privacy && typeof snap.privacy === 'object') await $.store.set('privacy', cleanPrivacy(snap.privacy))
  await $.store.set('stateAt', { blocked: 0, profile: 0, muted: 0, privacy: 0, ...numberMap(snap.at) })
  if (isLang(snap.lang)) await $.store.set('lang', snap.lang)
  if (typeof snap.lastSeen === 'string') await $.store.set('lastSeen', snap.lastSeen)
  else await $.store.delete('lastSeen')
  await $.store.set('primary', fromBackup)
  await $.store.set('linked', !fromBackup)
  await $.store.set('activeAt', now)
  await $.store.delete('linkPending')
  linkPending = undefined
  primary = fromBackup
  linked = !fromBackup
  // The stream listened on the old identity's topic; the loop opens it again on the new one.
  currentStream?.return?.()
  streamLive = false
  await refresh($, true)
  if (!fromBackup) $.ui.toast(t('linkDone'))
  return true
}

// ---- Recovery words and backups ----

const BACKUP_EVERY_MS = 10 * 60_000
let backupSignature = ''

async function recoveryEntropy($: EngineInterface): Promise<Uint8Array> {
  const saved = await $.store.get('recovery')
  return typeof saved === 'string' ? unb64(saved) : keys!.secretKey
}

const recoveryWords = async ($: EngineInterface) => toWords(await recoveryEntropy($))

async function restoreFromWords($: EngineInterface, text: string): Promise<string> {
  const entropy = fromWords(text)
  if (!entropy) return t('restoreBadWords')
  const id = b64(nacl.box.keyPair.fromSecretKey(keysFromEntropy(entropy).secretKey).publicKey)
  if (id === me) return t('restoreSame')
  if (contacts.length && !(await confirm($, t('restoreConfirm'), t('restoreYes')))) return t('linkCancelled')
  await resetAccount($, entropy)
  return t('restoreDone')
}

// Opens the system's folder dialog: AppleScript on macOS, zenity on Linux, PowerShell on Windows.
// Resolves to the folder, or undefined when cancelled; with no dialog at all it turns on the typed-path field.
const chooseFolder = ($: EngineInterface, prompt: string) => choosePath($, prompt, 'folder')

async function choosePath($: EngineInterface, prompt: string, kind: 'folder' | 'file'): Promise<string | undefined> {
  const tries: string[][] = kind === 'folder'
    ? [
      ['osascript', '-e', 'POSIX path of (choose folder with prompt ' + JSON.stringify(prompt) + ')'],
      ['zenity', '--file-selection', '--directory', '--title=' + prompt],
      ['powershell', '-NoProfile', '-Command',
        'Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; if ($d.ShowDialog() -eq "OK") { $d.SelectedPath }'],
    ]
    : [
      ['osascript', '-e', 'POSIX path of (choose file with prompt ' + JSON.stringify(prompt) + ')'],
      ['zenity', '--file-selection', '--title=' + prompt],
      ['powershell', '-NoProfile', '-Command',
        'Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; if ($d.ShowDialog() -eq "OK") { $d.FileName }'],
    ]
  for (const argv of tries) {
    let result
    try {
      result = await $.process.run(argv, { timeoutMs: 300_000 })
    } catch {
      continue
    }
    const path = result.stdout.trim()
    return result.exitCode === 0 && path ? path.replace(/\/+$/, '') : undefined
  }
  pickerMissing = true
  $.ui.invalidate('ui.render')
  $.ui.toast(t('backupNoPicker'))
  return undefined
}

// ---- Files ----

const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', aac: 'audio/aac',
  pdf: 'application/pdf', txt: 'text/plain', zip: 'application/zip',
}
const mimeOf = (name: string) => MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'
const std64 = (bytes: Uint8Array) => b64(bytes).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64(bytes).length % 4)) % 4)
// A name safe to save under: no folders, no leading dot, no characters a file system refuses.
const safeName = (name: string) => cleanText(name, 120).replace(/[\/\\:*?"<>|]/g, '_').replace(/^\.+/, '') || 'file'
const sizeText = (n: number) => (n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1024 / 1024).toFixed(1) + ' MB')
const fileIcon = (mime: string) => (mime.startsWith('image/') ? '🖼' : mime.startsWith('video/') ? '🎬' : mime.startsWith('audio/') ? '🎵' : '📎')

function cleanFile(value: unknown): FileRef | undefined {
  const f = value as Partial<FileRef> | null
  if (!f || typeof f.url !== 'string' || !FILE_URL_RE.test(f.url) || typeof f.key !== 'string' || typeof f.nonce !== 'string') return undefined
  const name = safeName(String(f.name ?? ''))
  return { url: f.url, key: f.key, nonce: f.nonce, name, mime: mimeOf(name), size: typeof f.size === 'number' ? f.size : 0 }
}

// $.fs.write takes text, so the bytes go through the system's base64 tool: macOS, then Linux, then Windows.
async function writeBytes($: EngineInterface, path: string, base64: string): Promise<boolean> {
  await $.fs.write(path, '')
  const tries: string[][] = [
    ['base64', '-D', '-o', path],
    ['sh', '-c', 'base64 -d > "$1"', 'sh', path],
    ['powershell', '-NoProfile', '-Command', '[IO.File]::WriteAllBytes($args[0], [Convert]::FromBase64String([Console]::In.ReadToEnd()))', path],
  ]
  for (const argv of tries) {
    try {
      if ((await $.process.run(argv, { stdin: base64, timeoutMs: 60_000 })).exitCode === 0) return true
    } catch {
      // not on this system
    }
  }
  return false
}

async function openPath($: EngineInterface, path: string) {
  for (const argv of [['open', path], ['xdg-open', path], ['cmd', '/c', 'start', '', path]]) {
    try {
      if ((await $.process.run(argv, { timeoutMs: 10_000 })).exitCode === 0) return
    } catch {
      // not on this system
    }
  }
  $.ui.toast(t('fileOpenFailed'))
}

// Seals the file with a key of its own and leaves it on the relay; the message carries that key, sealed per person.
async function attachFile($: EngineInterface, conv: string): Promise<Outcome> {
  const path = await choosePath($, t('attachPrompt'), 'file')
  if (!path) return { ok: false, text: '' }
  let size = 0
  try { size = (await $.fs.stat(path)).size } catch { return { ok: false, text: t('fileReadFailed') } }
  if (size > MAX_FILE_BYTES) return { ok: false, text: t('fileTooBig', { max: '3 MB' }) }
  let bytes: Uint8Array
  try { bytes = unb64((await $.fs.read(path, { as: 'bytes' })).base64) } catch { return { ok: false, text: t('fileReadFailed') } }
  const key = nacl.randomBytes(32)
  const nonce = nacl.randomBytes(24)
  const box = nacl.secretbox(bytes, nonce, key)
  let url = ''
  try {
    const res = await $.http.fetch(RELAY + '/buddy-chat-f-' + hex(nacl.randomBytes(16)), { method: 'PUT', headers: { Filename: 'file.bin' }, body: b64(box) })
    url = String((JSON.parse(res.text) as { attachment?: { url?: unknown } }).attachment?.url ?? '')
  } catch {
    url = ''
  }
  if (!FILE_URL_RE.test(url)) return { ok: false, text: t('fileUploadFailed') }
  const name = safeName(path.split(/[\/\\]/).pop() ?? 'file')
  const file: FileRef = { url, key: b64(key), nonce: b64(nonce), name, mime: mimeOf(name), size }
  return sendText($, conv, '📎 ' + name, file, path)
}

// Fetches a received file while the relay still has it (3 hours) and saves it under ~/Downloads/buddy-chat.
async function downloadFile($: EngineInterface, msg: Msg): Promise<boolean> {
  if (!msg.file) return false
  let plain: Uint8Array | null = null
  try {
    const res = await $.http.fetch(msg.file.url)
    if (res.ok) plain = nacl.secretbox.open(unb64(res.text.trim()), unb64(msg.file.nonce), unb64(msg.file.key))
  } catch {
    plain = null
  }
  if (!plain) return false
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''
  if (!home) return false
  const path = home + '/Downloads/buddy-chat/' + msg.key.slice(0, 6) + '-' + msg.file.name
  if (!(await writeBytes($, path, std64(plain)))) return false
  await patchMessage($, msg.key, msg.from, { saved: path })
  $.ui.invalidate('ui.render')
  return true
}

async function playFile($: EngineInterface, msg: Msg) {
  if (!msg.saved || !msg.file) return
  try {
    const { base64 } = await $.fs.read(msg.saved, { as: 'bytes' })
    await $.audio.play({ base64, mime: msg.file.mime })
  } catch {
    $.ui.toast(t('filePlayFailed'))
  }
}

async function expandPath($: EngineInterface, path: string): Promise<string> {
  const p = path.trim()
  if (!p.startsWith('~')) return p
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''
  return home + p.slice(1)
}

// A backup is a folder: account.backup with the store's snapshot, and a sealed copy of each archived history file.
const backupRoot = (dir: string) => dir.replace(/\/+$/, '') + '/buddy-chat-' + hex(nacl.hash(encode(me))).slice(0, 12)

function sealBackup(text: string): string {
  const nonce = nacl.randomBytes(24)
  const box = nacl.secretbox(encode(text), nonce, backupKey(keys!.secretKey))
  return JSON.stringify({ v: 1, kind: 'buddy-chat-backup', id: me, nonce: b64(nonce), box: b64(box) })
}

// Resolves to the text, 'other' for another account's file, or undefined when it does not open.
function openBackup(text: string): string | 'other' | undefined {
  let file: { kind?: string; id?: string; nonce?: string; box?: string }
  try { file = JSON.parse(text) } catch { return undefined }
  if (file?.kind !== 'buddy-chat-backup' || typeof file.nonce !== 'string' || typeof file.box !== 'string') return undefined
  if (file.id !== me) return 'other'
  let plain: Uint8Array | null = null
  try { plain = nacl.secretbox.open(unb64(file.box), unb64(file.nonce), backupKey(keys!.secretKey)) } catch { plain = null }
  return plain ? new TextDecoder().decode(plain) : undefined
}

const dirsIn = async ($: EngineInterface, path: string) => {
  try { return (await $.fs.list(path)).filter(e => e.kind === 'dir').map(e => e.name) } catch { return [] }
}
const filesIn = async ($: EngineInterface, path: string, ext: string) => {
  try { return (await $.fs.list(path)).filter(e => e.kind === 'file' && e.name.endsWith(ext)).map(e => e.name) } catch { return [] }
}

async function writeBackup($: EngineInterface): Promise<string> {
  const dir = await $.store.get('backupDir')
  if (typeof dir !== 'string' || !dir) return t('backupOff')
  const root = backupRoot(dir)
  const snapshot = {
    v: 1, secretKey: await $.store.get('secretKey'), kemSeed: await $.store.get('kemSeed'), recovery: await $.store.get('recovery'),
    lastSeen: await $.store.get('lastSeen'), lang, ...currentState(), inbox: [...inbox],
  }
  try {
    await $.fs.write(root + '/account.backup', sealBackup(JSON.stringify(snapshot)))
    // Archived files never change, so only the ones the backup does not have yet are copied.
    const history = await historyDir($)
    if (history) {
      for (const conv of await dirsIn($, history)) {
        const have = new Set(await filesIn($, root + '/history/' + conv, '.backup'))
        for (const name of await filesIn($, history + '/' + conv, '.json')) {
          const target = name.replace(/\.json$/, '.backup')
          if (have.has(target)) continue
          await $.fs.write(root + '/history/' + conv + '/' + target, sealBackup(await $.fs.read(history + '/' + conv + '/' + name)))
        }
      }
    }
  } catch (err) {
    return t('backupFailed', { error: String(err) })
  }
  await $.store.set('backupAt', await $.clock.now())
  return t('backupWritten', { path: root })
}

async function setBackupDir($: EngineInterface, path: string): Promise<string> {
  if (!path.trim()) {
    await $.store.delete('backupDir')
    $.ui.invalidate('ui.render')
    return t('backupOff')
  }
  await $.store.set('backupDir', await expandPath($, path))
  backupSignature = ''
  const result = await writeBackup($)
  $.ui.invalidate('ui.render')
  return result
}

// Runs on the polling session: a backup when something changed and the last one is old enough.
async function backupIfDue($: EngineInterface, now: number) {
  const dir = await $.store.get('backupDir')
  if (typeof dir !== 'string' || !dir) return
  const at = Number(await $.store.get('backupAt')) || 0
  if (now - at < BACKUP_EVERY_MS || signature === backupSignature) return
  backupSignature = signature
  await writeBackup($)
}

// Takes the backup folder, its account.backup, or the folder it was written into.
async function loadBackup($: EngineInterface, path: string): Promise<string> {
  const given = (await expandPath($, path)).replace(/\/+$/, '')
  const roots = given.endsWith('.backup') ? [given.slice(0, given.lastIndexOf('/'))] : [given, backupRoot(given)]
  let root = ''
  let text: string | 'other' | undefined
  for (const candidate of roots) {
    try { text = openBackup(await $.fs.read(candidate + '/account.backup')) } catch { continue }
    root = candidate
    break
  }
  if (text === 'other') return t('backupOtherAccount')
  if (!text) return t('backupUnreadable')
  let snapshot: unknown
  try { snapshot = JSON.parse(text) } catch { return t('backupUnreadable') }
  if (!(await applySnapshot($, snapshot, true))) return t('backupUnreadable')

  const history = await historyDir($)
  let restored = 0
  if (history) {
    for (const conv of await dirsIn($, root + '/history')) {
      for (const name of await filesIn($, root + '/history/' + conv, '.backup')) {
        let plain: string | 'other' | undefined
        try { plain = openBackup(await $.fs.read(root + '/history/' + conv + '/' + name)) } catch { continue }
        if (!plain || plain === 'other') continue
        await $.fs.write(history + '/' + conv + '/' + name.replace(/\.backup$/, '.json'), plain)
        restored++
      }
    }
  }
  forgetHistory()
  $.ui.invalidate('ui.render')
  return t('backupLoaded') + (restored ? ' ' + t('backupHistoryLoaded', { count: restored }) : '')
}

const isOnScreen = (conv: string) => threadOpen && selected === conv

// conv: the chat it is about, so a muted chat stays quiet.
function cleanPrivacy(value: unknown): Privacy {
  const p = (value && typeof value === 'object' ? value : {}) as Partial<Privacy>
  return {
    readReceipts: p.readReceipts !== false,
    typing: p.typing !== false,
    notifications: p.notifications !== false,
    sound: p.sound === 'on' || p.sound === 'off' ? p.sound : 'auto',
  }
}

const SOUND_GAP_MS = 2000
let soundAt = 0

// A bell or a banner from the terminal may already make a sound, which the mod cannot hear; 'auto' stays quiet then.
async function chime($: EngineInterface, sent: boolean) {
  if (privacy.sound === 'off' || (privacy.sound === 'auto' && sent)) return
  const now = await $.clock.now()
  if (now - soundAt < SOUND_GAP_MS) return
  soundAt = now
  await $.audio.play({ asset: 'sounds/message.wav' })
}

function notify($: EngineInterface, title: string, text: string, conv?: string) {
  if (!privacy.notifications || (conv && (muted.includes(conv) || isOnScreen(conv)))) return
  void $.ui.notify(text.slice(0, 200), { title })
    .then(r => chime($, r.isSent), () => chime($, false))
    .catch(() => {})
}

// Events that belong to no chat; every session shows each one once as a toast.
async function addNotice($: EngineInterface, key: string, sys: Sys) {
  await mutate<Notice>($, 'notices', cur => [...cur.filter(n => n.key !== key), { key, sys }].slice(-20))
}

async function saveGroup($: EngineInterface, group: Group) {
  const changed = await $.clock.now()
  groups = await mutate<Group>($, 'groups', current => [...current.filter(g => g.id !== group.id), { ...group, changed }])
}

async function dropGroup($: EngineInterface, id: string) {
  groups = await mutate<Group>($, 'groups', current => current.filter(g => g.id !== id))
  await markGone($, id)
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
  // Sealed with our own key: only another device of ours can have written it.
  if (env.from === me) {
    if (opened.p.t === 'self') await receiveSelf($, opened.p)
    return
  }
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
        // Of our devices only the primary does, and its key reaches the others with the next state.
        if (!primary) return
        let enc: { cipherText: Uint8Array; sharedSecret: Uint8Array }
        try { enc = ml_kem768.encapsulate(unb64(String(p.kem))) } catch { return }
        await saveContact($, { ...c, pq: b64(enc.sharedSecret), pqPrev: c.pq })
        await post($, env.from, { t: 'pq', id: newId(), ct: b64(enc.cipherText) })
        void syncState($).catch(() => {})
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
      const file = cleanFile(p.file)
      const msg: Msg = { key: p.id, conv: convOf(env.from), from: env.from, name: ownName(c.profile), text, at, mine: false, ...(file ? { file } : {}) }
      await addMessages($, [msg])
      if (file) void downloadFile($, msg).catch(() => {})
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
    case 'self':
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
    const file = cleanFile(p.file)
    const msg: Msg = { key: p.id, conv: groupConv(group.id), from: env.from, name: member.name, text, at, mine: false, ...(file ? { file } : {}) }
    await addMessages($, [msg])
    if (file) void downloadFile($, msg).catch(() => {})
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
  privacy = cleanPrivacy(savedPrivacy)
  muted = asArray<string>(await $.store.get('muted'))
  primary = (await $.store.get('primary')) !== false
  const savedDevices = await $.store.get('devices')
  devices = savedDevices && typeof savedDevices === 'object' ? (savedDevices as Record<string, Device>) : {}
  linked = (await $.store.get('linked')) === true
  gone = numberMap(await $.store.get('gone'))
  stateAt = { blocked: 0, profile: 0, muted: 0, privacy: 0, ...numberMap(await $.store.get('stateAt')) }
  const savedDir = await $.store.get('backupDir')
  backupDir = typeof savedDir === 'string' ? savedDir : ''
  backupAt = Number(await $.store.get('backupAt')) || 0
  const savedStatus = await $.store.get('linkStatus')
  const nextStatus = typeof savedStatus === 'string' ? savedStatus : ''
  if (nextStatus !== linkStatus) {
    linkStatus = nextStatus
    $.ui.status(linkStatus ? 'buddy-chat: ' + linkStatus : undefined)
  }
  const pending = (await $.store.get('linkPending')) as typeof linkPending
  linkPending = pending && typeof pending.secret === 'string' && typeof pending.until === 'number' ? pending : undefined
  typing = privacy.typing ? asArray<Typing>(await $.store.get('typing')) : []
  pollerAt = ((await $.store.get('poller')) as { at?: number } | undefined)?.at ?? 0
  if (selected && !conversations().some(c => c.id === selected)) selected = ''

  // An open pane already shows new messages and requests; a toast would only cover its composer.
  let paneShown = false
  if (!quiet) {
    try { paneShown = (await $.ui.panes()).some(p => p.id === PANE && p.isShown) } catch { paneShown = false }
  }
  for (const m of inbox) {
    if (shown.has(m.key)) continue
    shown.add(m.key)
    // A toast over an open chat would cover its composer and repeat what is already on screen.
    if (quiet || paneShown || m.mine || m.deleted || !privacy.notifications || muted.includes(m.conv) || isOnScreen(m.conv)) continue
    const group = groups.find(g => groupConv(g.id) === m.conv)
    $.ui.toast((group ? group.title + ' · ' : '') + (m.system ? textOf(m) : nameOf(m.from, m.name) + ': ' + m.text).slice(0, 90))
  }
  for (const c of contacts) {
    if (c.state !== 'incoming' || shown.has('req:' + c.id)) continue
    shown.add('req:' + c.id)
    if (!quiet && !paneShown && privacy.notifications) $.ui.toast(t('notifyWantsToAdd', { name: ownName(c.profile) || shortId(c.id) }))
  }
  for (const n of asArray<Notice>(await $.store.get('notices'))) {
    if (shown.has('notice:' + n.key)) continue
    shown.add('notice:' + n.key)
    if (!quiet && privacy.notifications && n.sys && isKey(n.sys.key)) $.ui.toast(t(n.sys.key, n.sys.vars))
  }

  const next = JSON.stringify([
    lang, profile, contacts, blocked, groups, status?.state, privacy, typing, muted, linkStatus,
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
      const proc = $.process.spawn({ argv: ['curl', '-sSN', '--max-time', String(STREAM_MAX_S), url] })
      currentStream = proc as unknown as { return?: () => unknown }
      for await (const piece of proc) {
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
      await pollLink($)
      if (linked) {
        const last = Number(await $.store.get('activeAt')) || 0
        if (now - last > CATCHUP_GAP_MS) await postSelf($, { kind: 'want', since: Math.max(0, last - 60_000) })
      }
      await $.store.set('activeAt', now)
      await retryUnconfirmed($)
      await backupIfDue($, now)
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

async function sendText($: EngineInterface, conv: string, text: string, file?: FileRef, savedPath?: string): Promise<Outcome> {
  if (!text.trim()) return { ok: false, text: t('emptyMessage') }
  if (!recipients(conv).length) return { ok: false, text: t('errNoRecipients') }
  const id = newId()
  const group = groups.find(g => groupConv(g.id) === conv)
  shown.add(id)
  typingSentAt.delete(conv)
  const msg: Msg = { key: id, conv, from: me, name: myPublicName(), text, at: await $.clock.now(), mine: true, dev: deviceId, ...(file ? { file } : {}) }
  await addMessages($, [{ ...msg, state: 'sending', ...(savedPath ? { saved: savedPath } : {}) }])
  newerSkip = 0
  $.ui.invalidate('ui.render')
  scrollToRest($)
  const result = await fanOut($, conv, () =>
    group ? { t: 'group', id, g: group.id, name: myPublicName(), text, ...(file ? { file } : {}) } : { t: 'dm', id, name: myPublicName(), text, ...(file ? { file } : {}) })
  if (result.error) {
    inbox = await mutate<Msg>($, 'inbox', current => current.filter(m => m.key !== id))
    $.ui.invalidate('ui.render')
    return { ok: false, text: result.error }
  }
  await patchMessage($, id, me, { state: undefined })
  $.ui.invalidate('ui.render')
  if (linked) void postSelf($, { kind: 'sent', msg }).catch(() => {})
  return result.missed.length ? { ok: false, text: partialText(result.missed), sent: true } : { ok: true, text: t('sent'), sent: true }
}

async function editMessage($: EngineInterface, msg: Msg, text: string): Promise<Outcome> {
  if (!text.trim()) return { ok: false, text: t('editEmpty') }
  if (text === msg.text) return { ok: false, text: t('noChange') }
  const result = await fanOut($, msg.conv, () => ({ t: 'edit', id: newId(), ref: msg.key, text }))
  if (result.error) return { ok: false, text: result.error }
  await patchMessage($, msg.key, me, { text, edited: true })
  if (linked) void postSelf($, { kind: 'patch', ref: msg.key, patch: { text, edited: true } }).catch(() => {})
  $.ui.invalidate('ui.render')
  return result.missed.length ? { ok: false, text: partialText(result.missed) } : { ok: true, text: t('editedOk') }
}

async function deleteMessage($: EngineInterface, msg: Msg): Promise<Outcome> {
  const result = await fanOut($, msg.conv, () => ({ t: 'delete', id: newId(), ref: msg.key }))
  if (result.error) return { ok: false, text: result.error }
  await patchMessage($, msg.key, me, { text: '', deleted: true })
  if (linked) void postSelf($, { kind: 'patch', ref: msg.key, patch: { text: '', deleted: true } }).catch(() => {})
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
  void syncState($).catch(() => {})
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
  void syncState($).catch(() => {})
  selected = convOf(id)
  view = 'chats'
  threadOpen = true
  $.ui.invalidate('ui.render')
  return err ? t('acceptedNoNotice', { error: errorText(err) }) : t('nowFriend', { name: nameOf(id) })
}

async function unfriend($: EngineInterface, id: string) {
  if (isFriend(id)) await post($, id, { t: 'unfriend', id: newId() })
  await dropContact($, id)
  void syncState($).catch(() => {})
  $.ui.invalidate('ui.render')
}

// Blocking is silent: the other side is not told; their messages and requests are dropped here.
async function block($: EngineInterface, id: string) {
  blocked = await mutate<string>($, 'blocked', cur => [...cur.filter(b => b !== id), id])
  await touchState($, 'blocked')
  await dropContact($, id)
  void syncState($).catch(() => {})
  $.ui.invalidate('ui.render')
}

async function unblock($: EngineInterface, id: string) {
  blocked = await mutate<string>($, 'blocked', cur => cur.filter(b => b !== id))
  await touchState($, 'blocked')
  void syncState($).catch(() => {})
  $.ui.invalidate('ui.render')
}

async function setNickname($: EngineInterface, id: string, nickname: string) {
  const c = contactOf(id)
  if (!c) return
  await saveContact($, { ...c, nickname: cleanText(nickname, 40) || undefined })
  void syncState($).catch(() => {})
  $.ui.invalidate('ui.render')
}

async function setProfile($: EngineInterface, patch: Partial<Profile>): Promise<string> {
  profile = cleanProfile({ ...profile, ...patch })
  await $.store.set('profile', profile)
  await touchState($, 'profile')
  await broadcastProfile($)
  void syncState($).catch(() => {})
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
  void syncState($).catch(() => {})
  $.ui.invalidate('ui.render')
  return t('groupCreated', { title }) + (failed.length ? t('invitesFailed', { names: failed.join(', ') }) : '')
}

async function addToGroup($: EngineInterface, group: Group, id: string): Promise<string> {
  if (group.members.length >= MAX_GROUP) return t('groupFull')
  const updated = { ...group, members: [...group.members, memberOf(id)] }
  await saveGroup($, updated)
  const failed = await sendInvites($, updated)
  await addMessages($, [systemMsg(newId(), groupConv(group.id), { key: 'sysMemberAdded', vars: { name: nameOf(id) } }, await $.clock.now())])
  void syncState($).catch(() => {})
  $.ui.invalidate('ui.render')
  return failed.length ? t('updateFailed', { names: failed.join(', ') }) : t('memberAdded', { name: nameOf(id) })
}

async function leaveGroup($: EngineInterface, group: Group) {
  for (const m of group.members) {
    if (m.id !== me) await post($, m.id, { t: 'leave', id: newId(), g: group.id, name: myPublicName() })
  }
  await dropGroup($, group.id)
  void syncState($).catch(() => {})
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

// Moves the messages by what the wheel summed: WHEEL_MAX_STEP at most, and what is left moves with the next burst.
function flushWheel($: EngineInterface) {
  wheelTimer = undefined
  const steps = Math.trunc(wheelRows / avgRows)
  if (!steps) return
  const moved = Math.max(-WHEEL_MAX_STEP, Math.min(WHEEL_MAX_STEP, steps))
  wheelRows -= moved * avgRows
  pageBy($, -moved)
  if (Math.abs(wheelRows) >= avgRows) wheelTimer = $.clock.after(WHEEL_SETTLE_MS, () => flushWheel($))
}

// Moves the message window: a positive step goes to older messages, a negative one back toward the newest.
function pageBy($: EngineInterface, step: number) {
  const next = Math.max(0, Math.min(newerSkip + step, hiddenAbove + newerSkip))
  if (next === newerSkip) {
    // Past the top of what the store holds: bring back the next archived batch.
    if (step > 0 && selected) void loadOlder($, selected).catch(() => {})
    return
  }
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
    // A new identity grows from 16 bytes, so 12 recovery words bring it back.
    const entropy = nacl.randomBytes(16)
    const derived = keysFromEntropy(entropy)
    keys = nacl.box.keyPair.fromSecretKey(derived.secretKey)
    await $.store.set('secretKey', b64(keys.secretKey))
    await $.store.set('kemSeed', b64(derived.kemSeed))
    await $.store.set('recovery', b64(entropy))
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
  await $.command.register({ name: 'buddy-link', description: t('cmdLink'), argumentHint: t('cmdLinkHint') })
  await $.command.register({ name: 'buddy-backup', description: t('cmdBackup'), argumentHint: t('cmdBackupHint') })
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
    const savedDevice = await $.store.get('deviceId')
    deviceId = typeof savedDevice === 'string' ? savedDevice : newId()
    if (savedDevice !== deviceId) await $.store.set('deviceId', deviceId)
    try {
      deviceName = cleanText((await $.process.run(['hostname', '-s'], { timeoutMs: 3000 })).stdout, 40)
    } catch {
      deviceName = ''
    }
    deviceName ||= t('deviceFallback', { id: deviceId.slice(0, 4) })
    for (const path of [$.plugin.root + '/.claude-plugin/plugin.json', $.plugin.root + '/plugin.json']) {
      try {
        const version = (JSON.parse(await $.fs.read(path)) as { version?: unknown }).version
        if (typeof version === 'string') pluginVersion = version
        break
      } catch {
        // not at this path
      }
    }
    await refresh($, true)
    void broadcastProfile($).catch(() => {})
    // Handshake with friends who have no quantum-resistant key yet, such as those updated from 0.4.
    if (primary) void (async () => { for (const f of friends()) if (!f.pq) await sendKem($, f.id) })().catch(() => {})
    void announce($).catch(() => {})

    $.clock.every(POLL_MS, () => tick($))
    // A pane is the session's: one left open in the last session opens again here, until the person closes it.
    if ((await $.store.get('paneOpen')) === true) void $.ui.open({ id: PANE, title: 'Buddy chat' }).catch(() => {})

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
    await $.store.set('paneOpen', true)
    return {}
  })

  // Closing by hand or by the plugin keeps it closed in the next session; an unload is the session ending.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind !== 'unload') await $.store.set('paneOpen', false)
    return next(e)
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

  on('command.run', { command: 'buddy-link' }, async ($, e) => {
    if (e.args.trim()) return { text: await sendLink($, e.args) }
    // A device that already has contacts is the one that takes a code, not the one that makes it.
    if (contacts.length) return { text: t('linkHowTo') }
    return { text: await startLink($) }
  })

  // Recovery words never go through a command: what is typed at the prompt lands in the transcript.
  on('command.run', { command: 'buddy-backup' }, async ($, e) => {
    const args = e.args.trim()
    if (!args) return { text: backupDir ? t('backupOn', { path: backupDir, when: backupAt ? shortWhen(backupAt, await $.clock.now()) : t('backupNever') }) : t('usageBackup') }
    if (args === 'off') return { text: await setBackupDir($, '') }
    if (args === 'now') return { text: await writeBackup($) }
    if (args.startsWith('load ')) return { text: await loadBackup($, args.slice(5)) }
    return { text: await setBackupDir($, args) }
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
    // A move to the very top would leave the wheel no room to go up; the rest row is as high as the chat goes.
    if (chatShown && restOffset && e.origin?.kind === 'plugin' && e.offset < restOffset) return next({ ...e, offset: restOffset })
    if (!chatShown || e.by === 0 || e.origin?.kind !== 'person') return next(e)
    if (restOffset === 0) {
      const step = Math.min(PAGE_STEP, Math.max(1, Math.round(Math.abs(e.by))))
      pageBy($, e.by < 0 ? step : -step)
    } else {
      // A trackpad sends many small moves; each counts as the row it moved, so a flick does not jump far.
      const rows = Math.sign(e.by) * Math.max(WHEEL_ROWS, Math.abs(e.by))
      if (Math.sign(wheelRows) === Math.sign(rows)) wheelRows += rows
      else wheelRows = rows
      // Ticks that come close together move the messages once, so a fast scroll redraws less often.
      // A long flick carries at most three bursts' worth, so the list does not keep running after the hand stops.
      const cap = avgRows * WHEEL_MAX_STEP * 3
      wheelRows = Math.max(-cap, Math.min(cap, wheelRows))
      if (!wheelTimer) wheelTimer = $.clock.after(WHEEL_SETTLE_MS, () => flushWheel($))
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
          {tab('tab-settings', t('tabSettings'), 'g', view === 'settings', () => { view = 'settings'; redraw() })}
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
      <Box flexDirection="row" columnGap={graphic ? 1 : 2} rowGap={1} alignItems="center" flexWrap="wrap">
        <Button key="toggle-read" label={t(privacy.readReceipts ? 'readReceiptsOn' : 'readReceiptsOff')} plain dimColor={!privacy.readReceipts}
          onPress={() => setPrivacy($, { readReceipts: !privacy.readReceipts })} />
        <Button key="toggle-typing" label={t(privacy.typing ? 'typingOn' : 'typingOff')} plain dimColor={!privacy.typing}
          onPress={() => setPrivacy($, { typing: !privacy.typing })} />
        <Button key="toggle-notify" label={t(privacy.notifications ? 'notificationsOn' : 'notificationsOff')} plain dimColor={!privacy.notifications}
          onPress={() => setPrivacy($, { notifications: !privacy.notifications })} />
        <Button key="toggle-sound" label={t(privacy.sound === 'on' ? 'soundOn' : privacy.sound === 'off' ? 'soundOff' : 'soundAuto')}
          plain dimColor={privacy.sound === 'off'}
          onPress={() => setPrivacy($, { sound: privacy.sound === 'auto' ? 'on' : privacy.sound === 'on' ? 'off' : 'auto' })} />
      </Box>
    )

    const footer = <Text dimColor size="caption">{t('e2eBadge')}</Text>

    const card = (key: string, title: RenderChildren, body: RenderChildren, color = 'inactive') => (
      <Box key={key} flexDirection="column" borderStyle="round" borderColor={color}
        padding={graphic ? 'md' : undefined} paddingX={graphic ? undefined : 1} rowGap={graphic ? 1 : 0}>
        {title}
        {body}
      </Box>
    )

    // One identity on several computers: the new one shows a code, the one that has the identity takes it.
    const pendingCode = linkPending && linkPending.until > now ? linkCode() : ''
    const devicesCard = card('devices-card', <Text weight="semibold">{t('devicesTitle')}</Text>,
      <Box flexDirection="column" rowGap={graphic ? 1 : 0}>
        <Text dimColor size="footnote">{linked ? t(primary ? 'devicesLinkedPrimary' : 'devicesLinked') : t('devicesHint')}</Text>
        {linkStatus && <Text color="claude" weight="semibold">{linkStatus}</Text>}
        {linked && Object.entries(devices).sort((a, b) => b[1].seen - a[1].seen).map(([dev, d]) => (
          <Box key={'device-' + dev} flexDirection="row" columnGap={1} alignItems="center">
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              <Text weight="semibold" wrap="truncate-end">
                {d.name}{dev === deviceId ? ' · ' + t('deviceThis') : ''}{d.primary ? ' · ' + t('devicePrimary') : ''}
              </Text>
              <Text dimColor size="caption">{t('deviceSeen', { when: shortWhen(d.seen, now) })}</Text>
            </Box>
            {dev === deviceId
              ? (!primary && <Button key="device-leave" label={t('leaveButton')} plain={graphic ? undefined : true} dimColor onPress={async () => toast(await leaveLink($))} />)
              : (primary && <Button key={'device-remove-' + dev} label={t('removeButton')} plain={graphic ? undefined : true} dimColor onPress={async () => toast(await removeDevice($, dev))} />)}
          </Box>
        ))}
        {pendingCode
          ? (
            <Box flexDirection="column" rowGap={graphic ? 1 : 0}>
              <Text size="caption">{t('linkShowCode')}</Text>
              <Box flexShrink={1}><Text mono size="caption" wrap="truncate-middle">{pendingCode}</Text></Box>
              <Box flexDirection="row" columnGap={graphic ? 1 : 2}>
                <Button key="link-copy" label={t('linkCopy')} plain={graphic ? undefined : true} variant={graphic ? 'primary' : undefined}
                  onPress={press => copy(pendingCode, press.surface, t('linkCopied'))} />
                <Button key="link-cancel" label={t('linkCancel')} plain dimColor onPress={() => cancelLink($)} />
              </Box>
            </Box>
          )
          : !contacts.length && !linked && <Button key="link-start" label={t('linkStart')} plain={graphic ? undefined : true} onPress={async () => toast(await startLink($))} />}
        {Input && (
          <Input key={'link-code' + (linkSeq ? '-' + linkSeq : '')} placeholder={t('linkPaste')} value="" submitLabel={t('linkSend')}
            onSubmit={async (value: string) => {
              toast(await sendLink($, value))
              linkSeq++
              redraw()
            }} />
        )}
      </Box>)

    const recoveryCard = card('recovery-card', <Text weight="semibold">{t('recoveryTitle')}</Text>,
      <Box flexDirection="column" rowGap={graphic ? 1 : 0}>
        <Text dimColor size="footnote">{t('recoveryHint')}</Text>
        {shownWords.length
          ? (
            <Box flexDirection="column" rowGap={graphic ? 1 : 0}>
              <Text color="warning" size="caption">{t('recoveryWarn')}</Text>
              <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
                {shownWords.map((w, i) => <Box key={'word-' + i} width={16}><Text mono>{String(i + 1).padStart(2, ' ') + '. ' + w}</Text></Box>)}
              </Box>
              <Button key="words-hide" label={t('recoveryHide')} plain={graphic ? undefined : true} onPress={() => { shownWords = []; redraw() }} />
            </Box>
          )
          : (
            <Button key="words-show" label={t('recoveryShow')} plain={graphic ? undefined : true}
              onPress={async () => {
                if (!(await confirm($, t('recoveryConfirm'), t('recoveryConfirmYes')))) return
                shownWords = await recoveryWords($)
                redraw()
              }} />
          )}
        {Input && (
          <Input key={'restore-words' + (restoreSeq ? '-' + restoreSeq : '')} placeholder={t('restorePlaceholder')} value="" submitLabel={t('restoreSubmit')}
            onSubmit={async (value: string) => {
              toast(await restoreFromWords($, value))
              restoreSeq++
              redraw()
            }} />
        )}
        <Text weight="semibold">{t('backupTitle')}</Text>
        <Text dimColor size="footnote">
          {backupDir ? t('backupOn', { path: backupDir, when: backupAt ? shortWhen(backupAt, now) : t('backupNever') }) : t('backupHint')}
        </Text>
        <Box flexDirection="row" columnGap={graphic ? 1 : 2} rowGap={1} flexWrap="wrap">
          <Button key="backup-choose" label={backupDir ? t('backupChange') : t('backupChoose')} plain={graphic ? undefined : true}
            variant={graphic && !backupDir ? 'primary' : undefined}
            onPress={async () => {
              const picked = await chooseFolder($, t('backupChoosePrompt'))
              if (picked) toast(await setBackupDir($, picked))
            }} />
          {backupDir && <Button key="backup-now" label={t('backupNow')} plain={graphic ? undefined : true} onPress={async () => toast(await writeBackup($))} />}
          {backupDir && <Button key="backup-off" label={t('backupTurnOff')} plain dimColor onPress={async () => toast(await setBackupDir($, ''))} />}
          <Button key="backup-load" label={t('backupLoadButton')} plain={graphic ? undefined : true} dimColor
            onPress={async () => {
              const picked = await chooseFolder($, t('backupLoadPrompt'))
              if (picked) toast(await loadBackup($, picked))
            }} />
        </Box>
        {/* Where no folder dialog opens, the path is typed: a folder to back up into, or "load <folder>" to restore. */}
        {pickerMissing && Input && (
          <Input key={'backup-path' + (restoreSeq ? '-' + restoreSeq : '')} placeholder={t('backupPathPlaceholder')} value="" submitLabel={t('save')}
            onSubmit={async (value: string) => {
              const v = value.trim()
              toast(v.startsWith('load ') ? await loadBackup($, v.slice(5)) : await setBackupDir($, v))
              restoreSeq++
              redraw()
            }} />
        )}
      </Box>)

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

    const viewHeader = (title: string) => graphic
      ? (
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Box flexDirection="row" columnGap={1} alignItems="center">
            <Button key="tab-chats" label={'← ' + t('tabChats')} plain hotkey="s" onPress={() => { view = 'chats'; redraw() }} />
            <Text size="title" weight="bold">{title}</Text>
          </Box>
          {statusView}
        </Box>
      )
      : header

    if (view === 'settings') {
      return (
        <Box flexDirection="column" rowGap={1}>
          {viewHeader(t('tabSettings'))}
          {card('profile-card', <Text weight="semibold">{t('settingsProfile')}</Text>, profileBlock, 'claude')}
          {card('privacy-card', <Text weight="semibold">{t('privacyLabel')}</Text>,
            <Box flexDirection="column" rowGap={graphic ? 1 : 0}>
              <Text dimColor size="footnote">{t('privacyHint')}</Text>
              {privacyPicker}
            </Box>)}
          {card('language-card', <Text weight="semibold">{t('languageLabel')}</Text>, languagePicker)}
          {devicesCard}
          {recoveryCard}
          <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" columnGap={2}>
            {footer}
            {pluginVersion && <Text dimColor size="caption">{'buddy-chat ' + pluginVersion}</Text>}
          </Box>
        </Box>
      )
    }

    if (view === 'people') {
      return (
        <Box flexDirection="column" rowGap={1}>
          {viewHeader(t('tabPeople'))}
          {card('me-card', <Text weight="semibold">{t('shareTitle')}</Text>, shareRow, 'claude')}
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
          {tab('tab-settings', t('tabSettings'), 'g', false, () => { view = 'settings'; redraw() })}
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
    if (!olderChunks.has(current.id)) void listArchive($, current.id).then(names => { if (names.length) redraw() }).catch(() => {})
    const thread = [...(older.get(current.id) ?? []), ...inbox]
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
        return (newDay ? 2.5 : 0) + (m.system ? 1.2 : linesOf(textOf(m)) * 1.4 + (sameRun ? 3.3 : 4))
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
    // Desktop's rows are guesses: a few more messages than they allow keep the top from opening a gap; the list clips them.
    if (graphic) {
      for (let extra = 0; extra < 6 && start > 0; extra++) {
        used += rowsOf(thread[start - 1]!, thread[start - 2])
        start--
      }
    }
    hiddenAbove = start
    const visible = thread.slice(start, end)
    if (graphic && visible.length) avgRows = Math.max(1, used / visible.length)
    const below = thread.length - end
    // At the start of the chat the messages hang from the top, so going back never opens a gap above them.
    const align = start === 0 && newerSkip > 0 ? 'flex-start' : 'flex-end'
    chatShown = view === 'chats' && !!fullHeight
    restOffset = graphic ? 1 : 0
    const archivedLeft = olderChunks.get(current.id)?.length ?? 0
    const olderButton = (start > 0 || archivedLeft > 0) && (
      <Box justifyContent="center">
        <Button key="older" label={start > 0 ? t('olderMessages', { count: start }) : t('olderArchived')} plain dimColor
          hotkey={graphic ? undefined : 'o'}
          onPress={() => (start > 0 ? pageBy($, PAGE_STEP) : void loadOlder($, current.id).catch(() => {}))} />
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

    // compact: one-character buttons, for the Desktop bubble's own time row.
    const msgActions = (m: Msg, compact = false) => {
      if (m.deleted) return null
      const marked = m.key === cursor
      const copyButton = (
        <Button key={'copy-' + m.key} label={graphic && !compact ? t('copyButton') : '⧉'} plain dimColor={!marked} hotkey={marked ? 'c' : undefined}
          onPress={press => copy(m.text, press.surface, t('copiedMsg'))} />
      )
      if (m.mine) {
        return (
          <Box flexDirection="row" columnGap={compact ? 0 : 1}>
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
          <Box flexDirection="row" columnGap={compact ? 0 : 1}>
            {copyButton}
            {!compact && <Text dimColor size="caption">{t('forwarded')}</Text>}
          </Box>
        )
      }
      return (
        <Box flexDirection="row" columnGap={compact ? 0 : 1}>
        {copyButton}
        <Button key={'fwd-' + m.key} label={graphic ? t('forwardButton') : '↗'} plain dimColor={!marked} hotkey={marked ? 'f' : undefined}
          onPress={async () => {
            inbox = await mutate<Msg>($, 'inbox', cur => cur.map(x => (x.key === m.key ? { ...x, forwarded: true } : x)))
            redraw()
            const name = nameOf(m.from, m.name)
            void $.prompt.submit({
              text: (group ? t('forwardGroup', { group: group.title, name, text: m.text }) : t('forwardDm', { name, text: m.text }))
                + (m.saved ? '\n\n' + t('forwardFile', { path: m.saved }) : ''),
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

    // An attached file: its name and size, and what can be done with it here.
    const fileView = (m: Msg) => {
      if (!m.file || m.deleted) return null
      const f = m.file
      const fresh = now - m.at < 3 * 3_600_000
      return (
        <Box flexDirection="row" columnGap={1} alignItems="center" flexWrap="wrap">
          <Text weight="semibold" color={graphic && m.mine ? '#ffffff' : undefined} wrap="truncate-middle">{fileIcon(f.mime) + ' ' + f.name}</Text>
          <Text size="caption" color={graphic && m.mine ? MINE_SOFT : undefined} dimColor={!graphic || !m.mine}>{sizeText(f.size)}</Text>
          {m.saved
            ? (
              <Box flexDirection="row" columnGap={1}>
                <Button key={'file-open-' + m.key} label={t('fileOpen')} plain onPress={() => openPath($, m.saved!)} />
                {f.mime.startsWith('audio/') && <Button key={'file-play-' + m.key} label="▶" plain onPress={() => playFile($, m)} />}
              </Box>
            )
            : fresh
              ? <Button key={'file-get-' + m.key} label={t('fileDownload')} plain
                  onPress={async () => { if (!(await downloadFile($, m))) toast(t('fileDownloadFailed')) }} />
              : <Text size="caption" dimColor>{t('fileExpired')}</Text>}
        </Box>
      )
    }
    // The text is the file's name when nothing was written with it; then the card says it all.
    const captionOf = (m: Msg) => (m.file && m.text === '📎 ' + m.file.name ? '' : m.text)

    const body = (m: Msg) => m.deleted
      ? <Text dimColor italic>{t('deletedMsg')}</Text>
      : (
        <Box flexDirection="column">
          {fileView(m)}
          {captionOf(m) && <Text wrap="wrap" color={m.key === editing ? 'warning' : undefined}>{captionOf(m)}{m.edited ? <Text dimColor>{t('edited')}</Text> : ''}</Text>}
        </Box>
      )

    const rowsView = visible.map((m, i) => {
      const prev = visible[i - 1]
      const newDay = !prev || !sameDay(prev.at, m.at)
      const sameRun = prev && !newDay && !prev.system && !m.system && prev.from === m.from && m.at - prev.at < 5 * 60_000
      const day = newDay
        ? <Box key={'day-' + m.key} width="100%" justifyContent="center" marginY={graphic ? 1 : 0}><Text dimColor size="caption">── {dayLabel(m.at, now)} ──</Text></Box>
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
        // Desktop: chat bubbles with a row for their actions underneath; in groups other people's messages carry an avatar and a name.
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
                  : (
                    <Box flexDirection="column">
                      {fileView(m)}
                      {captionOf(m) && <Text wrap="wrap" color={m.mine ? '#ffffff' : undefined}>{captionOf(m)}</Text>}
                    </Box>
                  )}
                <Box flexDirection="row" justifyContent="flex-end" alignItems="center" columnGap={1}>
                  <Text size="caption" color={m.mine ? MINE_SOFT : undefined} dimColor={!m.mine}>
                    {(m.edited ? t('editedShort') + ' · ' : '') + clock(m.at)}
                  </Text>
                  {ticks(m)}
                </Box>
              </Box>
              {!m.mine && m.forwarded && <Text dimColor size="caption">{t('forwarded')}</Text>}
            </Box>
            {/* A row of fixed height is always there under the bubble; the actions fill it on hover, so nothing moves. */}
            <Box height={1} flexDirection="row" paddingLeft={showFace ? 5 : 1} paddingRight={1}>
              <Box display="none" hover={{ display: 'flex' }} flexDirection="row">{msgActions(m, true)}</Box>
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

    const attachButton = Input && !editTarget && (
      <Button key="attach" label="📎" plain={graphic ? undefined : true} hotkey={graphic ? undefined : 'a'}
        onPress={async () => {
          const r = await attachFile($, current.id)
          if (r.text && !r.ok) toast(r.text)
        }} />
    )

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
            placeholder={t('composePlaceholder', { title: (current.isGroup ? '# ' : '') + current.title })} value="" submitLabel={graphic ? '➤' : t('send')}
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

      // At the top the wheel cannot go up and raises nothing, so the pane goes back to its rest row whenever a
      // drawing finds it elsewhere: a chat just opened, the pane shown again, a resize. A few tries per chat at most.
      if (restedFor !== current.id) {
        restedFor = current.id
        restTries = 0
        // Desktop may not have laid the chat out yet when the first try goes, so a few more follow.
        if (fullHeight && e.surface === 'desktop') for (const ms of [300, 800, 1500]) $.clock.after(ms, () => scrollToRest($))
      }
      if (e.props.scroll?.offset === restOffset) restTries = 0
      if (fullHeight && e.surface === 'desktop' && e.props.scroll?.offset !== restOffset && !restQueued && restTries < 5) {
        restQueued = true
        restTries++
        $.clock.after(60, () => {
          restQueued = false
          scrollToRest($)
        })
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
            <Box flexDirection="row" alignItems="flex-start" columnGap={1} width="100%" flexShrink={0}>
              {attachButton}
              <Box flexDirection="column" alignItems="stretch" flexGrow={1} flexShrink={1}>{composer}</Box>
            </Box>
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
          {attachButton}
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
