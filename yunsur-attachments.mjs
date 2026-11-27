import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadPublicMedia, isDouyinAttachmentUrl, runMediaProcess } from './media/index.mjs';
import { resolveNodeExecutable } from './runtime-paths.mjs';

const FILE_TEXT_LIMIT = 8000;
const TEXT_TYPES = new Set(['txt', 'md', 'csv', 'tsv', 'json', 'jsonl', 'xml', 'yaml', 'yml', 'log', 'srt', 'vtt']);
const FILE_MIME_TYPES = new Map([
  ['application/pdf', 'pdf'], ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['text/plain', 'txt'], ['text/markdown', 'md'], ['text/csv', 'csv'], ['text/tab-separated-values', 'tsv'],
  ['application/json', 'json'], ['application/xml', 'xml'], ['text/xml', 'xml'], ['text/vtt', 'vtt'],
]);
const VIDEO_FORMATS = 'mov,matroska,webm,avi,mpegts,flv';
const MAX_PIXELS = 33_177_600;

function explicitUrls(value) {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  const list = value.url_list;
  return [value.url, value.uri, ...(Array.isArray(list) ? list.slice(0, 8) : [])];
}

export function messageAttachment(type, content) {
  if (type !== 'file' && type !== 'video-attachment') return null;
  const video = content.video;
  const fields = type === 'file' ? [content.download_url, content.file_url, content.resource_url, content.uri, content.url]
    : [video?.play_addr, video?.play_url, video?.download_url, video?.resource_url, video, video?.tkey,
      content.video_url, content.play_addr, content.play_url, content.download_url];
  const urls = [...new Set(fields.flatMap(explicitUrls).filter(isDouyinAttachmentUrl))].slice(0, 4);
  const filename = path.win32.basename(String(content.name || content.file_name || '').slice(0, 512))
    .replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 160);
  const declaredFormat = [content.format, content.mime_type].flatMap(value => typeof value === 'string'
    ? [value.split(';', 1)[0].toLowerCase().trim().replace(/^\./, '')] : [])
    .find(value => value && value !== 'application/octet-stream');
  const format = FILE_MIME_TYPES.get(declaredFormat) ?? declaredFormat ?? path.extname(filename).toLowerCase().slice(1);
  const reportedBytes = Number(content.data_size);
  const readableFile = (TEXT_TYPES.has(format) || format === 'docx' || format === 'pdf') && !(reportedBytes > 10 * 1024 * 1024);
  return { type, urls, filename, format,
    readable: urls.length > 0 && (type === 'video-attachment' || readableFile),
    reportedBytes: type === 'file' && Number.isSafeInteger(reportedBytes) && reportedBytes > 0 ? reportedBytes : null,
    checksum: type === 'file' && typeof content.md5 === 'string' && /^[a-f0-9]{32}$/i.test(content.md5)
      ? content.md5.toLowerCase() : null };
}

function decodeText(bytes) {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  let text;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch (error) {
    if (encoding !== 'utf-8' || bytes.includes(0)) throw error;
    text = new TextDecoder('gb18030', { fatal: true }).decode(bytes);
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw Error('附件不是可读取的文字。');
  return text;
}

function readWordParagraphs(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || !/<w:document\b/.test(xml)) throw Error('Word 附件没有可读取的正文。');
  const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
  const parts = [];
  for (const match of xml.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<\/w:p>|<w:(?:tab|br)\b[^>]*\/>/g)) {
    parts.push(match[1] === undefined ? (match[0].startsWith('<w:tab') ? '\t' : '\n')
      : match[1].replace(/&(?:amp|lt|gt|quot|apos);/g, entity => entities[entity]));
  }
  return parts.join('');
}

async function fileText(file, attachment, signal) {
  const bytes = await fs.readFile(file, { signal });
  if ((attachment.reportedBytes && bytes.length !== attachment.reportedBytes) ||
      (attachment.checksum && createHash('md5').update(bytes).digest('hex') !== attachment.checksum)) {
    throw Error('附件字节与消息记录不一致。');
  }
  let text;
  let truncated = false;
  if (attachment.format === 'docx') {
    if (bytes.readUInt32LE(0) !== 0x04034b50) throw Error('Word 附件格式无效。');
    const xml = await runMediaProcess('tar', ['-xOf', file, 'word/document.xml'],
      { signal, timeoutMs: 5000, maxOutputBytes: 1_000_000 });
    text = readWordParagraphs(xml);
  } else if (attachment.format === 'pdf') {
    const worker = fileURLToPath(new URL('./media/pdf-text-worker.mjs', import.meta.url));
    const extracted = JSON.parse(await runMediaProcess(resolveNodeExecutable(), ['--max-old-space-size=128', worker, file],
      { signal, timeoutMs: 8000, maxOutputBytes: 52_000 }));
    if (typeof extracted.text !== 'string') throw Error('PDF 附件没有可读取的正文。');
    text = extracted.text;
    truncated = extracted.truncated === true;
  } else {
    text = decodeText(bytes);
    if (/^%PDF-/i.test(text) || attachment.format !== 'xml' && /^\s*(?:<!doctype\s+html\b|<html\b)/i.test(text)) {
      throw Error('未取得文件正文。');
    }
  }
  text = text.trim();
  if (!text) throw Error('附件没有可读取的文字。');
  return { frames: [], understandingScope: 'single-message-file-text',
    fileText: { filename: attachment.filename, format: attachment.format, text: text.slice(0, FILE_TEXT_LIMIT),
      truncated: truncated || text.length > FILE_TEXT_LIMIT },
    note: '这是指定文件中提取的文字。图片、排版和截断后的内容不在本次读取范围内。' };
}

async function videoSamples(file, directory, signal) {
  const localInput = ['-protocol_whitelist', 'file', '-format_whitelist', VIDEO_FORMATS];
  const probe = JSON.parse(await runMediaProcess('ffprobe', ['-v', 'error', ...localInput,
    '-show_entries', 'format=duration:stream=index,codec_type,width,height,duration:stream_disposition=attached_pic', '-of', 'json', file],
  { signal, timeoutMs: 5000, maxOutputBytes: 10_000 }));
  const stream = probe.streams?.find(item => item.codec_type === 'video' && !item.disposition?.attached_pic &&
    Number.isSafeInteger(item.index) && item.width > 0 && item.height > 0 && item.width * item.height <= MAX_PIXELS);
  const durationSeconds = [stream?.duration, probe.format?.duration].map(Number).find(seconds => Number.isFinite(seconds) && seconds > 0);
  if (!stream || !durationSeconds) throw Error('视频附件中没有可核对的正片。');
  const frames = [];
  const positions = durationSeconds < 0.25 ? [0] : [0.1, 0.45, 0.8].map(fraction => durationSeconds * fraction);
  for (const [index, time] of positions.entries()) {
    const image = path.join(directory, `frame-${index}.jpg`);
    try {
      await runMediaProcess('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...localInput,
        '-threads', '2', '-max_pixels', String(MAX_PIXELS), '-ss', String(time), '-i', file,
        '-map', `0:${stream.index}`, '-frames:v', '1', '-an',
        '-vf', 'scale=480:480:force_original_aspect_ratio=decrease:force_divisible_by=2', '-q:v', '4', '-update', '1', image],
      { signal, timeoutMs: 5000, maxOutputBytes: 1000 });
      const bytes = await fs.readFile(image, { signal });
      if (bytes.length && bytes.length <= 2_000_000) frames.push({
        mimeType: 'image/jpeg', data: bytes.toString('base64'), time, timeSemantics: 'approximate-seek-position',
      });
    } catch { signal.throwIfAborted(); }
  }
  if (!frames.length) throw Error('视频附件没有可读取的正片画面。');
  return { frames, understandingScope: 'single-message-video-samples', videoAttachment: { durationSeconds },
    note: '画面从指定视频附件的正片抽取，位置为近似取样时间。本次没有音频，也未逐段看完。' };
}

export async function readMessageAttachment(attachment, directory, { signal, download = downloadPublicMedia } = {}) {
  const combined = AbortSignal.any([AbortSignal.timeout(25_000), ...(signal ? [signal] : [])]);
  const file = path.join(directory, 'attachment.media');
  const maxBytes = (attachment.type === 'file' ? 10 : 25) * 1024 * 1024;
  for (const url of attachment.urls) {
    try {
      const bytes = (await download(url, file, { signal: combined, maxBytes, trustedDouyinAttachment: true })).bytes;
      if (!(bytes > 0 && bytes <= maxBytes)) throw Error('附件体积无效。');
      return attachment.type === 'file' ? await fileText(file, attachment, combined)
        : await videoSamples(file, directory, combined);
    } catch {
      signal?.throwIfAborted();
      if (combined.aborted) break;
      await fs.rm(file, { force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
  return null;
}
