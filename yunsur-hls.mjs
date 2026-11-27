import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openDouyinLiveResource } from './media/index.mjs';
import { liveUnavailable, secureHlsUrl } from './yunsur-live.mjs';

const PLAYLIST_LIMIT = 256 * 1024;
const SAMPLE_LIMIT = 32 * 1024 * 1024;
const SEGMENT_LIMIT = 16;

function streamUrl(uri, base) {
  const url = secureHlsUrl(uri, base);
  if (!url) throw liveUnavailable('HLS 资源未通过抖音媒体地址核对。');
  return url;
}

function byteRange(value, continueAt) {
  const match = /^(\d{1,16})(?:@(\d{1,16}))?$/.exec(value);
  const length = Number(match?.[1]);
  const start = match?.[2] === undefined ? continueAt : Number(match[2]);
  const end = start + length - 1;
  if (!Number.isSafeInteger(length) || length < 1 || length > SAMPLE_LIMIT
    || !Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(end)) {
    throw liveUnavailable('HLS 分片的字节范围无法核对。');
  }
  return { start, end };
}

async function consume(response, limit, signal, receive) {
  try {
    if (!response?.ok || !response.body || Number(response.headers.get('content-length')) > limit) {
      throw liveUnavailable('未取得可用的 HLS 数据。');
    }
    let bytes = 0;
    for await (const chunk of response.body) {
      signal?.throwIfAborted();
      bytes += chunk.length;
      if (bytes > limit) throw liveUnavailable('HLS 数据超过本段采样体积。');
      await receive(chunk);
    }
    if (!bytes) throw liveUnavailable('HLS 资源为空。');
    return bytes;
  } finally {
    await response?.body?.cancel().catch(() => {});
  }
}

async function loadPlaylist(url, openResource, signal) {
  const { response, url: base } = await openResource(streamUrl(url), { signal });
  const chunks = [];
  await consume(response, PLAYLIST_LIMIT, signal, chunk => { chunks.push(chunk); });
  const lines = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).split(/\r?\n/).map(line => line.trim());
  if (lines[0] !== '#EXTM3U' || lines.length > 8192) throw liveUnavailable('HLS 播放列表格式无效。');
  return { lines, base: streamUrl(base) };
}

function variantsOf({ lines }) {
  const variants = [];
  let master = false;
  for (const [index, line] of lines.entries()) {
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    master = true;
    const uri = lines[index + 1];
    if (!uri || uri.startsWith('#')) continue;
    const attrs = line.slice('#EXT-X-STREAM-INF:'.length);
    const codecs = /(?:^|,)CODECS="([^"]+)"/.exec(attrs)?.[1].split(',');
    if (codecs?.every(codec => /^(?:mp4a|ac-3|ec-3|opus|flac|alac)(?:\.|$)/i.test(codec.trim()))) continue;
    const bandwidth = Number(/(?:^|,)BANDWIDTH=(\d+)(?=,|$)/.exec(attrs)?.[1]);
    variants.push({ uri, bandwidth: bandwidth || Infinity });
  }
  return master ? variants.sort((a, b) => a.bandwidth - b.bandwidth).slice(0, 4) : null;
}

function parseMedia({ lines, base }) {
  let sequence = 0, duration, init, pendingRange, discontinuity = false, target = 3, ended = false;
  const segments = [];
  for (const line of lines.slice(1)) {
    if (!line) continue;
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      const value = line.slice('#EXT-X-MEDIA-SEQUENCE:'.length);
      if (segments.length || !/^\d{1,15}$/.test(value)) throw liveUnavailable('HLS 分片序号无效。');
      sequence = Number(value);
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      target = Number(line.slice('#EXT-X-TARGETDURATION:'.length));
      if (!Number.isSafeInteger(target) || target < 1 || target > 120) throw liveUnavailable('HLS 分片目标时长无效。');
    } else if (line.startsWith('#EXTINF:')) {
      duration = Number(/^#EXTINF:(\d+(?:\.\d+)?),/.exec(line)?.[1]);
      if (!(duration > 0 && duration <= 120)) throw liveUnavailable('HLS 分片时长无效。');
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = line.slice('#EXT-X-MAP:'.length);
      const uri = /(?:^|,)URI="([^"]+)"(?=,|$)/.exec(attrs)?.[1];
      if (!uri) throw liveUnavailable('HLS 初始化分片缺少地址。');
      const value = /(?:^|,)BYTERANGE="([^"]*)"(?=,|$)/.exec(attrs)?.[1];
      if (value === undefined && /(?:^|,)BYTERANGE=/.test(attrs)) throw liveUnavailable('HLS 初始化分片范围格式无效。');
      init = { url: streamUrl(uri, base), range: value === undefined ? undefined : byteRange(value) };
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      if (pendingRange !== undefined) throw liveUnavailable('HLS 分片有重复的字节范围。');
      pendingRange = line.slice('#EXT-X-BYTERANGE:'.length);
    } else if (line.startsWith('#EXT-X-KEY:') && line !== '#EXT-X-KEY:METHOD=NONE') {
      throw liveUnavailable('当前 HLS 流使用了尚未支持的加密。');
    } else if (line === '#EXT-X-DISCONTINUITY') {
      discontinuity = true;
    } else if (line === '#EXT-X-ENDLIST') {
      ended = true;
    } else if (!line.startsWith('#')) {
      if (!duration) throw liveUnavailable('HLS 分片缺少时长。');
      const url = streamUrl(line, base);
      const previous = segments.at(-1);
      const continueAt = previous?.url === url && previous.range ? previous.range.end + 1 : undefined;
      const range = pendingRange === undefined ? undefined : byteRange(pendingRange, continueAt);
      segments.push({ url, range, sequence: sequence + segments.length, duration, init, discontinuity });
      duration = undefined;
      pendingRange = undefined;
      discontinuity = false;
    }
  }
  if (pendingRange !== undefined) throw liveUnavailable('HLS 字节范围没有对应的分片。');
  return { segments, target, ended };
}

async function selectMedia(source, openResource, signal) {
  const playlist = await loadPlaylist(source, openResource, signal);
  const variants = variantsOf(playlist);
  if (variants === null) return { source, playlist };
  for (const { uri } of variants) {
    try {
      const variant = streamUrl(uri, playlist.base);
      const candidate = await loadPlaylist(variant, openResource, signal);
      if (variantsOf(candidate) === null && parseMedia(candidate).segments.length) return { source: variant, playlist: candidate };
    } catch { signal?.throwIfAborted(); }
  }
  throw liveUnavailable('HLS 清晰度列表没有可读取的分片。');
}

function selectSegments(segments, after, seconds) {
  const candidates = after === undefined ? segments.slice(-SEGMENT_LIMIT).reverse()
    : segments.filter(segment => segment.sequence > after).slice(0, SEGMENT_LIMIT);
  const selected = [];
  let duration = 0;
  for (const segment of candidates) {
    selected.push(segment);
    duration += segment.duration;
    if (duration >= seconds) break;
  }
  return { selected: after === undefined ? selected.reverse() : selected, duration };
}

export async function stageHlsSample(source, { directory, seconds, cursor, signal, openResource = openDouyinLiveResource } = {}) {
  const media = await selectMedia(source, openResource, signal);
  const address = new URL(media.source);
  const playlistId = address.origin + address.pathname;
  const after = cursor?.playlistId === playlistId ? cursor.sequence : undefined;
  let playlist = media.playlist, snapshot;
  for (let attempt = 0; attempt < 4; attempt++) {
    const parsed = parseMedia(playlist);
    snapshot = selectSegments(parsed.segments, after, seconds);
    if (snapshot.duration >= seconds || parsed.ended || attempt === 3) break;
    await delay(Math.min(2000, parsed.target * 500), undefined, { signal });
    playlist = await loadPlaylist(media.source, openResource, signal);
  }
  const segments = snapshot.selected;
  if (!segments.length) throw liveUnavailable('HLS 还没有新的完整分片。');

  let remaining = SAMPLE_LIMIT;
  const save = async ({ url, range }, name) => {
    const length = range ? range.end - range.start + 1 : null;
    if (length > remaining) throw liveUnavailable('HLS 数据超过本段采样体积。');
    const { response } = await openResource(url, range ? { signal, range } : { signal });
    try {
      if (range) {
        const returned = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(response?.headers.get('content-range') ?? '');
        if (response?.status !== 206 || !returned || Number(returned[1]) !== range.start || Number(returned[2]) !== range.end
          || (returned[3] !== '*' && !(Number(returned[3]) > range.end))) {
          throw liveUnavailable('直播服务器返回的分片范围与清单不一致。');
        }
      }
      const file = await fs.open(path.join(directory, name), 'wx', 0o600);
      try {
        const bytes = await consume(response, length ?? remaining, signal, chunk => file.writeFile(chunk));
        if (range && bytes !== length) throw liveUnavailable('直播服务器返回的分片字节不完整。');
        remaining -= bytes;
      }
      finally { await file.close(); }
    } finally { await response?.body?.cancel().catch(() => {}); }
  };
  const target = Math.ceil(Math.max(...segments.map(segment => segment.duration)));
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-PLAYLIST-TYPE:VOD', `#EXT-X-TARGETDURATION:${target}`,
    `#EXT-X-MEDIA-SEQUENCE:${segments[0].sequence}`];
  const maps = new Map();
  let currentInit;
  for (const [index, segment] of segments.entries()) {
    signal?.throwIfAborted();
    if (segment.discontinuity && index > 0) lines.push('#EXT-X-DISCONTINUITY');
    const initKey = segment.init && JSON.stringify([segment.init.url, segment.init.range]);
    if (initKey && initKey !== currentInit) {
      if (!maps.has(initKey)) {
        const name = `init-${maps.size}.mp4`;
        await save(segment.init, name);
        maps.set(initKey, name);
      }
      currentInit = initKey;
      lines.push(`#EXT-X-MAP:URI="${maps.get(currentInit)}"`);
    }
    const file = `segment-${index}.${segment.init ? 'm4s' : 'ts'}`;
    await save(segment, file);
    lines.push(`#EXTINF:${segment.duration},`, file);
  }
  const file = path.join(directory, 'sample.m3u8');
  await fs.writeFile(file, [...lines, '#EXT-X-ENDLIST', ''].join('\n'), { mode: 0o600 });
  return { file, cursor: { playlistId, sequence: segments.at(-1).sequence } };
}
