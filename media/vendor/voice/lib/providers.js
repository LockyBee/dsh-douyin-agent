// Speech recognition providers: built-ins plus custom ones from settings.
// Pure functions: network arrives as fetchImpl, keys via resolveKey, so
// everything is testable without real requests.

// 'browser' is listed for chain validation only: recognition runs in the
// page and audio never reaches the host. Without this key a ['browser','groq']
// chain would break on the host instead of falling through to groq.
export const PROVIDER_KEYS = ['browser', 'browser-webgpu', 'deepgram', 'groq', 'hf', 'local-whisper', 'sensevoice']

// Custom providers use one of two templates because OpenAI-compatible APIs
// diverged: OpenRouter has no /audio/transcriptions and recognizes via chat.
export const CUSTOM_TEMPLATES = ['openai-transcriptions', 'openai-chat-audio']

// Presets: the same as a custom provider with address, model and key name
// already filled in. Only the key itself is required.
//
// Each URL answers 401 without a key, so the path exists. The model is a
// reasonable starting point and can be overridden per chain row.
//
// A custom provider with the same name fully replaces a preset: presets are
// prefilled forms, not special engines.
export const PRESET_PROVIDERS = {
  openai: {
    template: 'openai-transcriptions',
    baseURL: 'https://api.openai.com/v1',
    model: 'whisper-1',
    keyEnv: 'OPENAI_API_KEY',
  },
  siliconflow: {
    template: 'openai-transcriptions',
    baseURL: 'https://api.siliconflow.cn/v1',
    model: 'FunAudioLLM/SenseVoiceSmall',
    keyEnv: 'SILICONFLOW_API_KEY',
  },
  deepinfra: {
    template: 'openai-transcriptions',
    baseURL: 'https://api.deepinfra.com/v1/openai',
    model: 'openai/whisper-large-v3-turbo',
    keyEnv: 'DEEPINFRA_API_KEY',
  },
  fireworks: {
    template: 'openai-transcriptions',
    baseURL: 'https://api.fireworks.ai/inference/v1',
    model: 'whisper-v3-turbo',
    keyEnv: 'FIREWORKS_API_KEY',
  },
  mistral: {
    template: 'openai-transcriptions',
    baseURL: 'https://api.mistral.ai/v1',
    model: 'voxtral-mini-latest',
    keyEnv: 'MISTRAL_API_KEY',
  },
  // OpenRouter has no /audio/transcriptions at all — chat only.
  openrouter: {
    template: 'openai-chat-audio',
    baseURL: 'https://openrouter.ai/api/v1',
    model: 'google/gemini-2.5-flash',
    keyEnv: 'OPENROUTER_API_KEY',
  },
}

export const PRESET_KEYS = Object.keys(PRESET_PROVIDERS)

/** All names usable in a chain without declaring a custom provider. */
export const KNOWN_KEYS = PROVIDER_KEYS.concat(PRESET_KEYS)

const CHAT_AUDIO_PROMPT =
  'Transcribe the audio verbatim. Reply with the transcript text only, '
  + 'without comments, quotes or formatting.'

import { readErrorDetail, safeJson, isAutoLang, fileName, chatAudioFormat } from './provider-http.js'
export { readErrorDetail, safeJson, isAutoLang, fileName, chatAudioFormat }

export const DEFAULT_MODELS = {
  deepgram: 'nova-2',
  groq: 'whisper-large-v3-turbo',
  hf: 'openai/whisper-large-v3',
  'local-whisper': '',
  sensevoice: 'SenseVoiceSmall',
}

function pickModel(models, key) {
  const chosen = models && typeof models[key] === 'string' ? models[key].trim() : ''
  return chosen || DEFAULT_MODELS[key]
}


export function makeProviders(deps, req) {
  const { resolveKey, fetchImpl, cfg } = deps
  const { bytes, mime, lang, signal, models } = req
  const vocab = Array.isArray(req.vocabulary)
    ? req.vocabulary.map((w) => String(w || '').trim()).filter(Boolean).join(', ')
    : ''

  async function deepgram() {
    const key = await resolveKey(cfg.deepgramKeyEnv)
    if (!key) return { ok: false, provider: 'deepgram', reason: `no ${cfg.deepgramKeyEnv}` }
    const model = pickModel(models, 'deepgram')
    const base = String(cfg.deepgramBaseUrl || 'https://api.deepgram.com').replace(/\/+$/, '')
    const url = `${base}/v1/listen?model=${encodeURIComponent(model)}`
      + (!isAutoLang(lang) ? `&language=${encodeURIComponent(lang)}` : '')
      + (vocab ? `&keywords=${encodeURIComponent(vocab)}` : '')
      + '&smart_format=true'
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Token ${key}`, 'content-type': mime },
      body: bytes,
      signal,
      keepalive: true,
    })
    if (!res.ok) throw new Error(await readErrorDetail(res, 'Deepgram'))
    let data
    try { data = await safeJson(res, 'Deepgram') } catch (e) {
      return { ok: false, provider: 'deepgram', reason: e.message }
    }
    const text = (data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '').trim()
    return { ok: text.length > 0, provider: 'deepgram', text, reason: text ? '' : 'empty transcript' }
  }

  async function groq() {
    const key = await resolveKey(cfg.groqKeyEnv)
    if (!key) return { ok: false, provider: 'groq', reason: `no ${cfg.groqKeyEnv}` }
    const form = new FormData()
    form.append('file', new Blob([bytes], { type: mime }), fileName(mime))
    form.append('model', pickModel(models, 'groq'))
    if (!isAutoLang(lang)) form.append('language', lang)
    if (vocab) form.append('prompt', vocab)
    form.append('response_format', 'json')
    const res = await fetchImpl('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: form,
      signal,
      keepalive: true,
    })
    if (!res.ok) throw new Error(await readErrorDetail(res, 'Groq'))
    let data
    try { data = await safeJson(res, 'Groq') } catch (e) {
      return { ok: false, provider: 'groq', reason: e.message }
    }
    const text = (data?.text || '').trim()
    return { ok: text.length > 0, provider: 'groq', text, reason: text ? '' : 'empty transcript' }
  }

  async function hf() {
    const token = await resolveKey(cfg.hfTokenEnv)
    if (!token) return { ok: false, provider: 'hf', reason: `no ${cfg.hfTokenEnv}` }
    const model = pickModel(models, 'hf')
    const res = await fetchImpl(`https://router.huggingface.co/hf-inference/models/${model}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': mime, 'x-wait-for-model': 'true' },
      body: bytes,
      signal,
      keepalive: true,
    })
    if (!res.ok) throw new Error(await readErrorDetail(res, 'HF'))
    let data
    try { data = await safeJson(res, 'HF') } catch (e) {
      return { ok: false, provider: 'hf', reason: e.message }
    }
    const text = (data?.text || '').trim()
    return { ok: text.length > 0, provider: 'hf', text, reason: text ? '' : 'empty transcript' }
  }

  // whisper.cpp accepts WAV only — browser webm/opus gets "Invalid request".
  // Convert when the format is not WAV.
  async function localWhisper() {
    let sendBytes = bytes
    let sendMime = mime
    if (!mime.includes('wav')) {
      if (typeof deps.toWav !== 'function') {
        return { ok: false, provider: 'local-whisper', reason: 'local whisper needs WAV, no converter configured' }
      }
      try {
        sendBytes = await deps.toWav(bytes, signal)
        sendMime = 'audio/wav'
      } catch (e) {
        return { ok: false, provider: 'local-whisper', reason: `local whisper: ${String(e && e.message || e)}` }
      }
    }
    const form = new FormData()
    form.append('file', new Blob([sendBytes], { type: sendMime }), fileName(sendMime))
    // Unlike OpenAI-compatible APIs, whisper.cpp inherits its server's default
    // language when the form omits this field (normally `en`). Send `auto`
    // explicitly so every request detects the spoken language.
    form.append('language', isAutoLang(lang) ? 'auto' : lang)
    // Also override a server started with --translate: this plugin always needs
    // a transcript in the spoken language, never Whisper's English translation.
    form.append('translate', 'false')
    if (vocab) form.append('prompt', vocab)
    form.append('response_format', 'json')
    const res = await fetchImpl(cfg.whisperUrl, { method: 'POST', body: form, signal })
    // whisper.cpp returns 400 with a JSON body on internal failures (e.g. decode
    // errors) — read the reason instead of throwing.
    if (!res.ok) {
      let detail = `HTTP ${res.status}`
      try { const e = await res.json(); if (e?.error) detail = e.error } catch { /* body is not json */ }
      return { ok: false, provider: 'local-whisper', reason: `local whisper: ${detail}` }
    }
    let data
    try { data = await safeJson(res, 'local whisper') } catch (e) {
      return { ok: false, provider: 'local-whisper', reason: e.message }
    }
    const text = (data?.text || '').trim()
    return { ok: text.length > 0, provider: 'local-whisper', text, reason: text ? '' : 'empty transcript' }
  }

  // SenseVoice-ONNX / Sherpa-ONNX: ultra-fast local recognition (~50-100ms).
  // Supports sherpa-onnx (/api/v1/asr) and OpenAI-compatible endpoints.
  async function sensevoice() {
    const url = String(cfg.sensevoiceUrl || 'http://127.0.0.1:6006/api/v1/asr').trim()
    let sendBytes = bytes
    let sendMime = mime
    if (!mime.includes('wav')) {
      if (typeof deps.toWav !== 'function') {
        return { ok: false, provider: 'sensevoice', reason: 'sensevoice needs WAV, no converter configured' }
      }
      try {
        sendBytes = await deps.toWav(bytes, signal)
        sendMime = 'audio/wav'
      } catch (e) {
        return { ok: false, provider: 'sensevoice', reason: `sensevoice: ${String(e && e.message || e)}` }
      }
    }
    const form = new FormData()
    form.append('file', new Blob([sendBytes], { type: sendMime }), fileName(sendMime))
    const isOpenAI = url.includes('/transcriptions')
    if (isOpenAI) {
      form.append('model', pickModel(models, 'sensevoice'))
      if (!isAutoLang(lang)) form.append('language', lang)
      if (vocab) form.append('prompt', vocab)
      form.append('response_format', 'json')
    }

    let res
    try {
      res = await fetchImpl(url, { method: 'POST', body: form, signal })
    } catch (e) {
      return { ok: false, provider: 'sensevoice', reason: `sensevoice: ${String(e && e.message || e)}` }
    }

    if (!res.ok) {
      let detail = `HTTP ${res.status}`
      try { const e = await res.json(); if (e?.error) detail = e.error } catch { /* body is not json */ }
      return { ok: false, provider: 'sensevoice', reason: `sensevoice: ${detail}` }
    }

    let data
    try {
      data = await res.json()
    } catch {
      return { ok: false, provider: 'sensevoice', reason: 'sensevoice: invalid json response' }
    }

    let text = String(data?.text || data?.transcript || '').trim()
    // Strip SenseVoice emotion/event tags (<|NEUTRAL|>, <|HAPPY|>, <|Speech|>, ...).
    text = text.replace(/<\|[^|>]+\|>/g, '').trim()
    return {
      ok: text.length > 0,
      provider: 'sensevoice',
      text,
      reason: text ? '' : 'empty transcript',
    }
  }

  // Custom provider. The chain key is its name, so the rest of the code
  // treats it like a built-in.
  function customProvider(spec) {
    const label = spec.key
    const base = String(spec.baseURL || '').replace(/\/+$/, '')
    const model = pickModel(models, label) || spec.model

    async function auth() {
      if (!spec.keyEnv) return {}
      const key = await resolveKey(spec.keyEnv)
      if (!key) return null
      return { authorization: `Bearer ${key}` }
    }

    async function viaTranscriptions(headers) {
      const form = new FormData()
      form.append('file', new Blob([bytes], { type: mime }), fileName(mime))
      form.append('model', model)
      if (lang && lang !== 'auto') form.append('language', lang)
      if (vocab) form.append('prompt', vocab)
      form.append('response_format', 'json')
      const res = await fetchImpl(`${base}/audio/transcriptions`, {
        method: 'POST', headers, body: form, signal,
      })
      if (!res.ok) throw new Error(await readErrorDetail(res, label))
      const data = await safeJson(res, label)
      return (data?.text || '').trim()
    }

    async function viaChatAudio(headers) {
      let sendBytes = bytes
      let format = chatAudioFormat(mime)
      if (!format) {
        if (typeof deps.toWav !== 'function') {
          throw new Error(`${label}: chat template needs wav or mp3, unsupported format ${mime}`)
        }
        sendBytes = await deps.toWav(bytes, signal)
        format = 'wav'
      }
      const ask = (spec.prompt || CHAT_AUDIO_PROMPT)
        + (vocab ? ` Vocabulary hints (spell these correctly): ${vocab}.` : '')
        + (lang && lang !== 'auto' ? ` The audio language is ${lang}.` : '')
      const res = await fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: ask },
              { type: 'input_audio', input_audio: { data: Buffer.from(sendBytes).toString('base64'), format } },
            ],
          }],
        }),
        signal,
      })
      if (!res.ok) throw new Error(await readErrorDetail(res, label))
      const data = await safeJson(res, label)
      return String(data?.choices?.[0]?.message?.content || '').trim()
    }

    return async function run() {
      if (!base) return { ok: false, provider: label, reason: `${label}: no baseURL` }
      if (!model) return { ok: false, provider: label, reason: `${label}: no model` }
      const headers = await auth()
      if (headers === null) return { ok: false, provider: label, reason: `no ${spec.keyEnv}` }
      let text
      try {
        text = spec.template === 'openai-chat-audio'
          ? await viaChatAudio(headers)
          : await viaTranscriptions(headers)
      } catch (e) {
        // One provider failure must not abort the chain — the chain decides
        // whether to continue or give up.
        return { ok: false, provider: label, reason: `${label}: ${String(e && e.message || e)}` }
      }
      return { ok: text.length > 0, provider: label, text, reason: text ? '' : 'empty transcript' }
    }
  }

  // If audio still reached the host with 'browser' or 'browser-webgpu' in the chain,
  // the client-side leg failed: fail clearly and move on.
  async function browser() {
    return {
      ok: false,
      provider: 'browser',
      reason: 'browser: recognition runs in the page, the host has no browser engine',
    }
  }

  async function browserWebGpu() {
    return {
      ok: false,
      provider: 'browser-webgpu',
      reason: 'browser-webgpu: recognition runs in the page via WebGPU/WASM, the host has no browser engine',
    }
  }

  const out = { browser, 'browser-webgpu': browserWebGpu, deepgram, groq, hf, 'local-whisper': localWhisper, sensevoice }

  // Presets: custom providers with the form pre-filled.
  for (const key of PRESET_KEYS) {
    if (out[key]) continue
    out[key] = customProvider({ ...PRESET_PROVIDERS[key], key })
  }

  for (const spec of Array.isArray(cfg.customProviders) ? cfg.customProviders : []) {
    const key = String(spec && spec.key || '').trim()
    // Do not override built-in engines: a typo would silently replace a working
    // provider in a chain. Presets may be overridden — that is their purpose.
    if (!key || PROVIDER_KEYS.includes(key)) continue
    out[key] = customProvider({ ...spec, key })
  }
  return out
}
