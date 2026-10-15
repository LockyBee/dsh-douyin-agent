/**
 * MiniMax speech-to-text as a global Harness plugin.
 *
 * Registers the model-facing `transcribe_audio` tool, which uploads one local
 * audio file to MiniMax's `POST /v1/speech_to_text` (multipart, `model=asr-1.0`)
 * and returns the transcript. The endpoint, model, defaults, and the credential
 * reference are owned by the `minimax-asr` settings namespace, so a user edit in
 * Settings -> Plugins reaches the next transcription without a restart.
 *
 * @module dsh-minimax-asr
 */

import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'minimax-asr'

/** The tool registry this plugin contributes to. */
export const inject = ['tools']

/** Settings namespace owning the user-editable subset of {@link Config}. */
export const MINIMAX_ASR_SETTINGS_NAMESPACE = 'minimax-asr'

/** Credential reference resolved for each request unless the section names another. */
const DEFAULT_API_KEY_ENV = 'MINIMAX_API_KEY'

/** MiniMax serves the ASR endpoint on this base; the docs' `.cn` site names the same host. */
const DEFAULT_BASE_URL = 'https://api.minimaxi.com'

/** The only model the endpoint accepts today. */
const DEFAULT_MODEL = 'asr-1.0'

/** Serialized error bodies longer than this are truncated before they reach the model. */
const MAX_ERROR_CHARS = 600

/** Audio extensions MiniMax documents as supported (`webm` is NOT one of them). */
const SUPPORTED_EXTENSIONS = new Map([
  ['.wav', 'audio/wav'],
  ['.aiff', 'audio/aiff'],
  ['.aif', 'audio/aiff'],
  ['.flac', 'audio/flac'],
  ['.m4a', 'audio/mp4'],
  ['.alac', 'audio/mp4'],
  ['.mp3', 'audio/mpeg'],
  ['.aac', 'audio/aac'],
  ['.opus', 'audio/opus'],
  ['.ogg', 'audio/ogg'],
])

/** Response formats the endpoint serves as JSON. */
const JSON_FORMATS = new Set(['json', 'verbose_json'])

/** Response formats the endpoint serves as plain text. */
const TEXT_FORMATS = new Set(['srt', 'vtt'])

/** Timestamp granularities accepted with a timestamp-bearing response format. */
const TIMESTAMP_LEVELS = new Set(['sentence', 'word'])

/**
 * Plugin configuration. Every field is optional at the composition layer: the
 * schema carries the defaults, so the settings namespace resolves a complete
 * section even when the loader entry declares nothing.
 */
export const Config = z.object({
  /** Literal API key; prefer {@link Config.apiKeyEnv} so no secret enters a config file. */
  apiKey: z.string().role('secret'),
  /** Credential reference resolved per request. */
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  /** Endpoint base; `/v1/speech_to_text` is appended. */
  baseURL: z.string().default(DEFAULT_BASE_URL),
  /** Model version sent as the `model` form field. */
  model: z.string().default(DEFAULT_MODEL),
  /** Default `response_format` when a call does not name one. */
  responseFormat: z.string().default('json'),
  /** Default `language` header (BCP-47); empty means mixed-language recognition. */
  language: z.string().default(''),
  /** Default `timestamp_level` for timestamp-bearing formats; empty means the server default. */
  timestampLevel: z.string().default(''),
  /** Refuse an input file larger than this; MiniMax rejects bodies over 50 MB. */
  maxFileMB: z.number().step(1).min(1).default(50),
  /**
   * Auto-stop length for a browser recording. MiniMax rejects a file longer
   * than 500 s outright, so 500 is the ceiling this can ever reach.
   */
  maxRecordSeconds: z.number().step(1).min(10).max(500).default(300),
  /** Per-request budget in milliseconds. */
  timeoutMs: z.number().step(1).min(1000).default(180000),
  /** Speak a short summary through the browser's speakers when a turn completes. */
  speakEnabled: z.boolean().default(true),
  /** TTS model: speech-2.8-hd (best) or speech-2.8-turbo (fastest). */
  ttsModel: z.string().default('speech-2.8-hd'),
  /** Voice id from MiniMax's catalogue (or a cloned one). */
  ttsVoice: z.string().default('male-qn-jingying'),
  /** Speaking rate, 0.5 through 2. */
  ttsSpeed: z.number().min(0.5).max(2).default(1),
  /** Longest announcement to synthesise; a long line is cut at a sentence. */
  speakMaxChars: z.number().step(1).min(20).max(2000).default(80),
  /**
   * Conversational loop: when an announcement finishes the browser reopens the
   * microphone by itself, and a finished transcript is submitted without a
   * click. Handsfree, so it stays off until the user asks for it.
   */
  voiceLoop: z.boolean().default(false),
  /**
   * How long a pause means the sentence is finished. This is room to think:
   * too short and the loop sends while the user is still deciding what to say.
   */
  voiceSilenceSeconds: z.number().step(0.5).min(1).max(60).default(5),
  /**
   * Longest single spoken turn before it is sent regardless, for a window that
   * never goes quiet. Long enough that a slow speaker is never cut off.
   */
  voiceMaxTurnSeconds: z.number().step(1).min(10).max(600).default(300),
})

/**
 * Apply composition-layer defaults to a raw loader entry, for the deployment
 * that composes no settings provider and therefore resolves no section.
 * @param entry - the loader entry config, possibly partial or absent.
 * @returns a complete configuration.
 */
function normalizeConfig(entry) {
  const raw = entry ?? {}
  return {
    apiKey: raw.apiKey,
    apiKeyEnv: raw.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
    baseURL: raw.baseURL ?? DEFAULT_BASE_URL,
    model: raw.model ?? DEFAULT_MODEL,
    responseFormat: raw.responseFormat ?? 'json',
    language: raw.language ?? '',
    timestampLevel: raw.timestampLevel ?? '',
    maxFileMB: raw.maxFileMB ?? 50,
    maxRecordSeconds: raw.maxRecordSeconds ?? 300,
    timeoutMs: raw.timeoutMs ?? 180000,
    speakEnabled: raw.speakEnabled ?? true,
    ttsModel: raw.ttsModel ?? 'speech-2.8-hd',
    ttsVoice: raw.ttsVoice ?? 'male-qn-jingying',
    ttsSpeed: raw.ttsSpeed ?? 1,
    speakMaxChars: raw.speakMaxChars ?? 80,
    voiceLoop: raw.voiceLoop ?? false,
    voiceSilenceSeconds: raw.voiceSilenceSeconds ?? 5,
    voiceMaxTurnSeconds: raw.voiceMaxTurnSeconds ?? 300,
  }
}

/**
 * Resolve the API key for one request: a literal from the section wins, then
 * the credential seam, then the ambient process environment. The seam is read
 * per request, so a rotated key reaches the next call without a restart.
 * @param ctx - plugin context supplying the credential seam.
 * @param config - the currently authoritative section.
 * @returns the key, or undefined while nothing supplies one.
 */
async function resolveApiKey(ctx, config) {
  if (typeof config.apiKey === 'string' && config.apiKey.length > 0) return config.apiKey
  let ref
  try {
    ref = credentialRef(config.apiKeyEnv)
  } catch {
    throw new Error(`minimax-asr: apiKeyEnv ${JSON.stringify(config.apiKeyEnv)} is not an environment-variable name`)
  }
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    const resolved = await credentials.resolve(ref)
    if (resolved !== undefined && resolved.value.length > 0) return resolved.value
  }
  const ambient = process.env[ref]
  return ambient !== undefined && ambient.length > 0 ? ambient : undefined
}

/** Truncate a serialized error body for the model-facing message. */
function clip(text) {
  const collapsed = text.replace(/\s+/gu, ' ').trim()
  return collapsed.length > MAX_ERROR_CHARS ? `${collapsed.slice(0, MAX_ERROR_CHARS)}...` : collapsed
}

/**
 * Extract the endpoint's own diagnostic from an error body — the OpenAI-style
 * `{ error: { message } }` this API returns, or the raw body when it is not.
 * @param body - the decoded response body.
 * @returns a one-line, bounded message.
 */
function describeFailure(body) {
  try {
    const payload = JSON.parse(body)
    const message = payload?.error?.message
    if (typeof message === 'string' && message.length > 0) return clip(message)
  } catch {
    // Not JSON: fall through to the raw body.
  }
  return clip(body)
}

/** The endpoint base with the ASR path appended, tolerating a trailing slash. */
function endpointFor(baseURL) {
  return `${baseURL.replace(/\/+$/u, '')}/v1/speech_to_text`
}

/**
 * Combine the caller's cancellation with this plugin's own request budget.
 * @param signal - the tool call's signal.
 * @param timeoutMs - the configured budget.
 * @returns a signal aborting on either.
 */
function requestSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (signal === undefined) return timeout
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : signal
}

/**
 * One transcript as the tool's canonical value, rendered for the model.
 * @param value - the canonical tool value.
 * @returns the model-facing text blocks.
 */
function renderTranscript(value) {
  const heading = value.durationSeconds === undefined
    ? `Transcribed ${value.path} with ${value.model} (${value.format}).`
    : `Transcribed ${value.path} with ${value.model} (${value.format}, ${value.durationSeconds}s of audio).`
  const body = value.text.trim().length > 0
    ? value.text
    : '(no speech detected in this audio)'
  const speakers = value.speakers === undefined ? '' : `\nDetected ${value.speakers} speaker(s).`
  return [{ type: 'text', text: `${heading}${speakers}\n\n${body}` }]
}

/**
 * One MiniMax transcription over already-read audio bytes, shared by the
 * model-facing tool and the browser voice-input route.
 * @param ctx - plugin context supplying the credential seam.
 * @param config - the currently authoritative section.
 * @param input - audio bytes, the filename/media type the endpoint infers the format from, and per-call options.
 * @returns the endpoint's answer as the tool's canonical value (without `path`).
 */
async function requestTranscription(ctx, config, input) {
  const apiKey = await resolveApiKey(ctx, config)
  if (apiKey === undefined) {
    throw new Error(
      `No MiniMax API key: store one under the ${config.apiKeyEnv} credential reference `
      + '(Settings -> Plugins -> MiniMax ASR) or export it in the environment',
    )
  }

  const form = new FormData()
  form.set('model', config.model)
  form.set('response_format', input.format)
  if (input.level !== '') form.set('timestamp_level', input.level)
  form.set('stream', 'false')
  form.set('file', new Blob([input.data], { type: input.mediaType }), input.filename)

  const headers = { Authorization: `Bearer ${apiKey}` }
  if (input.language !== '') headers.language = input.language

  const response = await fetch(endpointFor(config.baseURL), {
    method: 'POST',
    headers,
    body: form,
    signal: requestSignal(input.signal, config.timeoutMs),
  })
  const body = await response.text()
  if (!response.ok) {
    throw new Error(`MiniMax ASR failed (HTTP ${response.status}): ${describeFailure(body)}`)
  }

  if (TEXT_FORMATS.has(input.format)) {
    return { text: body, format: input.format, model: config.model }
  }

  let payload
  try {
    payload = JSON.parse(body)
  } catch {
    throw new Error(`MiniMax ASR returned a body that is not JSON: ${clip(body)}`)
  }
  // The endpoint answers errors with the real HTTP status, but a proxy in
  // front of it may not: refuse an error body that arrived as 200.
  if (payload?.error !== undefined) {
    throw new Error(`MiniMax ASR failed: ${describeFailure(payload === undefined ? body : JSON.stringify(payload))}`)
  }

  const value = {
    text: typeof payload?.text === 'string' ? payload.text : '',
    format: input.format,
    model: config.model,
  }
  if (typeof payload?.duration === 'number') value.durationSeconds = payload.duration
  if (typeof payload?.n_speakers === 'number') value.speakers = payload.n_speakers
  if (typeof payload?.trace_id === 'string') value.traceId = payload.trace_id
  if (Array.isArray(payload?.segments)) {
    value.segments = payload.segments.map(segment => ({
      start: Number(segment?.start ?? 0),
      end: Number(segment?.end ?? 0),
      text: String(segment?.text ?? ''),
      ...typeof segment?.speaker === 'string' ? { speaker: segment.speaker } : {},
    }))
  }
  return value
}

/** Local route the browser voice input posts one recording to. */
export const TRANSCRIBE_ROUTE = '/minimax-asr/transcribe'

/** Local route the browser half reports its own wiring to. */
export const DIAGNOSTICS_ROUTE = '/minimax-asr/diagnostics'

/** Every route this plugin owns shares one fenced prefix. */
const ROUTE_PREFIX = '/minimax-asr'

/** Bounded, in-memory log of what the browser half reported, newest last. */
const clientEvents = []

/**
 * How many browser reports are retained. The browser half reports the microphone
 * level once a second while it listens, so a small ring pushes every wiring event
 * out within a minute — exactly when a live session is being diagnosed.
 */
const MAX_CLIENT_EVENTS = 300

/**
 * Record one browser-half report. In memory only, bounded, and carrying no
 * secret: it exists so a deployment can answer "did the browser half load, and
 * which slots did it register into?" without a browser console.
 * @param event - the reported facts.
 */
function recordClientEvent(event) {
  clientEvents.push({ at: new Date().toISOString(), ...event })
  if (clientEvents.length > MAX_CLIENT_EVENTS) clientEvents.splice(0, clientEvents.length - MAX_CLIENT_EVENTS)
}

/** Whether a Host-header hostname names the local loopback authority. */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
}

/**
 * Browser-trust fence for the voice-input route: a loopback Host with no
 * cross-site marker and a matching Origin. This is a DNS-rebinding and
 * cross-site defense — the same posture the shipped `/api` gateway and the
 * installed `dsh-better-sidebar` plugin use — not authentication: the route
 * spends the configured MiniMax key and touches nothing else.
 * @param req - the node HTTP request.
 * @returns whether the request may reach the route.
 */
function isTrustedRouteRequest(req) {
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}

/** Write one JSON answer and end the response. */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Collect a request body, refusing one that exceeds `limit`.
 * @param req - the node HTTP request.
 * @param limit - maximum body bytes.
 * @returns the body bytes.
 */
function readRequestBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error(`recording exceeds the ${Math.round(limit / 1024 / 1024)} MB limit`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** A browser-supplied filename reduced to one safe basename, or the default. */
function safeRecordingName(candidate) {
  const fallback = 'voice-input.wav'
  if (typeof candidate !== 'string' || candidate.length === 0) return fallback
  const base = candidate.replace(/[\\/]+/gu, '/').split('/').pop() ?? fallback
  const cleaned = base.replace(/[^A-Za-z0-9._-]/gu, '')
  return cleaned.length === 0 || !/^[A-Za-z0-9._-]+$/u.test(cleaned) ? fallback : cleaned
}

/** Response format for one route call: the query value, else the section default. */
function readRouteFormat(value, fallback) {
  const candidate = typeof value === 'string' && value.length > 0 ? value : fallback
  if (!JSON_FORMATS.has(candidate) && !TEXT_FORMATS.has(candidate)) {
    throw new Error(`unsupported response_format ${JSON.stringify(candidate)}`)
  }
  return candidate
}

/** Timestamp granularity for one route call: the query value, else the section default. */
function readRouteLevel(value, fallback) {
  const candidate = typeof value === 'string' && value.length > 0 ? value : fallback
  if (candidate !== '' && !TIMESTAMP_LEVELS.has(candidate)) {
    throw new Error(`unsupported timestamp_level ${JSON.stringify(candidate)}`)
  }
  return candidate
}

/** Route the browser keeps open to receive announcements (SSE). */
export const EVENTS_ROUTE = '/minimax-asr/events'

/** Route that synthesises one line of speech. */
export const SPEAK_ROUTE = '/minimax-asr/speak'

/** Route that lists the account's available voices. */
export const VOICES_ROUTE = '/minimax-asr/voices'

/**
 * Voices offered when the catalogue cannot be fetched. Kept short: it only has
 * to keep the picker usable offline, and every id here is a long-standing
 * system voice.
 */
const FALLBACK_VOICES = [
  { id: 'male-qn-jingying', name: '精英青年音色', group: '国语' },
  { id: 'male-qn-qingse', name: '青涩青年音色', group: '国语' },
  { id: 'male-qn-badao', name: '霸道青年音色', group: '国语' },
  { id: 'male-qn-daxuesheng', name: '青年大学生音色', group: '国语' },
  { id: 'female-shaonv', name: '少女音色', group: '国语' },
  { id: 'female-yujie', name: '御姐音色', group: '国语' },
  { id: 'female-chengshu', name: '成熟女性音色', group: '国语' },
  { id: 'female-tianmei', name: '甜美女性音色', group: '国语' },
  { id: 'Chinese (Mandarin)_News_Anchor', name: '新闻女声', group: '国语' },
  { id: 'Chinese (Mandarin)_Male_Announcer', name: '播报男声', group: '国语' },
  { id: 'Chinese (Mandarin)_Gentleman', name: '温润男声', group: '国语' },
  { id: 'Chinese (Mandarin)_Warm_Bestie', name: '温暖闺蜜', group: '国语' },
  { id: 'Cantonese_ProfessionalHost（F)', name: '专业女主持', group: '粤语' },
  { id: 'Cantonese_ProfessionalHost（M)', name: '专业男主持', group: '粤语' },
  { id: 'English_Trustworthy_Man', name: 'Trustworthy Man', group: '英语' },
  { id: 'English_Graceful_Lady', name: 'Graceful Lady', group: '英语' },
  { id: 'Japanese_IntellectualSenior', name: 'Intellectual Senior', group: '日语' },
  { id: 'Korean_SweetGirl', name: 'Sweet Girl', group: '韩语' },
]

/** Catalogue cache: one fetch per this window, so opening the card is cheap. */
const VOICE_CACHE_MS = 10 * 60 * 1000
let voiceCache = { at: 0, voices: [] }

/** Language prefixes MiniMax uses in its voice ids, as picker headings. */
const VOICE_LANGUAGES = new Map([
  ['English', '英语'],
  ['Japanese', '日语'],
  ['Korean', '韩语'],
  ['Spanish', '西班牙语'],
  ['Portuguese', '葡萄牙语'],
  ['French', '法语'],
  ['German', '德语'],
  ['Russian', '俄语'],
  ['Italian', '意大利语'],
  ['Arabic', '阿拉伯语'],
  ['Turkish', '土耳其语'],
  ['Ukrainian', '乌克兰语'],
  ['Dutch', '荷兰语'],
  ['Vietnamese', '越南语'],
  ['Indonesian', '印尼语'],
])

/**
 * The voice group a MiniMax voice belongs to, for the picker's headings.
 *
 * The *id* carries the language, not the display name: `English_Trustworthy_Man`
 * is displayed as "Trustworthy Man", and the classic `male-qn-*` / `female-*`
 * voices are all Mandarin. Only a known language prefix earns its own heading —
 * everything else (sound effects, seasonal voices) lands in 其它.
 * @param id - the catalogue's `voice_id`.
 * @returns the group label.
 */
function voiceGroupOf(id) {
  if (id.startsWith('Cantonese')) return '粤语'
  if (id.startsWith('Chinese (Mandarin)')) return '国语'
  if (/^(male|female)-/u.test(id)) return '国语'
  const match = /^([A-Za-z]+)_/u.exec(id)
  if (match === null) return '其它'
  return VOICE_LANGUAGES.get(match[1]) ?? '其它'
}

/**
 * Load the account's voice catalogue, falling back to a built-in shortlist.
 * @param ctx - plugin context supplying the credential seam.
 * @param config - the currently authoritative section.
 * @returns the voices, their grouping, and where they came from.
 */
async function loadVoices(ctx, config) {
  const fresh = Date.now() - voiceCache.at < VOICE_CACHE_MS
  if (fresh && voiceCache.voices.length > 0) {
    return { source: 'cache', voices: voiceCache.voices }
  }
  const apiKey = await resolveApiKey(ctx, config)
  if (apiKey === undefined) return { source: 'builtin', voices: FALLBACK_VOICES }
  try {
    const response = await fetch(`${config.baseURL.replace(/\/+$/u, '')}/v1/get_voice`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ voice_type: 'all' }),
      signal: requestSignal(undefined, config.timeoutMs),
    })
    const body = await response.json().catch(() => undefined)
    const rows = Array.isArray(body?.system_voice) ? body.system_voice : []
    const voices = rows
      .filter(row => typeof row?.voice_id === 'string' && row.voice_id.length > 0)
      .map(row => ({
        id: row.voice_id,
        name: typeof row.voice_name === 'string' && row.voice_name.length > 0 ? row.voice_name : row.voice_id,
        group: voiceGroupOf(row.voice_id),
      }))
    if (voices.length === 0) return { source: 'builtin', voices: FALLBACK_VOICES }
    voiceCache = { at: Date.now(), voices }
    return { source: 'live', voices }
  } catch {
    return { source: 'builtin', voices: FALLBACK_VOICES }
  }
}

/**
 * The spoken line each session has named for its current turn, via
 * `announce_speech`. `text: null` means "this turn stays silent". Cleared at
 * every turn end, whatever the outcome, so a line spoken for a cancelled turn
 * can never surface later.
 */
const spokenLines = new Map()

/** Every open announcement listener. A deployment with none costs nothing. */
function createAnnouncer() {  const writers = new Set()
  return {
    /**
     * Register one listener.
     * @param write - sink for one already-formatted SSE frame.
     * @returns the disposer removing it.
     */
    add(write) {
      writers.add(write)
      return () => writers.delete(write)
    },
    /** Number of listeners, for diagnostics. */
    count() {
      return writers.size
    },
    /**
     * Push one announcement to every listener.
     * @param payload - JSON-serializable announcement.
     */
    publish(payload) {
      const frame = `event: announce\ndata: ${JSON.stringify(payload)}\n\n`
      for (const write of [...writers]) {
        try {
          write(frame)
        } catch {
          writers.delete(write)
        }
      }
    },
  }
}

/** Join the text parts of one assistant message. */
function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
}

/**
 * The last assistant text of one turn, read from the session log.
 * @param session - the session whose log to scan.
 * @param turn - the turn to match, or undefined for the newest message.
 * @returns the text, or undefined when the turn produced none.
 */
function assistantTextOf(session, turn) {
  const events = session?.events
  if (!Array.isArray(events)) return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    if (turn !== undefined && event.data?.turn !== turn) continue
    const text = messageText(event.data?.message).trim()
    if (text.length > 0) return text
  }
  return undefined
}

/**
 * Strip what must never be read aloud: code fences, inline code, link targets,
 * markdown punctuation, and heading/bullet scaffolding.
 * @param source - any markdown-ish text.
 * @returns plain prose on one line.
 */
function flattenMarkup(source) {
  return String(source)
    .replace(/```[\s\S]*?```/gu, '')
    .replace(/`([^`]*)`/gu, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gmu, '')
    .replace(/^\s{0,3}[-*+]\s+/gmu, '')
    .replace(/^\s{0,3}\|.*\|\s*$/gmu, '')
    .replace(/[*_~>#|]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * The spoken form of one line: markup out, whitespace collapsed, and a line
 * over budget cut at its last sentence boundary inside the budget.
 *
 * It says nothing about the cut. An announcement that apologises for its own
 * length ("there is more, I will skip it") is just a long announcement, and the
 * whole point of a spoken line is that it is short enough to hear.
 * @param reply - the text to speak.
 * @param maxChars - the longest announcement to produce.
 * @returns the spoken form.
 */
function speechText(reply, maxChars) {
  const text = flattenMarkup(reply)
  if (text.length <= maxChars) return text
  const cut = text.slice(0, maxChars)
  const boundaries = ['。', '！', '？', '；', '. ', '! ', '? ', '; ']
    .map(mark => cut.lastIndexOf(mark))
    .filter(at => at > maxChars * 0.4)
  const at = boundaries.length > 0 ? Math.max(...boundaries) + 1 : maxChars
  return cut.slice(0, at).trim()
}

/**
 * The opening sentence of a reply — the fallback announcement for a turn that
 * did not name its own spoken line. A conclusion usually lives in the first
 * sentence, so this stays short without being a lie about the content.
 * @param reply - the assistant's text.
 * @param maxChars - the longest announcement to produce.
 * @returns the first sentence, or the leading `maxChars` characters.
 */
function openingSentence(reply, maxChars) {
  const text = flattenMarkup(reply)
  const cut = text.slice(0, maxChars)
  const boundaries = ['。', '！', '？', '. ', '! ', '? ']
    .map(mark => cut.indexOf(mark))
    .filter(at => at >= 0)
  if (boundaries.length > 0) return cut.slice(0, Math.min(...boundaries) + 1).trim()
  return cut.trim()
}

/**
 * Synthesise one line of speech through MiniMax TTS.
 * @param ctx - plugin context supplying the credential seam.
 * @param config - the currently authoritative section.
 * @param text - what to say.
 * @param overrides - per-call voice and rate, for auditioning before a save.
 * @returns the audio bytes and media type.
 */
async function requestSpeech(ctx, config, text, overrides = {}) {
  const apiKey = await resolveApiKey(ctx, config)
  if (apiKey === undefined) {
    throw new Error(
      `No MiniMax API key: store one under the ${config.apiKeyEnv} credential reference `
      + '(Settings -> Plugins -> MiniMax ASR) or export it in the environment',
    )
  }
  const voice = overrides.voice ?? config.ttsVoice
  const speed = overrides.speed ?? config.ttsSpeed
  const response = await fetch(`${config.baseURL.replace(/\/+$/u, '')}/v1/t2a_v2`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: config.ttsModel,
      text,
      stream: false,
      voice_setting: { voice_id: voice, speed, vol: 1, pitch: 0 },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
      output_format: 'hex',
    }),
    signal: requestSignal(undefined, config.timeoutMs),
  })
  const body = await response.json().catch(() => undefined)
  const code = body?.base_resp?.status_code
  if (!response.ok || code !== 0 || typeof body?.data?.audio !== 'string') {
    throw new Error(
      `MiniMax TTS failed (HTTP ${response.status}, code ${code}): ${body?.base_resp?.status_msg ?? ''}`,
    )
  }
  return {
    audio: Buffer.from(body.data.audio, 'hex'),
    mimeType: 'audio/mpeg',
    durationMs: body?.extra_info?.audio_length,
    characters: body?.extra_info?.usage_characters,
    voice,
  }
}

/**
 * Serve the announcement stream. The browser keeps this open and plays whatever
 * the host pushes, which is what makes an announcement arrive without a click.
 * @param req - the node HTTP request.
 * @param res - the node HTTP response.
 * @param announcer - the announcer receiving this listener.
 */
function serveAnnouncements(req, res, announcer) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { ok: false, error: 'use GET' })
    return
  }
  if (!isTrustedRouteRequest(req)) {
    sendJson(res, 403, { ok: false, error: 'loopback same-origin requests only' })
    return
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
  })
  res.write(': minimax-asr announcements\n\n')
  const remove = announcer.add((frame) => {
    res.write(frame)
  })
  const heartbeat = setInterval(() => {
    try {
      res.write(': hb\n\n')
    } catch {
      // A listener that cannot be written to is removed by its own close event.
    }
  }, 20000)
  const cleanup = () => {
    clearInterval(heartbeat)
    remove()
  }
  req.on('close', cleanup)
  res.on('close', cleanup)
}

/**
 * Serve one request on the plugin's route prefix.
 * @param ctx - plugin context.
 * @param configSource - thunk returning the currently authoritative section.
 * @param req - the node HTTP request.
 * @param res - the node HTTP response.
 * @param announcer - the announcement broadcaster.
 */
async function handlePluginRoute(ctx, configSource, req, res, announcer) {
  let url
  try {
    url = new URL(req.url ?? ROUTE_PREFIX, 'http://dsh.invalid')
  } catch {
    sendJson(res, 400, { ok: false, error: 'malformed request URL' })
    return
  }
  if (url.pathname === DIAGNOSTICS_ROUTE) {
    if (!isTrustedRouteRequest(req)) {
      sendJson(res, 403, { ok: false, error: 'loopback same-origin requests only' })
      return
    }
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true, listeners: announcer.count(), events: [...clientEvents] })
      return
    }
    if (req.method === 'POST') {
      let body
      try {
        body = await readRequestBody(req, 16 * 1024)
      } catch (error) {
        sendJson(res, 413, { ok: false, error: error.message })
        return
      }
      try {
        const reported = JSON.parse(body.toString('utf8'))
        if (reported === null || typeof reported !== 'object' || typeof reported.event !== 'string') {
          sendJson(res, 400, { ok: false, error: 'expected an object with an "event" string' })
          return
        }
        recordClientEvent(reported)
        sendJson(res, 200, { ok: true })
      } catch {
        sendJson(res, 400, { ok: false, error: 'body is not JSON' })
      }
      return
    }
    sendJson(res, 405, { ok: false, error: 'use GET or POST' })
    return
  }
  if (url.pathname === EVENTS_ROUTE) {
    serveAnnouncements(req, res, announcer)
    return
  }
  if (url.pathname === SPEAK_ROUTE) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'use POST' })
      return
    }
    if (!isTrustedRouteRequest(req)) {
      sendJson(res, 403, { ok: false, error: 'loopback same-origin requests only' })
      return
    }
    let body
    try {
      body = await readRequestBody(req, 32 * 1024)
    } catch (error) {
      sendJson(res, 413, { ok: false, error: error.message })
      return
    }
    let text = ''
    let voice
    let speed
    try {
      const parsed = JSON.parse(body.toString('utf8') || '{}')
      text = typeof parsed?.text === 'string' ? parsed.text.trim() : ''
      // A per-call voice lets the card audition a voice before saving it.
      if (typeof parsed?.voice === 'string' && parsed.voice.trim().length > 0) {
        voice = parsed.voice.trim().slice(0, 128)
      }
      if (typeof parsed?.speed === 'number' && Number.isFinite(parsed.speed)) {
        speed = Math.min(2, Math.max(0.5, parsed.speed))
      }
    } catch {
      sendJson(res, 400, { ok: false, error: 'body is not JSON' })
      return
    }
    if (text.length === 0) {
      sendJson(res, 400, { ok: false, error: 'text is required' })
      return
    }
    const config = configSource()
    try {
      const speech = await requestSpeech(ctx, config, speechText(text, config.speakMaxChars), { voice, speed })
      res.writeHead(200, {
        'content-type': speech.mimeType,
        'content-length': speech.audio.length,
        'cache-control': 'no-store',
        'x-audio-duration-ms': String(speech.durationMs ?? ''),
        'x-tts-voice': speech.voice,
      })
      res.end(speech.audio)
    } catch (error) {
      sendJson(res, 502, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
    return
  }
  if (url.pathname === VOICES_ROUTE) {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'use GET' })
      return
    }
    if (!isTrustedRouteRequest(req)) {
      sendJson(res, 403, { ok: false, error: 'loopback same-origin requests only' })
      return
    }
    const config = configSource()
    try {
      const catalogue = await loadVoices(ctx, config)
      sendJson(res, 200, { ok: true, ...catalogue })
    } catch (error) {
      sendJson(res, 502, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        source: 'unavailable',
        voices: [],
      })
    }
    return
  }
  if (url.pathname === TRANSCRIBE_ROUTE) {
    await handleTranscribeRoute(ctx, configSource, req, res)
    return
  }
  sendJson(res, 404, { ok: false, error: `unknown ${ROUTE_PREFIX} route` })
}

/**
 * Serve one browser voice-input recording: validate the fence and the body,
 * then transcribe through the same path the tool uses.
 * @param ctx - plugin context.
 * @param configSource - thunk returning the currently authoritative section.
 * @param req - the node HTTP request.
 * @param res - the node HTTP response.
 */
async function handleTranscribeRoute(ctx, configSource, req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'use POST' })
    return
  }
  if (!isTrustedRouteRequest(req)) {
    sendJson(res, 403, { ok: false, error: 'loopback same-origin requests only' })
    return
  }

  const config = configSource()
  const limit = config.maxFileMB * 1024 * 1024
  const declared = Number(req.headers['content-length'] ?? Number.NaN)
  if (Number.isFinite(declared) && declared > limit) {
    sendJson(res, 413, { ok: false, error: `recording exceeds the ${config.maxFileMB} MB limit` })
    return
  }

  let data
  try {
    data = await readRequestBody(req, limit)
  } catch (error) {
    sendJson(res, 413, { ok: false, error: error.message })
    return
  }
  if (data.length === 0) {
    sendJson(res, 400, { ok: false, error: 'empty recording' })
    return
  }

  let url
  try {
    url = new URL(req.url ?? TRANSCRIBE_ROUTE, 'http://dsh.invalid')
  } catch {
    sendJson(res, 400, { ok: false, error: 'malformed request URL' })
    return
  }

  try {
    const filename = safeRecordingName(url.searchParams.get('name'))
    const extension = extname(filename).toLowerCase()
    const value = await requestTranscription(ctx, config, {
      data,
      filename,
      mediaType: SUPPORTED_EXTENSIONS.get(extension) ?? 'audio/wav',
      format: readRouteFormat(url.searchParams.get('format'), config.responseFormat),
      level: readRouteLevel(url.searchParams.get('level'), config.timestampLevel),
      language: (url.searchParams.get('language') ?? config.language ?? '').trim(),
      signal: undefined,
    })
    sendJson(res, 200, { ok: true, ...value })
  } catch (error) {
    sendJson(res, 502, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * Register the `transcribe_audio` tool, this plugin's settings namespace, and
 * the local voice-input route.
 * @param ctx - the plugin context.
 * @param entry - the loader entry configuration.
 */
export function apply(ctx, entry) {
  // Without a settings provider the entry itself is the whole configuration.
  let source = () => normalizeConfig(entry)
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, MINIMAX_ASR_SETTINGS_NAMESPACE, Config, entry ?? {}, {
      setSource: (current) => {
        source = current
      },
      // Every read below projects the section per call, so a committed change
      // needs no re-registration.
      onChange: () => {},
    })
  })

  // The browser voice input posts one recording here, the browser keeps an
  // announcement stream open next door, and the browser half reports its own
  // wiring on the third route; a deployment without a web server simply has no
  // routes (the tool above is unaffected).
  const announcer = createAnnouncer()
  ctx.inject(['webServer'], (webCtx) => {
    ctx.effect(
      () => webCtx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => handlePluginRoute(ctx, () => source(), req, res, announcer),
      }),
      'dsh-minimax-asr: local routes',
    )
  })

  // Announcing: a completed turn becomes one short spoken line.
  //
  // The line is deliberately NOT the reply. The reply is written to be read;
  // an announcement has to be heard, so the turn is invited to name its own
  // (the `announce_speech` tool below) and the fallback is only the reply's
  // opening sentence — never a long text read out loud.
  //
  // A turn that ended any other way still publishes a frame with no text: the
  // browser's handsfree loop re-arms on it instead of waiting forever for a
  // reply that was cancelled.
  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type !== 'turn/end') return
      const reason = typeof event.data?.reason?.kind === 'string' ? event.data.reason.kind : 'unknown'
      const sessionId = String(session?.id ?? session?.sessionId ?? '')
      const pending = spokenLines.get(sessionId)
      spokenLines.delete(sessionId)
      if (reason !== 'completed') {
        announcer.publish({ type: 'announce', sessionId, turn: event.data?.turn, reason, text: '' })
        return
      }
      const config = source()
      if (config.speakEnabled !== true && config.voiceLoop !== true) return
      if (pending !== undefined && pending.text === null) {
        // The turn asked to stay silent; the loop still gets its re-arm frame.
        announcer.publish({ type: 'announce', sessionId, turn: event.data?.turn, reason, text: '', source: 'silent' })
        return
      }
      if (pending !== undefined) {
        const text = speechText(pending.text, config.speakMaxChars)
        announcer.publish({
          type: 'announce', sessionId, turn: event.data?.turn, reason: 'completed', text, source: 'spoken-line',
        })
        return
      }
      const reply = assistantTextOf(session, event.data.turn)
      if (reply === undefined) {
        announcer.publish({ type: 'announce', sessionId, turn: event.data?.turn, reason, text: '' })
        return
      }
      announcer.publish({
        type: 'announce',
        sessionId,
        turn: event.data.turn,
        reason: 'completed',
        text: openingSentence(reply, config.speakMaxChars),
        source: 'reply-head',
      })
    } catch (error) {
      ctx.logger?.warn?.(`minimax-asr: announcement failed for turn ${event?.data?.turn}: ${error.message}`)
    }
  })

  ctx.tools.register(defineTool({
    name: 'transcribe_audio',
    description:
      'Transcribe a local audio file to text with MiniMax speech recognition (model asr-1.0). '
      + 'Returns the transcript, the audio duration, and — for timestamp-bearing response formats — '
      + 'per-segment speakers and times. Accepted formats: wav, aiff, flac, m4a/alac, mp3, aac, opus, ogg '
      + '(no bare PCM, no webm). Limits: at most 500 seconds and 50 MB per file.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Path to a local audio file. Relative paths resolve against the process working directory.',
      },
      language: {
        type: 'string',
        description:
          'Optional BCP-47 hint for the main language of the audio (zh, yue, en, ja, ko, th, vi, id, ms, fil, ar, tr, fr, de, es, it, pt, pl, ru, uk). '
          + 'Omit or leave empty for mixed-language recognition.',
      },
      response_format: {
        type: 'string',
        enum: ['json', 'verbose_json', 'srt', 'vtt'],
        description:
          'json returns text and duration; verbose_json adds speaker-separated timestamped segments; '
          + 'srt and vtt return subtitle text instead.',
      },
      timestamp_level: {
        type: 'string',
        enum: ['sentence', 'word'],
        description:
          'Timestamp granularity for verbose_json/srt/vtt: sentence (default) keeps sentence segments, '
          + 'word returns word-level (character-level for Chinese) units. Ignored for json.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          text: { type: 'string', required: true },
          format: { type: 'string', required: true },
          model: { type: 'string', required: true },
          durationSeconds: { type: 'number' },
          speakers: { type: 'integer' },
          traceId: { type: 'string' },
          segments: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                start: { type: 'number', required: true },
                end: { type: 'number', required: true },
                speaker: { type: 'string' },
                text: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => renderTranscript(value),
    },
    // Uploading one file mutates no parent-agent state.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const config = source()
      const path = args.path.trim()
      if (path.length === 0) throw new Error('path must be a non-empty string')

      const format = args.response_format ?? config.responseFormat
      if (!JSON_FORMATS.has(format) && !TEXT_FORMATS.has(format)) {
        throw new Error(`minimax-asr: unsupported response_format ${JSON.stringify(format)}`)
      }
      const level = args.timestamp_level ?? config.timestampLevel
      if (level !== '' && !TIMESTAMP_LEVELS.has(level)) {
        throw new Error(`minimax-asr: unsupported timestamp_level ${JSON.stringify(level)}`)
      }
      const language = (args.language ?? config.language ?? '').trim()

      let info
      try {
        info = await stat(path)
      } catch (error) {
        throw new Error(`Cannot read ${path}: ${error.code ?? error.message}`)
      }
      if (!info.isFile()) throw new Error(`${path} is not a regular file`)

      const extension = extname(path).toLowerCase()
      const mediaType = SUPPORTED_EXTENSIONS.get(extension)
      if (mediaType === undefined) {
        throw new Error(
          `Unsupported audio extension ${extension === '' ? '(none)' : extension} — MiniMax accepts `
          + `${[...SUPPORTED_EXTENSIONS.keys()].join(', ')}; convert the file first (mono 16 kHz mp3 is a safe target)`,
        )
      }

      const limit = config.maxFileMB * 1024 * 1024
      if (info.size > limit) {
        throw new Error(
          `${basename(path)} is ${(info.size / 1024 / 1024).toFixed(1)} MB, above the configured `
          + `${config.maxFileMB} MB limit (MiniMax rejects request bodies over 50 MB)`,
        )
      }

      const data = await readFile(path)
      const value = await requestTranscription(ctx, config, {
        data,
        filename: basename(path),
        mediaType,
        format,
        level,
        language,
        signal: exec.signal,
      })
      return { path, ...value }
    },
  }))

  // The spoken line. This is how a turn says what the user should HEAR, which
  // is not the same thing as what the user should read: a reply is written for
  // the screen, while an announcement has to land in a few seconds of audio.
  // Every word below is part of the model-facing contract, so it says plainly
  // what to pass and what not to.
  ctx.tools.register(defineTool({
    name: 'announce_speech',
    description:
      'Name the one or two sentences the user will HEAR through their speakers when this turn ends. '
      + 'Pass a distilled spoken summary in your own words — the outcome, the number that matters, and '
      + 'what you need from the user next — NOT a copy of your reply, and never a sentence-by-sentence '
      + 'reading of it. Write it the way you would say it out loud: one or two short sentences, no '
      + 'markdown, no code, no file paths, no lists, no "as I mentioned above". Aim for well under '
      + '160 characters; the host cuts anything longer at a sentence and says nothing about the cut. '
      + 'Call it once per turn, after the work is done, so the announcement matches the finished result. '
      + 'If nothing is worth saying out loud, call it with silent:true instead. This tool never changes '
      + 'your visible reply, and the user hears nothing at all if they have announcements switched off.',
    parameters: {
      text: {
        type: 'string',
        description:
          'The spoken line, in the user\'s own language, as one or two sentences a person would say. '
          + 'Omit it only when passing silent:true.',
      },
      silent: {
        type: 'boolean',
        description:
          'Set true to announce nothing this turn (a trivial or fully silent result). Do not pass text as well.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          spoken: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
          characters: { type: 'integer', required: true },
          mode: { type: 'string', required: true },
        },
      },
      render: (_args, value) => (value.spoken === true
        ? [{ type: 'text', text: `The announcement for this turn is set (${value.characters} characters): ${value.text}` }]
        : [{ type: 'text', text: 'This turn will not be announced.' }]),
    },
    // Naming a line touches nothing but this plugin's own per-session slot.
    isConcurrencySafe: () => true,
    execute(args, exec) {
      const silent = args.silent === true
      const text = typeof args.text === 'string' ? flattenMarkup(args.text) : ''
      if (silent && text.length > 0) {
        throw new Error('pass either text or silent:true, not both')
      }
      if (!silent && text.length === 0) {
        throw new Error('text is required unless silent:true is passed')
      }
      if (text.length > 600) {
        throw new Error(
          `the spoken line is ${text.length} characters — an announcement is one or two sentences, `
          + 'not a summary of the whole reply; distil it further',
        )
      }
      const config = source()
      const spoken = text.length > 0 ? speechText(text, config.speakMaxChars) : ''
      const sessionId = exec?.agent?.session?.header?.id
      if (sessionId !== undefined) {
        spokenLines.set(String(sessionId), { text: silent ? null : spoken, at: Date.now() })
      }
      return {
        spoken: silent ? false : true,
        text: silent ? '' : spoken,
        characters: spoken.length,
        mode: silent ? 'silent' : 'spoken-line',
      }
    },
  }))
}
