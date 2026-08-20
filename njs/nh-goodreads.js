/* NanoHive ABS - Goodreads community ratings store

   Separate from NanoHive user ratings.  Keys are ABS libraryItemIds:
     { "v": 1, "items": { "li_x": {
         "rating": 4.16, "ratingsCount": 34686,
         "goodreadsId": "123", "url": "https://www.goodreads.com/book/show/123"
     } } }
*/

import fs from 'fs';

const DATA = '/data/nh/goodreads-ratings.json';

function send(r, status, value) {
  r.headersOut['Content-Type'] = 'application/json';
  r.headersOut['Cache-Control'] = 'no-store';
  r.headersOut['X-Content-Type-Options'] = 'nosniff';
  r.return(status, JSON.stringify(value));
}

function readStore() {
  try {
    const value = JSON.parse(fs.readFileSync(DATA));
    if (value && value.items && typeof value.items === 'object') return value;
  } catch (e) {}
  return { v: 1, items: {} };
}

function writeStore(store) {
  fs.writeFileSync(DATA + '.tmp', JSON.stringify(store));
  fs.renameSync(DATA + '.tmp', DATA);
}

function normal(value) {
  return String(value || '').toLowerCase()
    .replace(/\([^)]*(unabridged|audiobook|audio|edition|booktrack)[^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokenScore(left, right) {
  const a = normal(left), b = normal(right);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) return 92;
  const aa = a.split(' '), bb = b.split(' ');
  let common = 0;
  aa.forEach(function (part) { if (bb.indexOf(part) !== -1) common += 1; });
  return Math.round((2 * common / (aa.length + bb.length)) * 100);
}

function titleVariants(value) {
  const original = String(value || '').trim();
  const variants = [original];
  original.split(/\s+[\-–—]\s+|:\s+/).forEach(function (part) {
    part = part.trim();
    if (part.length >= 3 && variants.indexOf(part) === -1) variants.push(part);
  });
  const withoutRank = original.replace(/^\s*#?\d+\s*[.\-–—:]\s*/, '').trim();
  if (withoutRank && variants.indexOf(withoutRank) === -1) variants.push(withoutRank);
  return variants;
}

function titleScore(left, right) {
  let best = 0;
  titleVariants(left).forEach(function (a) {
    titleVariants(right).forEach(function (b) { best = Math.max(best, tokenScore(a, b)); });
  });
  return best;
}

function selectMatch(request, matches) {
  let best = null, bestConfidence = 0;
  (matches || []).forEach(function (candidate) {
    if (candidate.goodreadsAverageRating == null || Number(candidate.goodreadsRatingsCount) < 1) return;
    const expectedIsbn = String(request.isbn || '').replace(/\D/g, '');
    const resultIsbn = String(candidate.isbn || '').replace(/\D/g, '');
    const isbnMatch = expectedIsbn && resultIsbn && expectedIsbn === resultIsbn;
    const title = titleScore(request.title, candidate.title);
    const author = tokenScore(request.author, candidate.author);
    const confidence = isbnMatch ? 100 : Math.round(title * 0.72 + author * 0.28);
    if (confidence > bestConfidence) { best = candidate; bestConfidence = confidence; }
  });
  return best ? { candidate: best, confidence: bestConfidence } : null;
}

function cleanEntry(value) {
  if (!value || typeof value !== 'object') return null;
  const rating = Number(value.rating);
  const ratingsCount = Number(value.ratingsCount);
  if (!Number.isFinite(rating) || rating < 0 || rating > 5) return null;
  if (!Number.isFinite(ratingsCount) || ratingsCount < 0 || Math.floor(ratingsCount) !== ratingsCount) return null;
  const entry = { rating: Math.round(rating * 100) / 100, ratingsCount: ratingsCount };
  if (value.goodreadsId != null) entry.goodreadsId = String(value.goodreadsId).slice(0, 80);
  if (value.url != null && /^https:\/\/www\.goodreads\.com\//.test(String(value.url))) entry.url = String(value.url).slice(0, 500);
  if (value.matchedAt != null) entry.matchedAt = String(value.matchedAt).slice(0, 40);
  if (value.metadata && typeof value.metadata === 'object') entry.metadata = cleanMetadata(value.metadata);
  if (value.confidence != null && Number.isFinite(Number(value.confidence))) entry.confidence = Math.max(0, Math.min(100, Math.round(Number(value.confidence))));
  return entry;
}

function plainText(value) {
  return String(value || '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*p\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

function strings(value, maxItems, maxLen) {
  const source = Array.isArray(value) ? value : (value == null ? [] : [value]);
  const out = [];
  source.slice(0, maxItems).forEach(function (part) {
    const text = String(part && typeof part === 'object' ? (part.name || '') : part || '').trim().slice(0, maxLen);
    if (text && out.indexOf(text) === -1) out.push(text);
  });
  return out;
}

function cleanMetadata(value) {
  const md = {};
  ['title', 'subtitle', 'publisher', 'isbn', 'asin', 'language'].forEach(function (key) {
    if (value[key] != null && String(value[key]).trim()) md[key] = String(value[key]).trim().slice(0, key === 'title' ? 500 : 300);
  });
  const year = parseInt(value.publishedYear, 10);
  if (year >= 1000 && year <= 3000) md.publishedYear = String(year);
  const desc = plainText(value.description).slice(0, 30000);
  if (desc) md.description = desc;
  const authors = strings(value.authors || value.author, 20, 200);
  if (authors.length) md.authors = authors;
  const narrators = strings(value.narrators || value.narrator, 20, 200);
  if (narrators.length) md.narrators = narrators;
  const genres = strings(value.genres, 30, 120);
  if (genres.length) md.genres = genres;
  const tags = strings(value.tags, 30, 120);
  if (tags.length) md.tags = tags;
  if (Array.isArray(value.series)) {
    md.series = value.series.slice(0, 10).map(function (series) {
      if (!series) return null;
      if (typeof series === 'string') return { name: series.slice(0, 300), sequence: null };
      const name = String(series.name || '').trim().slice(0, 300);
      return name ? { name: name, sequence: series.sequence == null ? null : String(series.sequence).slice(0, 40) } : null;
    }).filter(Boolean);
    if (!md.series.length) delete md.series;
  }
  ['explicit', 'abridged'].forEach(function (key) { if (typeof value[key] === 'boolean') md[key] = value[key]; });
  return md;
}

function handle(r) {
  if (r.method !== 'GET') {
    r.headersOut.Allow = 'GET';
    return send(r, 405, { error: 'method not allowed' });
  }
  const item = r.args && r.args.item ? String(r.args.item) : '';
  if (!item) return send(r, 400, { error: 'item is required' });
  const entry = readStore().items[item];
  if (!entry) return send(r, 404, { error: 'no Goodreads match' });
  send(r, 200, entry);
}

// One authenticated, read-only snapshot for library sorting/filtering.  The
// browser needs a single map, not thousands of per-card requests.
function list(r) {
  if (r.method !== 'GET') {
    r.headersOut.Allow = 'GET';
    return send(r, 405, { error: 'method not allowed' });
  }
  const store = readStore();
  send(r, 200, { v: store.v || 1, updatedAt: store.updatedAt || null, items: store.items || {} });
}

/* Admin-only replacement endpoint. nginx performs the admin check.  A complete
   replacement keeps imports deterministic and makes stale/deleted ABS IDs fall
   out on the next sync. */
function admin(r) {
  if (r.method === 'GET') {
    const store = readStore();
    return send(r, 200, { v: store.v || 1, count: Object.keys(store.items || {}).length, updatedAt: store.updatedAt || null });
  }
  if (r.method !== 'POST') {
    r.headersOut.Allow = 'GET, POST';
    return send(r, 405, { error: 'method not allowed' });
  }
  let body;
  try { body = JSON.parse(r.requestText || '{}'); } catch (e) { return send(r, 400, { error: 'bad json' }); }
  if (!body || !body.items || typeof body.items !== 'object' || Array.isArray(body.items)) return send(r, 400, { error: 'items object is required' });
  const keys = Object.keys(body.items);
  if (keys.length > 10000) return send(r, 413, { error: 'too many items' });
  const items = {};
  const rejected = [];
  keys.forEach(function (itemId) {
    if (!/^[A-Za-z0-9_-]{4,100}$/.test(itemId)) { rejected.push(itemId); return; }
    const entry = cleanEntry(body.items[itemId]);
    if (!entry) { rejected.push(itemId); return; }
    items[itemId] = entry;
  });
  if (rejected.length) return send(r, 400, { error: 'invalid entries', rejected: rejected.slice(0, 50), rejectedCount: rejected.length });
  const store = { v: 1, updatedAt: new Date().toISOString(), items: items };
  try {
    writeStore(store);
  } catch (e) { return send(r, 500, { error: 'write failed' }); }
  send(r, 200, { ok: true, count: keys.length, updatedAt: store.updatedAt });
}

async function resolve(r) {
  if (r.method !== 'POST') {
    r.headersOut.Allow = 'POST';
    return send(r, 405, { error: 'method not allowed' });
  }
  let request;
  try { request = JSON.parse(r.requestText || '{}'); } catch (e) { return send(r, 400, { error: 'bad json' }); }
  const item = String(request.item || '');
  const title = String(request.title || '').trim().slice(0, 500);
  const author = String(request.author || '').trim().slice(0, 300);
  if (!/^[A-Za-z0-9_-]{4,100}$/.test(item) || !title) return send(r, 400, { error: 'item and title are required' });

  const store = readStore();
  if (store.items[item] && !request.force) return send(r, 200, store.items[item]);

  let selected = null;
  const searches = titleVariants(title);
  try {
    for (let index = 0; index < searches.length; index += 1) {
      const query = encodeURIComponent(searches[index]) + (author ? '&author=' + encodeURIComponent(author) : '');
      const response = await r.subrequest('/_nh/internal/goodreads/search?query=' + query, { method: 'GET' });
      if (response.status < 200 || response.status >= 300) continue;
      const payload = JSON.parse(response.responseText || '{}');
      const attempt = selectMatch({ title: title, author: author, isbn: request.isbn }, payload.matches);
      if (attempt && (!selected || attempt.confidence > selected.confidence)) selected = attempt;
      if (selected && selected.confidence >= 95) break;
    }
  } catch (e) {
    r.error('Goodreads resolve search failed: ' + String(e));
    return send(r, 502, { error: 'Goodreads matcher unavailable' });
  }

  if (!selected || selected.confidence < 85) {
    return send(r, 404, { error: 'no confident Goodreads match', confidence: selected ? selected.confidence : 0 });
  }
  const value = selected.candidate;
  const entry = cleanEntry({
    rating: value.goodreadsAverageRating,
    ratingsCount: value.goodreadsRatingsCount,
    goodreadsId: value.goodreadsId,
    url: value.goodreadsUrl,
    matchedAt: new Date().toISOString(),
    confidence: selected.confidence,
    metadata: {
      title: value.title, subtitle: value.subtitle, author: value.author,
      publishedYear: value.publishedYear, series: value.series,
      description: value.description, genres: value.genres, tags: value.tags,
      narrator: value.narrator, isbn: value.isbn, asin: value.asin,
      publisher: value.publisher, language: value.language,
      explicit: value.explicit, abridged: value.abridged
    }
  });
  store.items[item] = entry;
  store.updatedAt = new Date().toISOString();
  try { writeStore(store); } catch (e) {
    r.error('Goodreads cache write failed for ' + item + ': ' + String(e));
    return send(r, 500, { error: 'write failed' });
  }
  send(r, 200, entry);
}

export default { handle, list, admin, resolve };
