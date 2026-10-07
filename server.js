// Ten Rooms: accounts, lobby and signaling server. Video/audio go browser-to-browser (WebRTC); this handles logins, rooms, handshakes, chat and posts.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000, REACTS = ['👍', '😂', '🎉', '👏', '🔥', '💜'];
// [name, max people]. Small rooms keep full video; bigger rooms get lower per-person video quality (see tune() in index.html).
const ROOMS = [['Lounge', 6], ['Studio', 6], ['Kitchen', 6], ['Garage', 10], ['Rooftop', 10], ['Library', 15], ['Arcade', 15], ['Workshop', 15], ['Garden', 50], ['Porch', 50]];
// GIFs come from the Klipy catalog. Set KLIPY_KEY (Render: Environment) to turn GIF search on; without it the GIF button is hidden.
// The key stays on the server: browsers ask /gifs and the server asks Klipy. Only links on Klipy's own domain can be sent in chat.
const KLIPY = process.env.KLIPY_KEY || '', GIFURL = /^https:\/\/([a-z0-9-]+\.)*klipy\.(com|co)\/[\w\-./%~]+$/i, gifCache = new Map();
async function gifs(q) { // search results, or what is trending when q is empty; answers are reused for 5 minutes
  const key = q.toLowerCase(), hit = gifCache.get(key);
  if (hit && Date.now() - hit.t < 300000) return hit.list;
  const r = await fetch(`https://api.klipy.com/api/v1/${KLIPY}/gifs/${q ? 'search' : 'trending'}?per_page=24&customer_id=tenrooms&content_filter=high` + (q ? '&q=' + encodeURIComponent(q) : ''), { signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error('Klipy answered ' + r.status);
  const j = await r.json();
  const list = ((j.data && j.data.data) || []).map(g => { // each GIF comes in sizes (hd, md, sm, xs) and formats; webp is the lightest that still animates
    const f = g.file || {}, pick = s => f[s] && (f[s].webp || f[s].gif);
    const big = pick('md') || pick('sm') || pick('hd'), small = pick('xs') || pick('sm') || big;
    return big && small && GIFURL.test(big.url) && GIFURL.test(small.url) ? { url: big.url, thumb: small.url, title: String(g.title || '').slice(0, 60) } : null;
  }).filter(Boolean);
  if (gifCache.size > 300) gifCache.clear();
  gifCache.set(key, { t: Date.now(), list });
  return list;
}
const ICE = (() => { try { return JSON.parse(process.env.ICE_SERVERS); } catch { return [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }]; } })();

// Images people send in chat. Set OPENAI_API_KEY (Render: Environment) to turn this on; without it the image button is hidden.
// Every image is checked by OpenAI's moderation model before anyone sees it, and one that cannot be checked is refused.
// Images are kept in memory only (room chat is not saved either), and the oldest are dropped past 150 images or 40 MB.
const OPENAI = process.env.OPENAI_API_KEY || '', pics = new Map(), picWait = new Map(); let picBytes = 0; // pics: id -> { buf, by, used }
async function imageOk(dataUrl) {
  const r = await fetch('https://api.openai.com/v1/moderations', { method: 'POST', signal: AbortSignal.timeout(15000), headers: { Authorization: 'Bearer ' + OPENAI, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'omni-moderation-latest', input: [{ type: 'image_url', image_url: { url: dataUrl } }] }) });
  if (!r.ok) throw new Error('OpenAI answered ' + r.status);
  const res = (await r.json()).results; if (!res || !res[0]) throw new Error('OpenAI sent no result');
  return !res[0].flagged;
}
function upload(req, res) { // POST /upload: the JPEG bytes, with the login token in the Authorization header
  const out = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const a = accounts.get(tokens.get(sha(String(req.headers.authorization || '').replace(/^Bearer /, '')))), now = Date.now();
  if (!OPENAI) return out(404, { error: 'Image sending is off' });
  if (!a) return out(401, { error: 'Log in again to send images' });
  if (now - (picWait.get(a.username) || 0) < 5000) return out(429, { error: 'Wait a few seconds between images' });
  if (picWait.size > 5000) picWait.clear(); picWait.set(a.username, now);
  const chunks = []; let size = 0, dead = false;
  req.on('data', c => { if (dead) return; size += c.length; if (size > 400000) { dead = true; out(413, { error: 'That image is too big' }); req.destroy(); } else chunks.push(c); });
  req.on('end', async () => {
    if (dead) return; const buf = Buffer.concat(chunks);
    if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return out(400, { error: 'That is not a usable image' }); // must start like a JPEG
    try {
      if (!await imageOk('data:image/jpeg;base64,' + buf.toString('base64'))) { console.warn('image refused by moderation, sent by @' + a.username); return out(422, { error: 'That image is not allowed here' }); }
    } catch (e) { console.warn('image check failed:', e.message); return out(502, { error: 'The image could not be checked. Try again' }); }
    const id = crypto.randomBytes(12).toString('hex'); pics.set(id, { buf, by: a.username, used: false }); picBytes += buf.length;
    for (const [k, p] of pics) { if (pics.size <= 150 && picBytes <= 40e6) break; pics.delete(k); picBytes -= p.buf.length; }
    out(200, { id });
  });
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  const av = /^\/av\/([a-z0-9_]{3,16})(\?|$)/.exec(req.url); // someone's profile picture; the ?v= number changes whenever they change it, so browsers can keep it forever
  if (av) {
    const a = accounts.get(av[1]), d = a && a.av; if (!d) { res.writeHead(404); return res.end('No picture'); }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' }); return res.end(Buffer.from(d.slice(d.indexOf(',') + 1), 'base64'));
  }
  if (req.method === 'POST' && req.url === '/upload') return upload(req, res);
  const pic = /^\/img\/([a-f0-9]{24})$/.exec(req.url);
  if (pic) {
    const p = pics.get(pic[1]); if (!p) { res.writeHead(404); return res.end('That image has expired'); }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' }); return res.end(p.buf);
  }
  if (req.url === '/gifs' || req.url.startsWith('/gifs?')) {
    if (!KLIPY) { res.writeHead(404); return res.end('GIF search is off'); }
    const q = String(new URL(req.url, 'http://x').searchParams.get('q') || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 50);
    return gifs(q).then(
      list => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(list)); },
      e => { console.warn('gif search failed:', e.message); res.writeHead(502, { 'Content-Type': 'application/json' }); res.end('[]'); });
  }
  if (req.url === '/' || req.url.startsWith('/?')) {
    return fs.readFile(path.join(__dirname, 'index.html'), (e, d) => {
      res.writeHead(e ? 500 : 200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(e ? 'index.html missing' : d);
    });
  }
  res.writeHead(404); res.end('Not found');
});

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
const rooms = ROOMS.map(([name, max], i) => ({ id: i + 1, name, max, topic: '', board: [], members: new Map(), chat: [], bans: new Map(), vote: null }));
let nextId = 1, msgSeq = 0;
const send = (ws, m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
const toRoom = (r, m, except) => r.members.forEach((p, id) => id !== except && send(p, m));
const lobby = () => rooms.map(r => ({ id: r.id, name: r.name, topic: r.topic, max: r.max, users: [...r.members.values()].map(p => p.name) }));
const pushLobby = () => { const l = lobby(), st = stats(); wss.clients.forEach(c => { if (c.name) { send(c, { type: 'lobby', rooms: l, stats: st }); presence(c); } }); };

// Saved data. With SUPABASE_URL and SUPABASE_SECRET_KEY set (Render: Environment) it lives in Supabase and survives deploys and restarts:
// the table app_state holds one JSON document (posts, global poll, visitor counts) and the table accounts holds one row per account.
// Without them it falls back to local files, which Render wipes on every deploy.
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, ''), SB_KEY = process.env.SUPABASE_SECRET_KEY || '', useSB = !!(SB_URL && SB_KEY);
const DATA = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'tenrooms.json'), ACC = path.join(path.dirname(DATA), 'accounts.json');
const ADMINS = new Set((process.env.ADMIN_USERS || 'diddydespacito').split(',').map(s => s.trim().toLowerCase().replace(/^@/, '')).filter(Boolean)); // usernames that can moderate: delete posts and accounts, reset names, run the global poll
const store = { posts: [], gpoll: null, ever: [], today: [], day: '', seq: 0, blocked: { users: [], devices: [] } }; // blocked.devices: [{ id, user }]
const ever = new Set(), today = new Set(); // usernames seen ever, and seen on store.day
const accounts = new Map(), tokens = new Map(); // username -> account; hash of a login token -> username
const dirty = new Set(), gone = new Set(); // accounts waiting to be written, and deleted ones waiting to be removed
function adopt(d) { // take loaded data as the current state
  if (!d || typeof d !== 'object') return;
  Object.assign(store, d); if (!Array.isArray(store.posts)) store.posts = [];
  if (!store.blocked || !Array.isArray(store.blocked.users) || !Array.isArray(store.blocked.devices)) store.blocked = { users: [], devices: [] };
  ever.clear(); (store.ever || []).forEach(c => ever.add(c)); today.clear(); (store.today || []).forEach(c => today.add(c));
}
function adoptAccounts(list) {
  (Array.isArray(list) ? list : []).forEach(a => {
    if (!a || typeof a.username !== 'string' || typeof a.hash !== 'string') return;
    ['friends', 'sessions', 'devices'].forEach(k => { if (!Array.isArray(a[k])) a[k] = []; });
    a.display = String(a.display || a.username); a.bio = String(a.bio || '');
    accounts.set(a.username, a); a.sessions.forEach(h => tokens.set(h, a.username));
  });
}
const sb = (table, query, opts = {}) => fetch(SB_URL + '/rest/v1/' + table + query, { ...opts, signal: AbortSignal.timeout(8000), headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', ...opts.headers } })
  .then(r => { if (!r.ok) throw new Error('Supabase answered ' + r.status + ' for ' + table); return r; });
const UPSERT = { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } };
const writeFile = (file, data) => new Promise(done => fs.mkdir(path.dirname(file), { recursive: true }, () => fs.writeFile(file + '.tmp', JSON.stringify(data), e => { // temp file first so a crash cannot leave half a file
  if (e) { console.warn('save failed:', e.message); done(); } else fs.rename(file + '.tmp', file, () => done());
})));
async function loadStore() { // runs once, before the server starts taking visitors
  if (!useSB) {
    try { adopt(JSON.parse(fs.readFileSync(DATA, 'utf8'))); } catch {}
    try { adoptAccounts(JSON.parse(fs.readFileSync(ACC, 'utf8'))); } catch {}
    return;
  }
  for (let n = 0; n < 8; n++) {
    try {
      const rows = await (await sb('app_state', '?key=eq.tenrooms&select=data')).json(), all = [];
      for (let from = 0; ; from += 1000) { // Supabase hands back at most 1000 rows at a time
        const page = await (await sb('accounts', '?select=data&order=username&limit=1000&offset=' + from)).json();
        all.push(...page.map(r => r.data)); if (page.length < 1000) break;
      }
      if (rows[0]) adopt(rows[0].data); adoptAccounts(all);
      return console.log('Saved data loaded from Supabase: ' + accounts.size + ' accounts');
    } catch (e) { console.warn('Supabase load failed:', e.message); await new Promise(done => setTimeout(done, 2000)); }
  }
  console.error('Could not load from Supabase. Stopping, so empty data is never written over the real accounts.'); process.exit(1);
}
let saveTimer = null, storeDirty = false;
function flush() { // write whatever changed
  clearTimeout(saveTimer); saveTimer = null; const jobs = [], now = new Date().toISOString();
  if (storeDirty) {
    storeDirty = false; store.ever = [...ever]; store.today = [...today];
    jobs.push(useSB ? sb('app_state', '?on_conflict=key', { ...UPSERT, body: JSON.stringify({ key: 'tenrooms', data: store, updated_at: now }) }).catch(e => { console.warn(e.message); storeDirty = true; schedule(); }) : writeFile(DATA, store));
  }
  if (dirty.size || gone.size) {
    const ups = [...dirty].filter(u => accounts.has(u)), dels = [...gone]; dirty.clear(); gone.clear();
    if (!useSB) jobs.push(writeFile(ACC, [...accounts.values()]));
    else {
      if (ups.length) jobs.push(sb('accounts', '?on_conflict=username', { ...UPSERT, body: JSON.stringify(ups.map(u => ({ username: u, data: accounts.get(u), updated_at: now }))) })
        .catch(e => { console.warn(e.message); ups.forEach(u => dirty.add(u)); schedule(); })); // try again shortly
      if (dels.length) jobs.push(sb('accounts', '?username=in.(' + dels.join(',') + ')', { method: 'DELETE' })
        .catch(e => { console.warn(e.message); dels.forEach(u => { if (!accounts.has(u)) gone.add(u); }); schedule(); }));
    }
  }
  return Promise.all(jobs);
}
function schedule() { if (!saveTimer) saveTimer = setTimeout(flush, 2000); } // changes are written at most every 2 seconds
function save() { storeDirty = true; schedule(); }
function saveAcct(a) { dirty.add(a.username); schedule(); }
process.on('SIGTERM', () => { flush().finally(() => process.exit(0)); }); // Render sends this before a restart: save anything still waiting
process.on('uncaughtException', e => console.error('uncaught error:', e)); // one bad message must not take the whole site down
process.on('unhandledRejection', e => console.error('unhandled rejection:', e));
// Images on posts are saved in the public Supabase Storage bucket post-images (posts outlive a restart, so their images must too).
const PIC_BASE = SB_URL + '/storage/v1/object/public/post-images/', postPics = useSB; // without Supabase, posts are text only
const picCall = (id, opts) => fetch(SB_URL + '/storage/v1/object/post-images/' + id + '.jpg', { ...opts, signal: AbortSignal.timeout(15000), headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, ...opts.headers } });
const storePic = (id, buf) => picCall(id, { method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=31536000' }, body: buf }).then(r => { if (!r.ok) throw new Error('Supabase storage answered ' + r.status); });
const dropPic = p => { if (p.img && postPics) picCall(p.img, { method: 'DELETE' }).catch(() => {}); }; // called whenever a post goes away
const TZ = (() => { try { new Date().toLocaleDateString('en-CA', { timeZone: process.env.STATS_TZ }); return process.env.STATS_TZ; } catch { return ''; } })() || 'UTC'; // "today" rolls over at midnight in this time zone
function newDay() { const d = new Date().toLocaleDateString('en-CA', { timeZone: TZ }); if (d !== store.day) { store.day = d; today.clear(); } }
function seen(code) { newDay(); if (!today.has(code) || !ever.has(code)) { today.add(code); ever.add(code); save(); } } // a person is counted once per account
function stats() { newDay(); return { today: today.size, ever: ever.size, menu: [...wss.clients].filter(c => c.name && !c.room).length }; }
const avOf = code => { const a = accounts.get(code); return a && a.av ? a.avv || 1 : 0; }; // the version number of someone's profile picture, 0 if they have none
const postView = (p, ws) => ({ id: p.id, code: p.code, name: p.name, av: avOf(p.code), text: p.text, img: p.img, t: p.t, likes: p.likes.length, liked: p.likes.includes(ws.code), comments: p.comments.map(c => ({ ...c, av: avOf(c.code) })) });
const toFeed = make => wss.clients.forEach(c => c.feed && send(c, make(c))); // only people with the Posts page open get updates
const pushPost = p => toFeed(c => ({ type: 'post', post: postView(p, c) }));
const gpollView = ws => store.gpoll && { id: store.gpoll.id, q: store.gpoll.q, opts: store.gpoll.opts.map(o => ({ t: o.t, n: o.v.length })), mine: store.gpoll.opts.findIndex(o => o.v.includes(ws.code)) };
const pushGpoll = () => wss.clients.forEach(c => c.name && send(c, { type: 'gpoll', poll: gpollView(c) }));

// Accounts: a username (the @name, fixed), a display name and bio (changeable), and a friends list.
// Passwords are never stored: only a salted scrypt hash. A login hands the browser a random token so it stays logged in;
// only the token's hash is kept, at most 5 per account.
const USER_RE = /^[a-z0-9_]{3,16}$/;
// Text moderation, used on names, bios, chat, topics, polls, posts and comments. Two layers:
// 1. BLOCKED_WORDS (Render: Environment, comma-separated): matched after undoing the usual tricks (l33t, spaces and dots between letters, repeated letters).
// 2. OpenAI's moderation model, when OPENAI_API_KEY is set: blocks hate speech and slurs, threats, and anything sexual about minors. Ordinary rudeness is let through.
const squash = t => String(t).toLowerCase().replace(/[@4]/g, 'a').replace(/[1!|]/g, 'i').replace(/3/g, 'e').replace(/0/g, 'o').replace(/[5$]/g, 's').replace(/7/g, 't').replace(/[^a-z]/g, '').replace(/(.)\1+/g, '$1');
const BLOCKED = (process.env.BLOCKED_WORDS || '').split(',').map(squash).filter(w => w.length > 2);
const badName = t => { const l = squash(t); return BLOCKED.some(w => l.includes(w)); };
const okCache = new Map(); // text already checked -> allowed or not
async function textOk(text) { // false means: block it
  if (!text) return true;
  if (badName(text)) return false;
  if (!OPENAI) return true;
  const key = text.toLowerCase(); if (okCache.has(key)) return okCache.get(key);
  try {
    const r = await fetch('https://api.openai.com/v1/moderations', { method: 'POST', signal: AbortSignal.timeout(4000), headers: { Authorization: 'Bearer ' + OPENAI, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'omni-moderation-latest', input: text }) });
    if (!r.ok) throw new Error('OpenAI answered ' + r.status);
    const res = (await r.json()).results[0], c = res.categories || {}, sc = res.category_scores || {};
    const ok = !(c.hate || c['hate/threatening'] || c['harassment/threatening'] || c['sexual/minors'] || sc.hate > .35);
    if (okCache.size > 3000) okCache.clear(); okCache.set(key, ok);
    return ok;
  } catch (e) { console.warn('text check failed:', e.message); return true; } // if the checker is down, the site keeps working
}
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const hashPass = (pass, salt) => new Promise((ok, no) => crypto.scrypt(pass, salt, 64, (e, k) => (e ? no(e) : ok(k.toString('hex')))));
const err = (ws, text) => send(ws, { type: 'error', text });
const tries = new Map(); // "kind + ip" -> { n, t }: slows down password guessing and mass sign-ups
function tooMany(key, max, ms) {
  const now = Date.now(), f = tries.get(key); if (tries.size > 5000) tries.clear();
  if (!f || now - f.t > ms) { tries.set(key, { n: 1, t: now }); return false; }
  return ++f.n > max;
}
const online = new Map(); // username -> the sockets logged in as it right now (one per open tab)
const socketsOf = code => [...(online.get(code) || [])];
const isFriend = (a, b) => { const x = accounts.get(a); return !!x && x.friends.includes(b); }; // a has added b
const mutual = (a, b) => isFriend(a, b) && isFriend(b, a);
const meView = a => ({ code: a.username, display: a.display, bio: a.bio, av: a.av || '' });
const pubView = a => ({ code: a.username, name: a.display, bio: a.bio, joined: a.created, admin: ADMINS.has(a.username), online: online.has(a.username), av: avOf(a.username) });
function presence(ws) { // tell one person which of their friends are online and which room they are in
  if (!ws.acct) return;
  const list = ws.acct.friends.filter(c => online.has(c) && isFriend(c, ws.code)).map(c => {
    const all = socketsOf(c), o = all.find(x => x.room) || all[0];
    return { code: c, name: o.name, room: o.room ? o.room.id : 0 };
  });
  send(ws, { type: 'presence', list });
}
function sendFriends(user) { // their saved list, plus the people who added them and are waiting to be added back
  const a = accounts.get(user); if (!a) return;
  a.friends = a.friends.filter(c => accounts.has(c));
  const list = a.friends.map(c => ({ code: c, name: accounts.get(c).display, av: avOf(c) })), reqs = [];
  accounts.forEach(o => { if (o.friends.includes(user) && !a.friends.includes(o.username)) reqs.push({ code: o.username, name: o.display, av: avOf(o.username) }); });
  socketsOf(user).forEach(o => send(o, { type: 'friends', list, reqs }));
}
function startSession(ws, a, fresh, dev) { // this socket is now logged in as account a
  if (ws.readyState !== 1 || ws.acct) return;
  let token;
  if (fresh) { // a password login: hand out a new stay-logged-in token
    token = crypto.randomBytes(32).toString('hex'); const h = sha(token);
    a.sessions.push(h); tokens.set(h, a.username); while (a.sessions.length > 5) tokens.delete(a.sessions.shift());
    saveAcct(a);
  }
  ws.acct = a; ws.code = a.username; ws.name = uniqueName(a.display); ws.avatar = a.av || '';
  if (dev && !a.devices.includes(dev)) { a.devices.push(dev); if (a.devices.length > 5) a.devices.shift(); saveAcct(a); } // remembered so a block can cover the device too
  if (!online.has(ws.code)) online.set(ws.code, new Set());
  online.get(ws.code).add(ws); seen(ws.code);
  send(ws, { type: 'hello', id: ws.id, name: ws.name, rooms: lobby(), ice: ICE, gifs: !!KLIPY, pics: !!OPENAI, picBase: OPENAI && postPics ? PIC_BASE : '', stats: stats(), token, me: meView(a), admin: ADMINS.has(a.username) });
  send(ws, { type: 'gpoll', poll: gpollView(ws) }); sendFriends(a.username); pushLobby();
}
async function auth(ws, m) { // the only messages a socket may send before it is logged in
  const fail = (text, expired) => send(ws, { type: 'auth-fail', text, expired });
  const dev = typeof m.dev === 'string' && /^[a-f0-9]{32}$/.test(m.dev) ? m.dev : ''; // a random id the browser keeps
  if (dev && store.blocked.devices.some(d => d.id === dev)) return fail('This device is blocked from Ten Rooms', true);
  if (m.type === 'auth') { // a saved login from this browser
    const a = typeof m.token === 'string' && accounts.get(tokens.get(sha(m.token)));
    if (a && store.blocked.users.includes(a.username)) return fail('This account is blocked', true);
    return a ? startSession(ws, a, false, dev) : fail('', true);
  }
  if ((m.type !== 'login' && m.type !== 'register') || ws.busy) return;
  const user = String(m.user || '').trim().toLowerCase().replace(/^@/, ''), pass = String(m.pass || '');
  if (!USER_RE.test(user)) return fail('Usernames are 3 to 16 letters, numbers or _');
  if (pass.length < 6 || pass.length > 100) return fail('Passwords need at least 6 characters');
  ws.busy = true;
  try {
    if (m.type === 'register') {
      const display = clean(m.display, 20) || user;
      if (accounts.has(user)) return fail('That username is taken');
      if (badName(user) || badName(display)) return fail('Pick a different name');
      if (tooMany('reg' + ws.ip, 5, 3600000)) return fail('Too many new accounts from here. Try again later');
      if (!await textOk(user + ' ' + display)) return fail('Pick a different name');
      const salt = crypto.randomBytes(16).toString('hex'), hash = await hashPass(pass, salt);
      if (accounts.has(user)) return fail('That username is taken'); // someone else may have taken it while the password was being hashed
      const a = { username: user, display, bio: '', salt, hash, friends: [], sessions: [], devices: [], created: Date.now() };
      accounts.set(user, a); gone.delete(user); startSession(ws, a, true, dev);
    } else {
      if (tooMany('log' + ws.ip, 10, 600000)) return fail('Too many tries. Wait a few minutes');
      const a = accounts.get(user), hash = await hashPass(pass, a ? a.salt : 'no-such-account');
      if (!a || !crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(a.hash))) return fail('Wrong username or password');
      if (store.blocked.users.includes(user)) return fail('This account is blocked');
      startSession(ws, a, true, dev);
    }
  } catch (e) { console.warn('auth failed:', e.message); fail('Something went wrong. Try again'); } finally { ws.busy = false; }
}
function setProfile(a, display, bio) { // also renames them on their existing posts and comments
  a.display = display; a.bio = bio; saveAcct(a);
  store.posts.forEach(p => { if (p.code === a.username) p.name = display; p.comments.forEach(c => { if (c.code === a.username) c.name = display; }); });
  save();
}
function deleteAccount(a) { // moderation: the account, its posts, comments and likes all go
  const u = a.username;
  socketsOf(u).forEach(o => { send(o, { type: 'auth-fail', text: 'This account was deleted', expired: true }); o.close(); });
  a.sessions.forEach(h => tokens.delete(h)); accounts.delete(u); dirty.delete(u); gone.add(u);
  accounts.forEach(o => { const i = o.friends.indexOf(u); if (i >= 0) { o.friends.splice(i, 1); saveAcct(o); sendFriends(o.username); } });
  store.posts.filter(p => p.code === u).forEach(p => { dropPic(p); toFeed(() => ({ type: 'post-del', id: p.id })); });
  store.posts = store.posts.filter(p => p.code !== u);
  store.posts.forEach(p => {
    const i = p.likes.indexOf(u); if (i >= 0) p.likes.splice(i, 1);
    if (p.comments.some(c => c.code === u)) { p.comments = p.comments.filter(c => c.code !== u); pushPost(p); }
  });
  save();
}

// Vote kicks: one vote per room at a time, 30 seconds, and more than half of the other people must say yes.
const KICK_MS = 30000, BAN_MS = 10 * 60000;
const need = r => Math.floor((r.members.size - 1) / 2) + 1; // the person being voted on does not count
const voteInfo = r => r.vote && { target: r.vote.target, name: r.vote.name, by: r.vote.by, yes: r.vote.yes.size, need: need(r), left: r.vote.ends - Date.now() };
function endVote(r, text) { clearTimeout(r.vote.timer); r.vote = null; toRoom(r, { type: 'kickvote', over: true }); if (text) say(r, text); }
function checkVote(r) { // called after every vote and whenever someone leaves
  const v = r.vote; if (!v) return;
  const target = r.members.get(v.target), n = need(r);
  if (!target) return endVote(r, `${v.name} left, so the vote ended`);
  if (r.members.size < 3) return endVote(r, `The vote to kick ${v.name} ended: not enough people left`);
  if (v.yes.size >= n) {
    endVote(r, `${v.name} was voted out of the room`);
    const until = Date.now() + BAN_MS; // kept out for 10 minutes, by friend code and by name
    r.bans.forEach((t, k) => { if (t < Date.now()) r.bans.delete(k); });
    if (target.code) r.bans.set('c:' + target.code, until);
    r.bans.set('n:' + target.name.toLowerCase(), until);
    send(target, { type: 'kicked', text: `You were voted out of ${r.name}. You can come back in 10 minutes.` });
    leave(target);
  } else if (v.no.size > r.members.size - 1 - n) endVote(r, `The vote to kick ${v.name} failed`); // too many said no for it to pass
  else toRoom(r, { type: 'kickvote', ...voteInfo(r) });
}

function uniqueName(raw) { // two people can't share a name: "Sam" becomes "Sam 2"
  const base = String(raw || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 20) || 'Guest';
  const taken = new Set([...wss.clients].filter(c => c.name).map(c => c.name.toLowerCase()));
  let n = base, i = 2;
  while (taken.has(n.toLowerCase())) n = `${base} ${i++}`;
  return n;
}
function addStroke(r, sid, c, w, pts) { // whiteboard strokes are kept so late joiners see the board
  let s = r.board.find(x => x.sid === sid);
  if (!s) { s = { sid, c, w, pts: [] }; r.board.push(s); }
  s.pts.push(...pts);
  let n = r.board.reduce((a, x) => a + x.pts.length, 0);
  while (n > 60000 && r.board.length > 1) n -= r.board.shift().pts.length;
}
function say(r, text) {
  const m = { system: true, text, t: Date.now() };
  r.chat.push(m); if (r.chat.length > 50) r.chat.shift();
  toRoom(r, { type: 'chat', msg: m });
}
const findMsg = (r, id) => r.chat.find(x => !x.system && x.id === id);
const newMsg = (ws, extra) => ({ id: ++msgSeq, name: ws.name, text: '', t: Date.now(), reacts: {}, ...extra });
function post(r, msg) { r.chat.push(msg); if (r.chat.length > 50) r.chat.shift(); toRoom(r, { type: 'chat', msg }); }
const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);
const slow = (ws, key, ms) => { const now = Date.now(); if (now - (ws[key] || 0) < ms) return true; ws[key] = now; return false; }; // true = too soon, ignore it
function mentions(r, text) { // names in the room that the text @s; longest first so "@Sam 2" is not also read as "@Sam"
  let low = text.toLowerCase(); const at = [];
  [...r.members.values()].map(p => p.name).sort((a, b) => b.length - a.length).forEach(n => {
    const k = '@' + n.toLowerCase(); if (low.includes(k)) { at.push(n); low = low.split(k).join(' '); }
  });
  return at;
}
// Mini-games live inside a chat message (msg.game) and the server checks every move.
const GAMES = ['ttt', 'c4', 'rps', 'num', 'react', 'hang'], OPEN = ['num', 'react', 'hang'], RPS = ['rock', 'paper', 'scissors'], secrets = new WeakMap(); // secrets: rock-paper-scissors picks, hidden until both have chosen
const WORDS = 'planet,guitar,castle,rocket,dragon,jungle,pirate,wizard,galaxy,monkey,pencil,tornado,volcano,penguin,dolphin,library,rainbow,blanket,popcorn,sandwich,backpack,football,mountain,keyboard,dinosaur,hamburger,skeleton,treasure,elephant,lightning,pineapple,astronaut,chocolate,butterfly,spaghetti,trampoline'.split(','); // hangman
const TTT = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
function c4win(b, i) { // b is 7 wide and 6 tall with row 0 at the top; i is the cell that was just filled
  const x = i % 7, y = (i / 7) | 0, v = b[i];
  return [[1, 0], [0, 1], [1, 1], [1, -1]].some(([dx, dy]) => {
    let n = 1;
    for (const s of [1, -1]) for (let k = 1; k < 4; k++) {
      const cx = x + dx * k * s, cy = y + dy * k * s;
      if (cx < 0 || cx > 6 || cy < 0 || cy > 5 || b[cy * 7 + cx] !== v) break; n++;
    }
    return n >= 4;
  });
}
function leave(ws) {
  const r = ws.room; if (!r) return;
  r.members.delete(ws.id); ws.room = null; ws.racing = false;
  if (ws.shooting) { ws.shooting = false; r.members.forEach(p => p.shooting && send(p, { type: 'shoot-gone', id: ws.id })); }
  toRoom(r, { type: 'peer-left', id: ws.id });
  say(r, `${ws.name} left`);
  if (r.vote) { r.vote.yes.delete(ws.id); r.vote.no.delete(ws.id); checkVote(r); }
  if (!r.members.size) { r.topic = ''; r.chat = []; r.board = []; r.race = null; r.shoot = null; } // empty room resets
  pushLobby();
}

wss.on('connection', (ws, req) => {
  ws.id = nextId++; ws.room = null; ws.alive = true;
  ws.ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); // Render puts the visitor's address in this header
  ws.on('pong', () => ws.alive = true);

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (!ws.acct) return void auth(ws, m); // nothing below works until this socket has logged in
    if (m.type === 'join') {
      const r = rooms[(m.room | 0) - 1]; if (!r) return;
      if (r.members.size >= r.max) return send(ws, { type: 'error', text: `${r.name} is full` });
      const banned = Math.max(r.bans.get('c:' + ws.code) || 0, r.bans.get('n:' + ws.name.toLowerCase()) || 0) - Date.now();
      if (banned > 0) return send(ws, { type: 'error', text: `You were voted out of ${r.name}. Try again in ${Math.ceil(banned / 60000)} min.` });
      leave(ws); ws.st = {};
      const peers = [...r.members.values()].map(p => ({ id: p.id, name: p.name, avatar: p.avatar, code: p.code, ...p.st }));
      r.members.set(ws.id, ws); ws.room = r;
      send(ws, { type: 'joined', room: r.id, name: r.name, max: r.max, topic: r.topic, board: r.board, peers, chat: r.chat, vote: voteInfo(r), race: r.race ? r.race.seed : 0, shoot: r.shoot ? r.shoot.seed : 0 });
      toRoom(r, { type: 'peer-joined', id: ws.id, name: ws.name, avatar: ws.avatar, code: ws.code, ...ws.st }, ws.id);
      say(r, `${ws.name} joined`); pushLobby();
    } else if (m.type === 'leave') leave(ws);
    else if (m.type === 'state' && ws.room) { // mute / camera-off status, shown on everyone's tiles
      ws.st = { muted: !!m.muted, camOff: !!m.camOff, sharing: !!m.sharing };
      toRoom(ws.room, { type: 'state', id: ws.id, ...ws.st }, ws.id);
    } else if (m.type === 'avatar') { // profile picture: a small JPEG saved on the account, checked like any other image when image checking is on
      const d = typeof m.data === 'string' && m.data.length < 30000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(m.data) ? m.data : '', a = ws.acct;
      const apply = () => {
        if (a.av !== d) { a.av = d; a.avv = (a.avv || 0) + 1; saveAcct(a); }
        socketsOf(a.username).forEach(o => { o.avatar = d; send(o, { type: 'me', me: meView(a) }); if (o.room) toRoom(o.room, { type: 'avatar', id: o.id, data: d }, o.id); });
      };
      if (!d || d === a.av || !OPENAI) return apply();
      if (slow(ws, 'lastAv', 5000)) return err(ws, 'Wait a few seconds before changing your picture again');
      imageOk(d).then(ok => (ok ? apply() : err(ws, 'That picture is not allowed here')), () => err(ws, 'The picture could not be checked. Try again'));
    } else if (m.type === 'stroke' && ws.room) {
      const sid = String(m.sid || '').slice(0, 24), c = String(m.c || '');
      if (!sid || !/^#[0-9a-fA-F]{6}$/.test(c) || !Array.isArray(m.pts) || m.pts.length > 400) return;
      const pts = m.pts.slice(0, m.pts.length - (m.pts.length % 2)).map(n => Math.max(0, Math.min(1000, Math.round(+n) || 0)));
      const w = Math.max(1, Math.min(90, +m.w || 4));
      addStroke(ws.room, sid, c, w, pts); toRoom(ws.room, { type: 'stroke', sid, c, w, pts }, ws.id);
    } else if (m.type === 'board-clear' && ws.room) {
      ws.room.board = []; toRoom(ws.room, { type: 'board-clear', by: ws.name }, ws.id);
    } else if (m.type === 'mreact' && ws.room && REACTS.includes(m.emoji)) { // toggle your reaction on a chat message
      const msg = findMsg(ws.room, m.mid); if (!msg) return;
      const arr = msg.reacts[m.emoji] = msg.reacts[m.emoji] || [], i = arr.indexOf(ws.name);
      if (i >= 0) arr.splice(i, 1); else arr.push(ws.name);
      if (!arr.length) delete msg.reacts[m.emoji];
      toRoom(ws.room, { type: 'mreact', mid: msg.id, reacts: msg.reacts });
    } else if (m.type === 'topic' && ws.room) {
      const t = String(m.text || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40);
      const room = ws.room;
      textOk(t).then(ok => {
        if (!ok) return err(ws, 'That topic was blocked'); if (ws.room !== room) return;
        room.topic = t; toRoom(room, { type: 'topic', text: t });
        say(room, t ? ws.name + ' set the topic: ' + t : ws.name + ' cleared the topic'); pushLobby();
      });
    } else if (m.type === 'react' && ws.room && REACTS.includes(m.emoji)) {
      const now = Date.now(); if (now - (ws.lastReact || 0) < 200) return; ws.lastReact = now;
      toRoom(ws.room, { type: 'react', id: ws.id, emoji: m.emoji }, ws.id);
    } else if (m.type === 'typing' && ws.room) {
      toRoom(ws.room, { type: 'typing', id: ws.id, name: ws.name, on: !!m.on }, ws.id);
    }
    else if (m.type === 'signal' && ws.room) {
      const to = ws.room.members.get(m.to);
      if (to) send(to, { type: 'signal', from: ws.id, data: m.data });
    } else if (m.type === 'chat' && ws.room) {
      const gif = KLIPY && typeof m.gif === 'string' && m.gif.length < 300 && GIFURL.test(m.gif) ? m.gif : null; // a GIF instead of text
      const up = !gif && typeof m.pic === 'string' && pics.get(m.pic), pic = up && up.by === ws.code && !up.used ? m.pic : null; // an image they uploaded and that passed the check
      const text = gif || pic ? '' : String(m.text || '').trim().slice(0, 500); if (!text && !gif && !pic) return;
      if (gif && slow(ws, 'lastGif', 1000)) return;
      const msg = newMsg(ws, { text }); if (gif) msg.gif = gif; if (pic) { up.used = true; msg.pic = pic; }
      const src = findMsg(ws.room, m.re); // the message this one replies to, if any
      if (src) msg.re = { id: src.id, name: src.name, text: src.text ? src.text.slice(0, 80) : src.gif ? 'GIF' : src.pic ? 'Image' : src.poll ? 'Poll' : 'Game' };
      const at = mentions(ws.room, text); if (at.length) msg.at = at;
      const room = ws.room; if (!text) return post(room, msg);
      textOk(text).then(ok => { if (!ok) return err(ws, 'That message was blocked'); if (ws.room === room) post(room, msg); });
    } else if (m.type === 'poll' && ws.room) { // a poll is a chat message with options people vote on
      const q = clean(m.q, 100), opts = (Array.isArray(m.opts) ? m.opts.slice(0, 6) : []).map(o => clean(o, 50)).filter(Boolean);
      if (!q || opts.length < 2 || slow(ws, 'lastPoll', 3000)) return;
      const room = ws.room; textOk(q + ' ' + opts.join(' ')).then(ok => { if (!ok) return err(ws, 'That poll was blocked'); if (ws.room === room) post(room, newMsg(ws, { poll: { q, opts: opts.map(t => ({ t, v: [] })) } })); });
    } else if (m.type === 'vote' && ws.room) { // one vote each: picking another option moves it, picking yours again removes it
      const msg = findMsg(ws.room, m.mid), p = msg && msg.poll, o = p && p.opts[m.opt | 0]; if (!o) return;
      const had = o.v.includes(ws.name);
      p.opts.forEach(x => { const i = x.v.indexOf(ws.name); if (i >= 0) x.v.splice(i, 1); });
      if (!had) o.v.push(ws.name);
      toRoom(ws.room, { type: 'poll', mid: msg.id, poll: p });
    } else if (m.type === 'luck' && ws.room) {
      if (slow(ws, 'lastLuck', 1000)) return;
      if (m.kind === 'roll') say(ws.room, `${ws.name} rolled a ${1 + Math.floor(Math.random() * 6)}`);
      else if (m.kind === 'flip') say(ws.room, `${ws.name} flipped a coin: ${Math.random() < .5 ? 'heads' : 'tails'}`);
    } else if (m.type === 'game' && ws.room && GAMES.includes(m.kind)) { // start a game; it waits for a second player
      if (slow(ws, 'lastGame', 3000)) return;
      const g = { kind: m.kind, p: [ws.name], turn: 0, win: null };
      if (m.kind === 'ttt') g.b = Array(9).fill(null); else if (m.kind === 'c4') g.b = Array(42).fill(null); else g.done = [false, false];
      const msg = newMsg(ws, { game: g }), r = ws.room;
      if (m.kind === 'num') { g.lo = 1; g.hi = 100; g.tries = 0; secrets.set(msg, 1 + Math.floor(Math.random() * 100)); } // the number and the word stay on the server
      else if (m.kind === 'hang') { const w = WORDS[Math.floor(Math.random() * WORDS.length)]; secrets.set(msg, w); g.mask = w.replace(/./g, '_'); g.used = ''; g.left = 6; }
      else if (m.kind === 'react') { // turns to "go" after a random wait; clicking before that puts you out
        g.go = false; g.out = [];
        setTimeout(() => { if (g.win === null && r.chat.includes(msg)) { g.go = true; toRoom(r, { type: 'game', mid: msg.id, game: g }); } }, 2000 + Math.random() * 4000);
      }
      post(r, msg);
    } else if (m.type === 'gjoin' && ws.room) {
      const msg = findMsg(ws.room, m.mid), g = msg && msg.game;
      if (!g || g.p.length > 1 || g.p[0] === ws.name) return;
      g.p.push(ws.name); toRoom(ws.room, { type: 'game', mid: msg.id, game: g });
    } else if (m.type === 'gmove' && ws.room) {
      const msg = findMsg(ws.room, m.mid), g = msg && msg.game, me = g ? g.p.indexOf(ws.name) : -1;
      if (g && OPEN.includes(g.kind)) {
        if (g.win !== null) return;
        if (g.kind === 'num') {
          const guess = m.n | 0, secret = secrets.get(msg); if (guess < g.lo || guess > g.hi) return;
          g.tries++; g.last = ws.name + ' guessed ' + guess;
          if (guess === secret) g.win = ws.name; else if (guess < secret) g.lo = guess + 1; else g.hi = guess - 1;
        } else if (g.kind === 'react') {
          if (g.out.includes(ws.name)) return;
          if (g.go) g.win = ws.name; else g.out.push(ws.name);
        } else {
          const l = String(m.l || '').toLowerCase(), w = secrets.get(msg); if (!/^[a-z]$/.test(l) || g.used.includes(l)) return;
          g.used += l; if (!w.includes(l)) g.left--;
          g.mask = [...w].map(c => (g.used.includes(c) ? c : '_')).join('');
          if (g.mask === w) g.win = ws.name; else if (g.left <= 0) { g.win = ''; g.lost = true; g.mask = w; }
        }
        return toRoom(ws.room, { type: 'game', mid: msg.id, game: g });
      }
      if (!g || g.p.length < 2 || g.win !== null || me < 0) return;
      if (g.kind === 'rps') {
        if (!RPS.includes(m.pick) || g.done[me]) return;
        const s = secrets.get(msg) || []; s[me] = m.pick; secrets.set(msg, s); g.done[me] = true;
        if (g.done[0] && g.done[1]) { // both chose: show the picks. Each choice beats the one before it in RPS
          const d = (RPS.indexOf(s[0]) - RPS.indexOf(s[1]) + 3) % 3;
          g.picks = s; g.win = d === 0 ? 'draw' : d === 1 ? 0 : 1;
        }
      } else {
        if (me !== g.turn) return;
        let i = m.i | 0;
        if (g.kind === 'c4') { // i is a column; the piece drops to the lowest empty cell
          if (i < 0 || i > 6) return;
          let y = 5; while (y >= 0 && g.b[y * 7 + i] !== null) y--;
          if (y < 0) return; i = y * 7 + i;
        } else if (i < 0 || i > 8 || g.b[i] !== null) return;
        g.b[i] = me; g.last = i; g.turn = 1 - me;
        const won = g.kind === 'c4' ? c4win(g.b, i) : TTT.some(l => l.every(c => g.b[c] === me));
        g.win = won ? me : g.b.every(c => c !== null) ? 'draw' : null;
      }
      toRoom(ws.room, { type: 'game', mid: msg.id, game: g });
    } else if (m.type === 'race' && ws.room) {
      const r = ws.room;
      if (m.act === 'pos') { // where this player is, passed on to the others about 12 times a second
        const x = +m.x, y = +m.y; if (!isFinite(x) || !isFinite(y) || slow(ws, 'lastPos', 60)) return;
        r.members.forEach((p, id) => { if (id !== ws.id && p.racing) send(p, { type: 'race-pos', id: ws.id, x: Math.round(x), y: Math.round(y) }); }); // only people with the race open
      } else if (m.act === 'open') ws.racing = !!m.on; // they opened or closed the race panel
      else if (m.act === 'start') {
        if (slow(ws, 'lastRace', 8000)) return err(ws, 'Wait a few seconds before starting another race');
        r.race = { seed: 1 + Math.floor(Math.random() * 1e9), at: Date.now() + 3500, done: new Set() }; // the seed builds the same course for everyone
        toRoom(r, { type: 'race-start', seed: r.race.seed, wait: 3500, by: ws.name });
        say(r, ws.name + ' started a platformer race. Press Join on the banner to race');
      } else if (m.act === 'finish' && r.race && !r.race.done.has(ws.id)) {
        const ms = Date.now() - r.race.at; if (ms < 4000) return; // nobody finishes that fast
        r.race.done.add(ws.id); const secs = (ms / 1000).toFixed(1);
        say(r, r.race.done.size === 1 ? ws.name + ' won the platformer race in ' + secs + 's' : ws.name + ' finished the race in ' + secs + 's');
        toRoom(r, { type: 'race-end', id: ws.id, name: ws.name, place: r.race.done.size, secs });
      }
    } else if (m.type === 'shoot' && ws.room) { // shooter arena: each browser moves its own player; the server passes positions and shots on and keeps the score
      const r = ws.room, others = make => r.members.forEach((p, id) => { if (id !== ws.id && p.shooting) send(p, make); }), num = v => (isFinite(+v) ? Math.round(+v * 100) / 100 : 0);
      if (m.act === 'open') { ws.shooting = !!m.on; if (!ws.shooting) others({ type: 'shoot-gone', id: ws.id }); }
      else if (m.act === 'pos') { if (!slow(ws, 'lastSPos', 45)) others({ type: 'shoot-pos', id: ws.id, x: num(m.x), y: num(m.y), a: num(m.a), hp: m.hp | 0 }); }
      else if (m.act === 'fire') { if (!slow(ws, 'lastFire', 200)) others({ type: 'shoot-fire', id: ws.id, x: num(m.x), y: num(m.y), a: num(m.a) }); }
      else if (m.act === 'start') {
        if (slow(ws, 'lastMatch', 8000)) return err(ws, 'Wait a few seconds before starting another match');
        r.shoot = { seed: 1 + Math.floor(Math.random() * 1e9), score: {}, over: false }; // the seed builds the same walls for everyone
        toRoom(r, { type: 'shoot-start', seed: r.shoot.seed, by: ws.name });
        say(r, ws.name + ' started a shooter match. Press Join on the banner to play');
      } else if (m.act === 'dead') { // sent by the player who got knocked out, naming who did it
        const k = r.members.get(m.by); if (!k || k === ws || slow(ws, 'lastDead', 1500)) return;
        r.shoot = r.shoot || { seed: 1, score: {}, over: false }; if (r.shoot.over) return;
        const sc = r.shoot.score; sc[k.id] = (sc[k.id] || 0) + 1;
        toRoom(r, { type: 'shoot-score', score: sc, text: k.name + ' knocked out ' + ws.name });
        if (sc[k.id] >= 10) { r.shoot.over = true; say(r, k.name + ' won the shooter match'); toRoom(r, { type: 'shoot-score', score: sc, text: k.name + ' wins the match!' }); }
      }
    } else if (m.type === 'kick' && ws.room) { // start a vote to kick someone; the starter counts as a yes
      const r = ws.room, t = r.members.get(m.id);
      if (!t || t === ws) return;
      if (r.vote) return send(ws, { type: 'error', text: 'A vote is already running' });
      if (r.members.size < 3) return send(ws, { type: 'error', text: 'Vote kicks need at least 3 people in the room' });
      if (slow(ws, 'lastKick', 60000)) return send(ws, { type: 'error', text: 'You can start one vote a minute' });
      const v = r.vote = { target: t.id, name: t.name, by: ws.name, yes: new Set([ws.id]), no: new Set(), ends: Date.now() + KICK_MS };
      v.timer = setTimeout(() => { if (r.vote === v) endVote(r, `The vote to kick ${v.name} ran out of time`); }, KICK_MS);
      say(r, `${ws.name} started a vote to kick ${t.name}`); checkVote(r);
    } else if (m.type === 'kickv' && ws.room && ws.room.vote) {
      const v = ws.room.vote; if (ws.id === v.target) return;
      v.yes.delete(ws.id); v.no.delete(ws.id); (m.yes ? v.yes : v.no).add(ws.id); checkVote(ws.room);
    } else if (m.type === 'logout') { // forget this browser's stay-logged-in token
      const h = typeof m.token === 'string' && sha(m.token), i = ws.acct.sessions.indexOf(h);
      if (i >= 0) { ws.acct.sessions.splice(i, 1); tokens.delete(h); saveAcct(ws.acct); }
      ws.close();
    } else if (m.type === 'friend-add') {
      const a = ws.acct, c = String(m.code || '').trim().toLowerCase().replace(/^@/, '');
      if (c === a.username) return err(ws, 'That is you');
      if (!accounts.has(c)) return err(ws, 'There is no account called @' + c.slice(0, 16));
      if (a.friends.includes(c)) return; if (a.friends.length >= 200) return err(ws, 'Your friends list is full');
      a.friends.push(c); saveAcct(a); sendFriends(a.username); sendFriends(c); pushLobby();
    } else if (m.type === 'friend-del') {
      const a = ws.acct, i = a.friends.indexOf(m.code); if (i < 0) return;
      a.friends.splice(i, 1); saveAcct(a); sendFriends(a.username); sendFriends(m.code); pushLobby();
    } else if (m.type === 'dm') { // direct message: passed straight on, never stored here
      const text = String(m.text || '').trim().slice(0, 500); if (!text || slow(ws, 'lastDm', 300)) return;
      if (!mutual(ws.code, m.to) || !online.has(m.to)) return send(ws, { type: 'dm-fail', text: 'Not sent: they are offline or have not added you back' });
      const t = Date.now();
      socketsOf(m.to).forEach(o => send(o, { type: 'dm', from: ws.code, name: ws.name, text, t }));
      socketsOf(ws.code).forEach(o => send(o, { type: 'dm', to: m.to, text, t }));
    } else if (m.type === 'profile') { // someone's profile page: who they are and their posts
      const a = accounts.get(String(m.user || '').toLowerCase()); if (!a) return err(ws, 'That account no longer exists');
      send(ws, { type: 'profile', user: { ...pubView(a), blocked: ADMINS.has(ws.code) ? store.blocked.users.includes(a.username) : undefined }, posts: store.posts.filter(p => p.code === a.username).slice(-50).map(p => postView(p, ws)) });
    } else if (m.type === 'profile-set') { // your own display name and bio
      const display = clean(m.display, 20) || ws.code, bio = String(m.bio || '').replace(/[\u0000-\u0009\u000b-\u001f]/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 200);
      if (badName(display)) return err(ws, 'Pick a different display name');
      if (slow(ws, 'lastProf', 3000)) return err(ws, 'Wait a few seconds before saving again');
      textOk(display + '\n' + bio).then(ok => {
        if (!ok) return err(ws, 'That name or bio was blocked');
        setProfile(ws.acct, display, bio); socketsOf(ws.code).forEach(o => send(o, { type: 'me', me: meView(ws.acct), saved: o === ws }));
      });
    } else if (m.type === 'mod' && ADMINS.has(ws.code)) { // moderators only
      const a = accounts.get(String(m.user || '').toLowerCase()); if (!a) return;
      if (m.act === 'reset-name') setProfile(a, a.username, a.bio);
      else if (m.act === 'clear-bio') setProfile(a, a.display, '');
      else if (m.act === 'delete') { if (ADMINS.has(a.username)) return err(ws, 'Moderator accounts cannot be deleted from here'); deleteAccount(a); }
      else if (m.act === 'block') { // the account and every device it has used are shut out
        if (ADMINS.has(a.username)) return err(ws, 'Moderator accounts cannot be blocked from here');
        if (!store.blocked.users.includes(a.username)) store.blocked.users.push(a.username);
        a.devices.forEach(id => { if (!store.blocked.devices.some(d => d.id === id)) store.blocked.devices.push({ id, user: a.username }); });
        socketsOf(a.username).forEach(o => { send(o, { type: 'auth-fail', text: 'You have been blocked from Ten Rooms', expired: true }); o.close(); });
        save();
      } else if (m.act === 'unblock') {
        store.blocked.users = store.blocked.users.filter(u => u !== a.username); store.blocked.devices = store.blocked.devices.filter(d => d.user !== a.username); save();
      } else return;
      if (m.act === 'reset-name' || m.act === 'clear-bio') socketsOf(a.username).forEach(o => send(o, { type: 'me', me: meView(a), saved: true, mod: true }));
      send(ws, { type: 'mod-done', act: m.act, user: a.username });
    } else if (m.type === 'mod-list' && ADMINS.has(ws.code)) { // the moderation panel: who is blocked
      send(ws, { type: 'mod-list', users: store.blocked.users.map(u => ({ code: u, name: accounts.has(u) ? accounts.get(u).display : u, devices: store.blocked.devices.filter(d => d.user === u).length })), accounts: accounts.size });
    } else if (m.type === 'ability' && ws.room) { // throw a tomato at someone in the room; everyone there sees it land
      const t = ws.room.members.get(m.to); if (m.id !== 'a_tomato' || !t || t === ws) return;
      if (slow(ws, 'lastAbil', 10000)) return err(ws, 'Wait 10 seconds between tomatoes');
      toRoom(ws.room, { type: 'ability', id: 'a_tomato', from: ws.id, to: t.id });
    } else if (m.type === 'gpoll-set' && ADMINS.has(ws.code)) { // admin only: start, edit or remove the global poll
      if (m.remove) store.gpoll = null;
      else {
        const q = clean(m.q, 120), opts = (Array.isArray(m.opts) ? m.opts.slice(0, 6) : []).map(o => clean(o, 60)).filter(Boolean);
        if (!q || opts.length < 2) return send(ws, { type: 'error', text: 'A poll needs a question and at least 2 options' });
        const old = m.keep && store.gpoll ? store.gpoll : null; // keep: an edit, so each option keeps the votes it had in that position
        store.gpoll = { id: old ? old.id : ++store.seq, q, opts: opts.map((t, i) => ({ t, v: old && old.opts[i] ? old.opts[i].v : [] })) };
      }
      save(); pushGpoll();
    } else if (m.type === 'gpoll-vote' && ws.code && store.gpoll) { // one vote per browser, counted by friend code
      const o = store.gpoll.opts[m.opt | 0]; if (!o || slow(ws, 'lastGv', 200)) return;
      const had = o.v.includes(ws.code);
      store.gpoll.opts.forEach(x => { const i = x.v.indexOf(ws.code); if (i >= 0) x.v.splice(i, 1); });
      if (!had) o.v.push(ws.code);
      save(); pushGpoll();
    } else if (m.type === 'feed') { // the Posts page was opened or closed
      ws.feed = !!m.on;
      if (ws.feed) send(ws, { type: 'feed', posts: store.posts.slice(-50).map(p => postView(p, ws)) });
    } else if (m.type === 'post-new' && ws.code) {
      const up = postPics && typeof m.pic === 'string' && pics.get(m.pic), pic = up && up.by === ws.code && !up.used ? m.pic : null; // an uploaded image that passed the check
      const text = String(m.text || '').replace(/[\u0000-\u0009\u000b-\u001f]/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 500); if (!text && !pic) return;
      if (slow(ws, 'lastPost', 10000)) return err(ws, 'Wait a few seconds before posting again');
      const p = { id: ++store.seq, code: ws.code, name: ws.acct.display, text, t: Date.now(), likes: [], comments: [] };
      const publish = () => {
        store.posts.push(p); if (store.posts.length > 200) dropPic(store.posts.shift());
        save(); pushPost(p);
        ws.acct.friends.forEach(c => { if (isFriend(c, ws.code)) socketsOf(c).forEach(o => send(o, { type: 'friend-post', name: p.name, code: p.code })); }); // friends get a notification
      };
      textOk(text).then(ok => {
        if (!ok) return err(ws, 'That post was blocked');
        if (!pic) return publish();
        up.used = true; storePic(pic, up.buf).then(() => { p.img = pic; publish(); }, e => { console.warn(e.message); err(ws, 'The image could not be saved. Try again'); });
      });
    } else if (m.type === 'post-like' && ws.code) {
      const p = store.posts.find(x => x.id === m.id); if (!p || slow(ws, 'lastLike', 150)) return;
      const i = p.likes.indexOf(ws.code); if (i >= 0) p.likes.splice(i, 1); else p.likes.push(ws.code);
      save(); pushPost(p);
    } else if (m.type === 'post-comment' && ws.code) {
      const p = store.posts.find(x => x.id === m.id), text = clean(m.text, 300); if (!p || !text || p.comments.length >= 100) return;
      if (slow(ws, 'lastCom', 3000)) return send(ws, { type: 'error', text: 'Wait a few seconds before commenting again' });
      textOk(text).then(ok => {
        if (!ok) return err(ws, 'That comment was blocked');
        p.comments.push({ id: ++store.seq, code: ws.code, name: ws.acct.display, text, t: Date.now() }); save(); pushPost(p);
      });
    } else if (m.type === 'post-del' && ws.code) { // your own post or comment, a comment on your post, or anything if you are an admin
      const p = store.posts.find(x => x.id === m.id), boss = ADMINS.has(ws.code); if (!p) return;
      if (m.cid) {
        const c = p.comments.find(x => x.id === m.cid); if (!c || !(boss || c.code === ws.code || p.code === ws.code)) return;
        p.comments.splice(p.comments.indexOf(c), 1); save(); pushPost(p);
      } else if (boss || p.code === ws.code) { store.posts.splice(store.posts.indexOf(p), 1); dropPic(p); save(); toFeed(() => ({ type: 'post-del', id: p.id })); }
    }
  });
  ws.on('close', () => {
    leave(ws); ws.name = null;
    const set = online.get(ws.code);
    if (set) { set.delete(ws); if (!set.size) online.delete(ws.code); pushLobby(); } // friends see them go offline
  });
});
setInterval(() => wss.clients.forEach(c => { if (!c.alive) return c.terminate(); c.alive = false; c.ping(); }), 30000);
loadStore().finally(() => server.listen(PORT, () => console.log(`Ten Rooms running on port ${PORT}`)));
