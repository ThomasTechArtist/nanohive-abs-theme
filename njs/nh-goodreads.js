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
  return entry;
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
    fs.writeFileSync(DATA + '.tmp', JSON.stringify(store));
    fs.renameSync(DATA + '.tmp', DATA);
  } catch (e) { return send(r, 500, { error: 'write failed' }); }
  send(r, 200, { ok: true, count: keys.length, updatedAt: store.updatedAt });
}

export default { handle, admin };
