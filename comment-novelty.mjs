export function commentFingerprint(text) {
  return String(text).normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[\p{P}\p{Z}\s\uFE0E\uFE0F]/gu, '');
}

function adjacentPairs(points) {
  return new Set(points.slice(0, -1).map((point, index) => point + points[index + 1]));
}

function matchingText(current, previous) {
  if (current && previous === current) return 'exact';
  const left = [...current], right = [...previous];
  if (left.length < 8 || right.length < 8) return null;
  const first = adjacentPairs(left), second = adjacentPairs(right);
  const overlap = [...first].filter(pair => second.has(pair)).length;
  return 2 * overlap / (first.size + second.size) >= 0.86 ? 'similar' : null;
}

export function compareCommentNovelty(text, operations, { now = Date.now(), windowMs = 86_400_000 } = {}) {
  const current = commentFingerprint(text);
  if (!current) return { accepted: false, code: 'COMMENT_NO_CONTENT' };
  for (const item of operations) {
    if (!['confirmed', 'resolved-confirmed', 'clicking', 'uncertain'].includes(item.status) || typeof item.text !== 'string') continue;
    const age = now - Date.parse(item.completedAt || item.startedAt);
    if (!Number.isFinite(age) || age < 0 || age > windowMs) continue;
    const match = matchingText(current, commentFingerprint(item.text));
    if (match) return { accepted: false, code: match === 'exact' ? 'COMMENT_REPEATED' : 'COMMENT_TOO_SIMILAR' };
  }
  return { accepted: true, code: 'COMMENT_NEW' };
}

export function publicDiscussionExcerpts(comments) {
  if (!Array.isArray(comments)) return [];
  const excerpts = new Set();
  for (const text of comments.slice(0, 24)) {
    if (typeof text !== 'string' || text.length > 512) continue;
    const normalized = text.normalize('NFKC').replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim();
    if (!normalized || /@|https?:|www\.|(?:[a-z0-9-]+\.)+(?:com|cn|net|org|io|dev|app|me|top|xyz|co|tv)\b|(?:\d[\s-]*){7,}|私信|手机号|验证码|密钥|cookie|token|api[ _-]*key/iu.test(normalized)) continue;
    excerpts.add([...normalized].slice(0, 200).join(''));
    if (excerpts.size >= 12) break;
  }
  return [...excerpts];
}

export function repeatsPublicDiscussion(text, comments) {
  const current = commentFingerprint(text);
  return publicDiscussionExcerpts(comments).some(previous => matchingText(current, commentFingerprint(previous)) !== null);
}
