import { decimalId, parseExactJson } from './yunsur-mcp.mjs';
import { isDouyinLiveMediaUrl } from './media/index.mjs';

const roomNumber = value => /^\d{4,30}$/.test(decimalId(value) || '') ? decimalId(value) : null;
export const liveUnavailable = message => Object.assign(Error(message), { code: 'BACKGROUND_LIVE_UNAVAILABLE' });

export function secureHlsUrl(source, base) {
  if (typeof source !== 'string' || !source || source.length > 8000) return null;
  try {
    const url = new URL(source, base);
    if (url.protocol === 'http:') url.protocol = 'https:';
    return isDouyinLiveMediaUrl(url.href) ? url.href : null;
  } catch { return null; }
}

function object(value) {
  if (typeof value === 'string' && value.length <= 1_000_000) {
    try { value = parseExactJson(value); } catch { return null; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export function liveRoomCandidate(row) {
  const room = object(row?.room) || object(row?.live_room);
  if (!room) return null;
  const link = /^https:\/\/live\.douyin\.com\/(\d{4,30})(?:[/?#]|$)/.exec(room.share_url || room.share_info?.share_url || '');
  const ids = new Set([roomNumber(room.web_rid), roomNumber(room.owner?.web_rid), link?.[1]].filter(Boolean));
  if (ids.size !== 1) return null;
  const [webRid] = ids;
  return { kind: 'live-room', id: webRid, webRid, title: String(room.title || '').slice(0, 1000) };
}

export function resolveLiveRoom(entry, info, entered) {
  const roomId = roomNumber(info?.room_id);
  if (!roomId || info.room_status != null && ![2, '2'].includes(info.room_status)) throw liveUnavailable('该直播间没有确认正在开播。');
  const rooms = entered?.data?.data;
  const matches = entered?.status_code === 0 && Array.isArray(rooms)
    ? rooms.filter(room => roomNumber(room?.id_str ?? room?.id) === roomId)
    : [];
  const [room] = matches;
  if (matches.length !== 1 || room.web_rid != null && roomNumber(room.web_rid) !== entry.webRid ||
      ![2, '2'].includes(room.status ?? info.room_status)) throw liveUnavailable('进入直播间后没有读回同一间正在直播的房间。');

  const stream = room.stream_url ?? {};
  const qualities = object(object(stream.live_core_sdk_data?.pull_data?.stream_data)?.data);
  const flv = object(stream.flv_pull_url);
  const qualityRoutes = Object.values(qualities || {}).slice(0, 12).flatMap(item => [item?.main, item?.backup]);
  const flvUrls = [flv?.SD, flv?.LD, ...qualityRoutes.map(route => route?.flv),
    ...Object.values(flv || {}).slice(0, 12), typeof stream.flv_pull_url === 'string' ? stream.flv_pull_url : null];
  const hlsMaps = [object(stream.hls_pull_url_map), object(stream.hls_pull_url)].filter(Boolean);
  const hlsCandidates = [...hlsMaps.flatMap(map => [map.SD, map.LD]), ...qualityRoutes.map(route => route?.hls),
    ...hlsMaps.flatMap(map => Object.values(map).slice(0, 12)), stream.hls_pull_url];
  const streamUrls = [...new Set(flvUrls.map(source => secureHlsUrl(source)).filter(Boolean))].slice(0, 3);
  const hlsUrls = [...new Set(hlsCandidates.map(source => secureHlsUrl(source)).filter(Boolean))].slice(0, 3);
  if (!streamUrls.length && !hlsUrls.length) throw liveUnavailable('该直播间没有可用的 FLV 或 HLS 画面流。');
  return { ...entry, id: roomId, title: String(room.title || info.room_title || entry.title).slice(0, 1000), streamUrls, hlsUrls };
}
