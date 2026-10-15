// Pure helper functions for STT provider HTTP requests and responses.

/**
 * Check if the language is unspecified or set to automatic detection.
 * @param {string} [lang]
 * @returns {boolean}
 */
export function isAutoLang(lang) {
  return !lang || lang === 'auto' || String(lang).includes(',')
}

/**
 * Determine the audio container format supported by the OpenAI Chat Audio API.
 * @param {string} [mime='']
 * @returns {'wav' | 'mp3' | ''}
 */
export function chatAudioFormat(mime = '') {
  if (mime.includes('wav')) return 'wav'
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3'
  return ''
}

/**
 * Return a safe file name based on mime type for multipart form uploads.
 * @param {string} [mime='']
 * @returns {string}
 */
export function fileName(mime = '') {
  if (mime.includes('wav')) return 'audio.wav'
  if (mime.includes('ogg')) return 'audio.ogg'
  if (mime.includes('mp4')) return 'audio.m4a'
  return 'audio.webm'
}

/**
 * Safely parse JSON from a response or throw a standardized descriptive Error.
 * @param {Response} res
 * @param {string} defaultLabel
 * @returns {Promise<any>}
 */
export async function safeJson(res, defaultLabel) {
  try {
    return await res.json()
  } catch {
    throw new Error(`${defaultLabel}: invalid JSON response`)
  }
}

/**
 * Extract an error message or detail string from a non-2xx HTTP response.
 * @param {Response} res
 * @param {string} defaultLabel
 * @returns {Promise<string>}
 */
export async function readErrorDetail(res, defaultLabel) {
  let detail = `HTTP ${res.status}`
  try {
    const e = await res.json()
    if (e?.error) detail = typeof e.error === 'string' ? e.error : (e.error.message || JSON.stringify(e.error))
    else if (e?.message) detail = e.message
    else if (e?.err_msg) detail = e.err_msg
  } catch { /* not json */ }
  return `${defaultLabel} ${detail}`
}
