/* NanoHive ABS — Server-wide Ratings API  v1.14.0  (nginx njs module)

   A tiny JSON API that lets every user of this server rate books (stars +
   short review, Plex-style) and see everyone else's ratings. Runs entirely
   inside the existing nginx container via the njs module — no extra service.

   Storage:  /data/nh/ratings.json  (same nh_theme_data volume as
             server-config.json, so ratings survive container recreation).

   Identity is verified SERVER-SIDE: every call replays the caller's own
   Bearer token against ABS /api/me (internal subrequest /_nh/api/whoami),
   so nobody can rate as someone else. Any authenticated ABS user may rate;
   admins may additionally remove another user's rating (moderation).

   Data shape (keys are libraryItemIds, or "series:<seriesId>" for whole-series
   ratings — same records, same rules, just a prefixed key):
     { "v": 1, "items": { "<libraryItemId>": {
         "<userId>": { "user": "<username>", "stars": 4.5,
                       "review": "…", "ts": 1753167600000 }
     } } }

   Endpoints (wired up in default.conf.template):
     GET  /_nh/api/ratings            -> whole store (family scale, tiny)
     GET  /_nh/api/ratings?item=<id>  -> just that item's ratings
     POST /_nh/api/ratings            -> { itemId, stars, review }
                                         stars 0/absent removes the rating;
                                         admins may pass forUser to remove
                                         someone else's.
     POST /_nh/api/ratings            -> { items: [ { itemId, stars, review } ] }
                                         bulk form (rating import), max 500 rows,
                                         ONE store rewrite, caller's own id only —
                                         forUser is not honoured in this form.

   Stars are 0.25-5 in QUARTER steps (v1.13.0; halves and wholes are a subset).
   The location caps the body at 64k, so a bulk caller must chunk to fit — njs
   cannot read a body that nginx spooled to a temp file.

   Known limit: the read-modify-write is not locked across nginx workers.
   At family scale simultaneous rating writes are vanishingly rare, and the
   write itself is atomic (tmp file + rename) so the store can never be torn
   — worst case one of two same-instant writes wins. */

import fs from 'fs';

const DATA = '/data/nh/ratings.json';

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA));
    if (parsed && typeof parsed === 'object' && parsed.items && typeof parsed.items === 'object') {
      return parsed;
    }
  } catch (e) {}
  return { v: 1, items: {} };
}

function writeStore(store) {
  const tmp = DATA + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, DATA);
}

function send(r, status, obj) {
  r.headersOut['Content-Type'] = 'application/json';
  r.headersOut['Cache-Control'] = 'no-store';
  // Every response here echoes text somebody typed (review bodies, report notes,
  // usernames). It is JSON and it is never rendered as a document, but saying so
  // costs one header and takes content-type guessing off the table entirely.
  r.headersOut['X-Content-Type-Options'] = 'nosniff';
  r.return(status, JSON.stringify(obj));
}

/* Identity comes from the caller's own JWT payload. The token was ALREADY
   validated by ABS itself before this handler runs — nginx auth_request replays
   it against /api/me and rejects the request otherwise — so decoding without
   signature verification is safe: we merely read back what ABS put into the
   token it just accepted (userId, username, type).
   NO njs subrequests here, deliberately: njs buffers subrequest responses in
   memory sized from Content-Length, and /api/me announces the caller's entire
   media progress (~90KB for an active listener) even for HEAD — which overflowed
   the buffer and killed requests with an empty reply. auth_request discards the
   body at any size instead. */
function whoami(r) {
  try {
    const auth = r.headersIn.Authorization || '';
    const m = /^Bearer\s+[^.]+\.([^.]+)\.[^.]+$/.exec(auth);
    if (!m) return null;
    let b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const p = JSON.parse(Buffer.from(b64, 'base64').toString());
    if (!p || !(p.userId || p.sub)) return null;
    return {
      id: String(p.userId || p.sub),
      name: String(p.username || 'user'),
      admin: p.type === 'root' || p.type === 'admin'
    };
  } catch (e) {
    return null;
  }
}

function handleGet(r) {
  const store = readStore();
  const item = r.args && r.args.item;
  if (item) {
    const out = {};
    out[item] = store.items[item] || {};
    return send(r, 200, { v: 1, items: out });
  }
  send(r, 200, store);
}

/* QUARTER steps, not half. v2.0.1 added a "star rating steps" setting with a
   quarter-star option, but this check still demanded halves — so every quarter
   rating the UI could produce (4.25, 3.75) was answered with a 400 and silently
   failed to save. Quarter is now the finest the store accepts, which is also what
   StoryGraph exports, so an imported 3.75 keeps its value. Halves and wholes are
   a subset, so nothing that used to be accepted is rejected now. */
function validStars(v) {
  return v >= 0.25 && v <= 5 && Math.round(v * 4) === v * 4;
}

function cleanReview(v) {
  const s = typeof v === 'string' ? v : '';
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, 1500);
}

const ITEM_ID_RE = /^(?:series:)?[A-Za-z0-9_-]{4,64}$/;

/* Bulk write, one file rewrite for the whole lot (importing a StoryGraph or
   Goodreads export is ~100 ratings; as single POSTs that is 100 read-modify-write
   cycles over the same file, each one a chance to lose a concurrent write).
   Rows are written ONLY under the caller's own verified id — there is deliberately
   no forUser here, so a bulk call can never touch anyone else's ratings. */
const BATCH_MAX = 500;

function handleBatch(r, user, rows) {
  if (!rows.length) return send(r, 400, { error: 'empty items' });
  if (rows.length > BATCH_MAX) return send(r, 400, { error: 'too many items (max ' + BATCH_MAX + ')' });

  const store = readStore();
  let saved = 0, removed = 0;
  const bad = [];
  const out = {};

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== 'object') { bad.push(i); continue; }
    const itemId = String(row.itemId || '');
    if (!ITEM_ID_RE.test(itemId)) { bad.push(i); continue; }
    const stars = Number(row.stars);
    const drop = !stars;
    if (!drop && !validStars(stars)) { bad.push(i); continue; }

    const item = store.items[itemId] || {};
    if (drop) {
      if (item[user.id]) removed++;
      delete item[user.id];
    } else {
      item[user.id] = { user: user.name, stars: stars, review: cleanReview(row.review), ts: Date.now() };
      saved++;
    }
    if (Object.keys(item).length) store.items[itemId] = item;
    else delete store.items[itemId];
    out[itemId] = store.items[itemId] || {};
  }

  if (saved || removed) {
    try {
      writeStore(store);
    } catch (e) {
      return send(r, 500, { error: 'write failed' });
    }
  }
  send(r, 200, { ok: true, saved: saved, removed: removed, rejected: bad.length, badRows: bad.slice(0, 20), items: out });
}

async function handlePost(r, user) {
  let body = null;
  try { body = JSON.parse(r.requestText); } catch (e) {}
  if (!body || typeof body !== 'object') return send(r, 400, { error: 'invalid JSON body' });

  if (Array.isArray(body.items)) return handleBatch(r, user, body.items);

  const itemId = String(body.itemId || '');
  if (!ITEM_ID_RE.test(itemId)) return send(r, 400, { error: 'invalid itemId' });

  // Admins may target someone else's rating (delete only, in practice);
  // everyone else can only ever write under their own verified id.
  // Admin-ness comes from NGINX, not the token: newer ABS JWTs carry no `type`
  // claim, so the payload check below is true for nobody and moderation failed
  // with a silent 403 for every admin. /_nh/api/ratings-admin is gated by
  // auth_request /_nh/admincheck and sets $nh_ratings_admin=1, which a client
  // cannot forge. The payload check stays as a fallback for legacy tokens.
  let targetId = user.id;
  if (body.forUser && String(body.forUser) !== user.id) {
    const isAdmin = (r.variables.nh_ratings_admin === '1') || user.admin;
    if (!isAdmin) return send(r, 403, { error: 'admin only' });
    targetId = String(body.forUser);
  }

  const stars = Number(body.stars);
  const remove = !stars;
  if (!remove && !validStars(stars)) {
    return send(r, 400, { error: 'stars must be 0.25-5 in quarter steps (0 removes)' });
  }

  const review = cleanReview(body.review);

  const store = readStore();
  const item = store.items[itemId] || {};
  if (remove) {
    delete item[targetId];
  } else {
    item[targetId] = { user: user.name, stars: stars, review: review, ts: Date.now() };
  }
  if (Object.keys(item).length) store.items[itemId] = item;
  else delete store.items[itemId];

  try {
    writeStore(store);
  } catch (e) {
    return send(r, 500, { error: 'write failed' });
  }
  const out = {};
  out[itemId] = store.items[itemId] || {};
  send(r, 200, { ok: true, items: out });
}

async function handle(r) {
  const user = whoami(r);
  if (!user) return send(r, 401, { error: 'not authenticated' });

  if (r.method === 'GET') return handleGet(r);
  if (r.method === 'POST') return await handlePost(r, user);
  r.headersOut['Allow'] = 'GET, POST';
  send(r, 405, { error: 'method not allowed' });
}

/* Custom series metadata discovery (A1+): admin uploads land in
   /data/nh/series-covers/<id>.<ext> (images) and /data/nh/series-desc/<id>.txt
   (description overrides), both via the admin DAV path. This lists the folders
   ONCE per request so the client knows what exists without per-card probing.
   Same auth_request gate as ratings — any authenticated user may read.
   Also lists /data/nh/user-avatars (profile photos, written by avatar() below)
   so the ranking renders photos without per-user 404 probing. */
function meta(r) {
  const user = whoami(r);
  if (!user) return send(r, 401, { error: 'not authenticated' });
  if (r.method !== 'GET') {
    r.headersOut['Allow'] = 'GET';
    return send(r, 405, { error: 'method not allowed' });
  }
  const covers = {}, descs = {}, avatars = {};
  try {
    fs.readdirSync('/data/nh/series-covers').forEach(function (f) {
      const m = /^([A-Za-z0-9_-]{4,64})\.(png|jpe?g|webp|gif|avif)$/.exec(f);
      if (m) covers[m[1]] = m[2];
    });
  } catch (e) {} // folder absent until the first upload — empty map is correct
  try {
    fs.readdirSync('/data/nh/series-desc').forEach(function (f) {
      const m = /^([A-Za-z0-9_-]{4,64})\.txt$/.exec(f);
      if (m) descs[m[1]] = 1;
    });
  } catch (e) {}
  try {
    fs.readdirSync('/data/nh/user-avatars').forEach(function (f) {
      const m = /^([A-Za-z0-9_-]{4,64})\.(png|jpe?g|webp|gif)$/.exec(f);
      if (m) avatars[m[1]] = m[2];
    });
  } catch (e) {}
  send(r, 200, { v: 1, covers: covers, descs: descs, avatars: avatars });
}

/* Profile photos (user avatars). POST = raw image bytes in the body (type
   sniffed from magic bytes, not trusted headers); DELETE removes. Identity from
   the caller's JWT — everyone manages their OWN photo; admins may pass
   ?forUser=<id> to set/remove someone else's (same moderation pattern as
   ratings). Files: /data/nh/user-avatars/<userId>.<ext>, served by a public
   regex location like series covers. The nginx location must buffer the body
   in memory (client_body_buffer_size >= client_max_body_size) so
   r.requestBuffer is populated. */
const AVATAR_DIR = '/data/nh/user-avatars';
const AVATAR_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif'];

function avatar(r) {
  const user = whoami(r);
  if (!user) return send(r, 401, { error: 'not authenticated' });

  // Admin-ness: newer ABS JWTs carry NO `type` claim (just userId/username/iat),
  // so the payload alone can't prove admin. The /_nh/api/avatar-admin location
  // is gated by auth_request /_nh/admincheck (an admin-only ABS endpoint) and
  // sets $nh_avatar_admin=1 — nginx-verified, not client-claimable. The old
  // payload check stays as a fallback for legacy tokens.
  const isAdmin = (r.variables.nh_avatar_admin === '1') || user.admin;

  let targetId = user.id;
  const forUser = r.args && r.args.forUser;
  if (forUser && String(forUser) !== user.id) {
    if (!isAdmin) return send(r, 403, { error: 'admin only' });
    targetId = String(forUser);
  }
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(targetId)) return send(r, 400, { error: 'invalid user id' });

  const rmOthers = function (keep) {
    AVATAR_EXTS.forEach(function (e) {
      if (e === keep) return;
      try { fs.unlinkSync(AVATAR_DIR + '/' + targetId + '.' + e); } catch (err) {}
    });
  };

  if (r.method === 'DELETE') {
    rmOthers(null);
    return send(r, 200, { ok: true });
  }
  if (r.method !== 'POST') {
    r.headersOut['Allow'] = 'POST, DELETE';
    return send(r, 405, { error: 'method not allowed' });
  }

  const buf = r.requestBuffer;
  if (!buf || !buf.length) return send(r, 400, { error: 'empty body' });
  if (buf.length > 2 * 1024 * 1024) return send(r, 400, { error: 'too large (max 2MB)' });
  let ext = null;
  if (buf[0] === 0xFF && buf[1] === 0xD8) ext = 'jpg';
  else if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) ext = 'png';
  else if (buf.length > 11 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) ext = 'webp';
  else if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) ext = 'gif';
  if (!ext) return send(r, 400, { error: 'not a supported image (jpeg/png/webp/gif)' });

  try { fs.mkdirSync(AVATAR_DIR); } catch (e) {} // exists = fine
  rmOthers(ext);
  try {
    fs.writeFileSync(AVATAR_DIR + '/' + targetId + '.' + ext, buf);
  } catch (e) {
    return send(r, 500, { error: 'write failed' });
  }
  send(r, 200, { ok: true, ext: ext });
}

/* Shared listening summaries (A5 — family leaderboard + year in review).

   Every participant's browser posts a SUMMARY of its own /api/me/listening-stats
   here; the store is then readable by any authenticated user, which is what makes
   a family board possible without handing out admin rights. Sharing is ON by
   default, and a DELETE erases everything the caller shared.

   A DELETE leaves a TOMBSTONE ({ out: 1 }) rather than removing the key. The
   listening data really is gone — the promise in the settings panel holds — but
   the board needs to tell "opted out" apart from "has not posted yet", and only
   the absence-vs-tombstone distinction can do that. Without it the ADMIN board
   (which ranks the real user roster, not this store) has no way to know who
   asked to be left out, and every user who simply had not opened the app since
   the feature shipped would vanish from it.

   Store: /data/nh/stats.json
     { "v": 1, "users": { "<userId>": {
         "user": "<username>", "total": <seconds>, "ts": <ms>,
         "days": { "YYYY-MM-DD": <seconds> },      // trimmed by the client, capped here
         "books": [ { "t": "<title>", "s": <seconds> } ]   // top few, for the board
       } | { "out": 1, "ts": <ms> } } }

   Only the caller's OWN record can be written: the id comes from the verified
   JWT, never from the body. Everything is bounded (day keys, book rows, string
   lengths) so one client cannot inflate the file. */
const STATS = '/data/nh/stats.json';
const STATS_MAX_DAYS = 420;
const STATS_MAX_BOOKS = 10;

function readStats() {
  try {
    const p = JSON.parse(fs.readFileSync(STATS));
    if (p && typeof p === 'object' && p.users && typeof p.users === 'object') return p;
  } catch (e) {}
  return { v: 1, users: {} };
}

function writeStats(store) {
  const tmp = STATS + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, STATS);
}

function stats(r) {
  const user = whoami(r);
  if (!user) return send(r, 401, { error: 'not authenticated' });

  if (r.method === 'GET') {
    return send(r, 200, readStats());
  }

  if (r.method === 'DELETE') {
    // Opting out drops every shared figure and leaves only the fact of the
    // opt-out, so the boards can exclude this user instead of merely missing
    // them (see the tombstone note above).
    const store = readStats();
    const prev = store.users[user.id];
    if (!prev || !prev.out) {
      store.users[user.id] = { out: 1, ts: Date.now() };
      try { writeStats(store); } catch (e) { return send(r, 500, { error: 'write failed' }); }
    }
    return send(r, 200, { ok: true });
  }

  if (r.method !== 'POST') {
    r.headersOut['Allow'] = 'GET, POST, DELETE';
    return send(r, 405, { error: 'method not allowed' });
  }

  let body;
  try { body = JSON.parse(r.requestText || '{}'); } catch (e) { return send(r, 400, { error: 'bad json' }); }
  if (!body || typeof body !== 'object') return send(r, 400, { error: 'bad body' });

  // Admin seeding (round 11): the gated twin /_nh/api/stats-admin sets
  // $nh_stats_admin and may write ANY user's summary (?forUser=<id>), so the
  // family board is complete even for people who never open the web app. The
  // target's display name comes from the body then — the caller is the admin.
  // An opt-out tombstone is never overwritten from this path: opting out means
  // out, only the user's own browser posting again brings them back.
  let targetId = user.id;
  let targetName = user.name;
  const forUser = r.args && r.args.forUser;
  if (forUser && String(forUser) !== user.id) {
    const isAdmin = (r.variables.nh_stats_admin === '1') || user.admin;
    if (!isAdmin) return send(r, 403, { error: 'admin only' });
    targetId = String(forUser);
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(targetId)) return send(r, 400, { error: 'invalid user id' });
    targetName = String(body.user == null ? '' : body.user).slice(0, 60) || '?';
  }

  const total = Number(body.total);
  if (!isFinite(total) || total < 0) return send(r, 400, { error: 'bad total' });

  const days = {};
  let nDays = 0;
  const src = (body.days && typeof body.days === 'object') ? body.days : {};
  const keys = Object.keys(src).sort().reverse(); // newest first if we have to cut
  for (let i = 0; i < keys.length && nDays < STATS_MAX_DAYS; i++) {
    const k = keys[i];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
    const v = Number(src[k]);
    if (!isFinite(v) || v <= 0) continue;
    days[k] = Math.round(v);
    nDays++;
  }

  const books = [];
  if (Array.isArray(body.books)) {
    for (let i = 0; i < body.books.length && books.length < STATS_MAX_BOOKS; i++) {
      const b = body.books[i];
      if (!b || typeof b !== 'object') continue;
      const t = String(b.t == null ? '' : b.t).slice(0, 120);
      const s = Number(b.s);
      if (!t || !isFinite(s) || s <= 0) continue;
      books.push({ t: t, s: Math.round(s) });
    }
  }

  const store = readStats();
  const cur = store.users[targetId];
  if (targetId !== user.id && cur && cur.out) {
    return send(r, 200, { ok: true, skipped: 'opted-out' });
  }
  store.users[targetId] = {
    user: String(targetName).slice(0, 60),
    total: Math.round(total),
    days: days,
    books: books,
    ts: Date.now()
  };
  try { writeStats(store); } catch (e) { return send(r, 500, { error: 'write failed' }); }
  send(r, 200, { ok: true, days: nDays });
}

/* Problem reports (users tell the admin a book is broken).

   A user POSTs { itemId, title, reason, note } from the book page; admins read
   and clear the queue. Reading and deleting are ADMIN-ONLY and that is enforced
   by nginx, not by this file: /_nh/api/reports-admin is gated by
   auth_request /_nh/admincheck and sets $nh_reports_admin=1. The token cannot be
   used to prove admin-ness (no `type` claim in current ABS JWTs), and the report
   list carries other people's names, so it must not be world-readable.

   Store: /data/nh/reports.json
     { "v": 1, "reports": [ { "id", "itemId", "title", "reason", "note",
                              "user", "userId", "ts" } ] }  (newest first) */
const REPORTS = '/data/nh/reports.json';
const REPORTS_MAX = 300;
const REPORT_REASONS = ['missing', 'quality', 'play', 'wrong', 'chapters', 'other'];

function readReports() {
  try {
    const p = JSON.parse(fs.readFileSync(REPORTS));
    if (p && typeof p === 'object' && Array.isArray(p.reports)) return p;
  } catch (e) {}
  return { v: 1, reports: [] };
}

function writeReports(store) {
  const tmp = REPORTS + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, REPORTS);
}

function reports(r) {
  const user = whoami(r);
  if (!user) return send(r, 401, { error: 'not authenticated' });
  const isAdmin = (r.variables.nh_reports_admin === '1') || user.admin;

  if (r.method === 'GET') {
    if (!isAdmin) return send(r, 403, { error: 'admin only' });
    return send(r, 200, readReports());
  }

  if (r.method === 'DELETE') { // resolve one report
    if (!isAdmin) return send(r, 403, { error: 'admin only' });
    const id = String((r.args && r.args.id) || '');
    if (!id) return send(r, 400, { error: 'missing id' });
    const store = readReports();
    const before = store.reports.length;
    store.reports = store.reports.filter(function (x) { return x.id !== id; });
    if (store.reports.length !== before) {
      try { writeReports(store); } catch (e) { return send(r, 500, { error: 'write failed' }); }
    }
    return send(r, 200, { ok: true, removed: before - store.reports.length });
  }

  if (r.method !== 'POST') {
    r.headersOut['Allow'] = 'GET, POST, DELETE';
    return send(r, 405, { error: 'method not allowed' });
  }

  let body;
  try { body = JSON.parse(r.requestText || '{}'); } catch (e) { return send(r, 400, { error: 'bad json' }); }
  if (!body || typeof body !== 'object') return send(r, 400, { error: 'bad body' });

  const itemId = String(body.itemId || '');
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(itemId)) return send(r, 400, { error: 'invalid itemId' });
  const reason = String(body.reason || '');
  if (REPORT_REASONS.indexOf(reason) < 0) return send(r, 400, { error: 'invalid reason' });
  let note = typeof body.note === 'string' ? body.note : '';
  note = note.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, 600);
  const title = String(body.title == null ? '' : body.title).slice(0, 200);

  const store = readReports();
  // One open report per user per book: re-reporting updates rather than piles up.
  store.reports = store.reports.filter(function (x) { return !(x.itemId === itemId && x.userId === user.id); });
  store.reports.unshift({
    id: user.id.slice(0, 8) + '-' + itemId.slice(0, 8) + '-' + Date.now(),
    itemId: itemId, title: title, reason: reason, note: note,
    user: user.name.slice(0, 60), userId: user.id, ts: Date.now()
  });
  if (store.reports.length > REPORTS_MAX) store.reports.length = REPORTS_MAX;
  try { writeReports(store); } catch (e) { return send(r, 500, { error: 'write failed' }); }
  send(r, 200, { ok: true });
}

/* Started-date overrides.

   ABS will NOT store a client-supplied startedAt: PATCH /api/me/progress/:id
   answers 200 and keeps its own value, and so does the batch route — it derives
   the date from listening sessions. Verified five ways. So a correction lives
   here instead, per user, and the book page shows the override when there is one.
   Nothing is written to ABS; clearing the override falls back to ABS's date.

   Store: /data/nh/dates.json
     { "v": 1, "users": { "<userId>": { "<itemId>": { "startedAt": <ms> } } } } */
const DATES = '/data/nh/dates.json';
const DATES_MAX_PER_USER = 500;

function readDates() {
  try {
    const p = JSON.parse(fs.readFileSync(DATES));
    if (p && typeof p === 'object' && p.users && typeof p.users === 'object') return p;
  } catch (e) {}
  return { v: 1, users: {} };
}

function writeDates(store) {
  const tmp = DATES + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, DATES);
}

function dates(r) {
  const user = whoami(r);
  if (!user) return send(r, 401, { error: 'not authenticated' });

  if (r.method === 'GET') {
    // Only ever your own overrides — this is per-user display state.
    const store = readDates();
    return send(r, 200, { v: 1, items: store.users[user.id] || {} });
  }

  if (r.method !== 'POST') {
    r.headersOut['Allow'] = 'GET, POST';
    return send(r, 405, { error: 'method not allowed' });
  }

  let body;
  try { body = JSON.parse(r.requestText || '{}'); } catch (e) { return send(r, 400, { error: 'bad json' }); }
  const itemId = String((body && body.itemId) || '');
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(itemId)) return send(r, 400, { error: 'invalid itemId' });

  const store = readDates();
  const mine = store.users[user.id] || (store.users[user.id] = {});
  const v = Number(body.startedAt);
  if (!body.startedAt) {
    delete mine[itemId];                       // clearing restores ABS's own date
  } else {
    if (!isFinite(v) || v <= 0) return send(r, 400, { error: 'bad startedAt' });
    if (!mine[itemId] && Object.keys(mine).length >= DATES_MAX_PER_USER) {
      return send(r, 400, { error: 'too many overrides' });
    }
    mine[itemId] = { startedAt: Math.round(v) };
  }
  try { writeDates(store); } catch (e) { return send(r, 500, { error: 'write failed' }); }
  send(r, 200, { ok: true });
}

export default { handle, meta, avatar, stats, reports, dates };
