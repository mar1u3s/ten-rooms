// Ten Rooms: lobby + signaling server. Video/audio go browser-to-browser (WebRTC); this only handles names, rooms, handshakes, chat, posts and polls.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000, REACTS = ['👍', '😂', '🎉', '👏', '🔥', '💜'], CHAT_KEEP = 100;
// [name, max people]. Small rooms keep full video; bigger rooms get lower per-person video quality (see tune() in index.html).
const ROOMS = [['Lounge', 6], ['Studio', 6], ['Kitchen', 6], ['Garage', 10], ['Rooftop', 10], ['Library', 15], ['Arcade', 15], ['Workshop', 15], ['Garden', 50], ['Porch', 50]];
// GIFs come from the Klipy catalog. Set KLIPY_KEY (Render: Environment) to turn GIF search on; without it the GIF button is hidden.
// The key stays on the server: browsers ask /gifs and the server asks Klipy. Only links on Klipy's own domain can be sent in chat.
const KLIPY = process.env.KLIPY_KEY || '', GIFURL = /^https:\/\/([a-z0-9-]+\.)*klipy\.(com|co)\/[\w\-./%~]+$/i, gifCache = new Map();
let gifWarned = false;
function gifUrls(g) { // each GIF comes in sizes (hd, md, sm, xs) and formats; webp is the lightest that still animates
  const f = g.file || g.files || {}, pick = s => f[s] && (f[s].webp || f[s].gif);
  let big = pick('md') || pick('sm') || pick('hd'), small = pick('xs') || pick('sm') || big;
  if (!big) { // an answer shaped differently than expected: use any picture links found inside the item
    const found = [];
    (function walk(o, d) { if (!o || d > 6) return; if (typeof o === 'string') { if (/\.(webp|gif)$/i.test(o)) found.push({ url: o }); } else if (typeof o === 'object') for (const k in o) walk(o[k], d + 1); })(g, 0);
    big = found[0]; small = found[found.length - 1] || big;
    if (!gifWarned) { gifWarned = true; console.warn('Klipy: GIF items have an unexpected shape, used a fallback. Sample:', JSON.stringify(g).slice(0, 400)); }
  }
  return big && small && GIFURL.test(big.url) && GIFURL.test(small.url) ? { url: big.url, thumb: small.url, title: String(g.title || '').slice(0, 60) } : null;
}
async function gifs(q) { // search results, or what is trending when q is empty; answers are reused for 5 minutes
  const key = q.toLowerCase(), hit = gifCache.get(key);
  if (hit && Date.now() - hit.t < 300000) return hit.list;
  const r = await fetch(`https://api.klipy.com/api/v1/${KLIPY}/gifs/${q ? 'search' : 'trending'}?per_page=24&customer_id=tenrooms&content_filter=high` + (q ? '&q=' + encodeURIComponent(q) : ''), { signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error('Klipy answered ' + r.status);
  const j = await r.json();
  const raw = Array.isArray(j.data) ? j.data : (j.data && j.data.data) || j.results || [];
  const list = raw.map(gifUrls).filter(Boolean);
  if (!list.length) console.warn(raw.length ? 'Klipy sent ' + raw.length + ' items but none were usable. Sample: ' + JSON.stringify(raw[0]).slice(0, 400) : 'Klipy sent no items. Top-level keys: ' + Object.keys(j).join(','));
  if (gifCache.size > 300) gifCache.clear();
  gifCache.set(key, { t: Date.now(), list });
  return list;
}
const ICE = (() => { try { return JSON.parse(process.env.ICE_SERVERS); } catch { return [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }]; } })();

// Saved data: global posts (with their photos), the global poll and the visitor counts go into one JSON file so they survive a restart.
// On Render the disk is wiped on every deploy unless a persistent disk is attached; point DATA_DIR at that disk to keep the file.
const DATA = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'tenrooms.json');
const ADMINS = new Set((process.env.ADMIN_CODES || process.env.ADMIN_CODE || 'PVRVHHKD').split(',').map(s => s.trim().toUpperCase()).filter(Boolean)); // friend codes that can run the global poll and delete any post
const store = { posts: [], gpoll: null, ever: [], today: [], day: '', seq: 0 };
try { Object.assign(store, JSON.parse(fs.readFileSync(DATA, 'utf8'))); } catch {}
if (!Array.isArray(store.posts)) store.posts = [];
const ever = new Set(store.ever), today = new Set(store.today); // friend codes seen ever, and seen on store.day
let saveTimer;
function save() { // written a moment after the last change, to a temp file first so a crash cannot leave half a file
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 2000);
}
function saveNow() {
  store.ever = [...ever]; store.today = [...today];
  try { fs.mkdirSync(path.dirname(DATA), { recursive: true }); fs.writeFileSync(DATA + '.tmp', JSON.stringify(store)); fs.renameSync(DATA + '.tmp', DATA); } catch (e) { console.warn('save failed:', e.message); }
}
['SIGTERM', 'SIGINT'].forEach(s => process.on(s, () => { saveNow(); process.exit(0); })); // a redeploy still keeps the last few seconds
const TZ = (() => { try { new Date().toLocaleDateString('en-CA', { timeZone: process.env.STATS_TZ }); return process.env.STATS_TZ; } catch { return ''; } })() || 'UTC'; // "today" rolls over at midnight in this time zone
function newDay() { const d = new Date().toLocaleDateString('en-CA', { timeZone: TZ }); if (d !== store.day) { store.day = d; today.clear(); } }
function seen(code) { newDay(); if (!today.has(code) || !ever.has(code)) { today.add(code); ever.add(code); save(); } } // a person is counted once per browser
function stats() { // "menu" = people online who are not inside a room, counted once however many tabs they have open
  newDay(); const menu = new Set();
  wss.clients.forEach(c => { if (c.name && !c.room) menu.add(c.code || 'ws' + c.id); });
  return { today: today.size, ever: ever.size, menu: menu.size };
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  const im = /^\/img\/(\d+)$/.exec(req.url); // a photo from a post
  if (im) {
    const p = store.posts.find(x => x.id === +im[1]);
    if (!p || !p.img) { res.writeHead(404); return res.end('No such image'); }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
    return res.end(Buffer.from(p.img, 'base64'));
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

const wss = new WebSocketServer({ server, maxPayload: 300 * 1024 }); // big enough for one compressed post photo
const rooms = ROOMS.map(([name, max], i) => ({ id: i + 1, name, max, topic: '', board: [], members: new Map(), chat: [], bans: new Map(), vote: null }));
let nextId = 1, msgSeq = 0;
const send = (ws, m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
const toRoom = (r, m, except) => r.members.forEach((p, id) => id !== except && send(p, m));
const lobby = () => rooms.map(r => ({ id: r.id, name: r.name, topic: r.topic, max: r.max, users: [...r.members.values()].map(p => p.name) }));
const pushLobby = () => { const l = lobby(), st = stats(); wss.clients.forEach(c => { if (c.name) { send(c, { type: 'lobby', rooms: l, stats: st }); presence(c); } }); };

// ---- posts ----
const postView = (p, ws) => ({ id: p.id, code: p.code, name: p.name, text: p.text, img: !!p.img, t: p.t, likes: p.likes.length, liked: !!ws.code && p.likes.includes(ws.code), comments: p.comments });
const toFeed = make => wss.clients.forEach(c => c.feed && send(c, make(c))); // only people with the Posts page open get updates
const recentView = () => store.posts.slice(-3).reverse().map(p => ({ id: p.id, name: p.name, code: p.code, text: p.text.slice(0, 90), img: !!p.img, t: p.t, likes: p.likes.length }));
const pushRecent = () => { const r = recentView(); wss.clients.forEach(c => c.name && send(c, { type: 'recent', posts: r })); }; // the "Latest posts" box in the menu
const pushPost = p => { toFeed(c => ({ type: 'post', post: postView(p, c) })); pushRecent(); };
function trimImages() { const w = store.posts.filter(p => p.img); w.slice(0, Math.max(0, w.length - 30)).forEach(p => { p.img = ''; }); } // only the newest 30 photos are kept, so the save file stays small
const gpollView = ws => store.gpoll && { id: store.gpoll.id, q: store.gpoll.q, opts: store.gpoll.opts.map(o => ({ t: o.t, n: o.v.length })), mine: store.gpoll.opts.findIndex(o => o.v.includes(ws.code)) };
const pushGpoll = () => wss.clients.forEach(c => c.name && send(c, { type: 'gpoll', poll: gpollView(c) }));

// Friends without accounts: each browser keeps a secret id and the server turns it into a short friend code.
// Friend lists live in the browsers. Two people count as friends once each has added the other's code.
const online = new Map(); // friend code -> the sockets using it right now (one per open tab)
function codeOf(key) { // the same secret always gives the same 8-character code, and the code cannot be turned back into the secret
  const h = crypto.createHash('sha256').update('tenrooms:' + key).digest(); let s = '';
  for (let i = 0; i < 8; i++) s += 'ABCDEFGHJKMNPQRSTVWXYZ23456789'[h[i] % 30];
  return s;
}
const socketsOf = code => [...(online.get(code) || [])];
const isFriend = (ws, code) => !!ws.friends && ws.friends.has(code);
const mutual = (ws, code) => isFriend(ws, code) && socketsOf(code).some(o => isFriend(o, ws.code));
function presence(ws) { // tell one person which of their friends are online and which room they are in
  if (!ws.code || !ws.friends) return;
  const list = [...ws.friends].filter(c => mutual(ws, c)).map(c => {
    const all = socketsOf(c), o = all.find(x => x.room) || all[0];
    return { code: c, name: o.name, room: o.room ? o.room.id : 0 };
  });
  send(ws, { type: 'presence', list });
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
    const until = Date.now() + BAN_MS; // kept out for 10 minutes: by friend code, or by name for someone without one
    r.bans.forEach((t, k) => { if (t < Date.now()) r.bans.delete(k); });
    if (target.code) r.bans.set('c:' + target.code, until); else r.bans.set('n:' + target.name.toLowerCase(), until);
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
  r.chat.push(m); if (r.chat.length > CHAT_KEEP) r.chat.shift();
  toRoom(r, { type: 'chat', msg: m });
}
const findMsg = (r, id) => r.chat.find(x => !x.system && x.id === id);
const newMsg = (ws, extra) => ({ id: ++msgSeq, name: ws.name, text: '', t: Date.now(), reacts: {}, ...extra });
function post(r, msg) { r.chat.push(msg); if (r.chat.length > CHAT_KEEP) r.chat.shift(); toRoom(r, { type: 'chat', msg }); }
const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);
const slow = (ws, key, ms) => { const now = Date.now(); if (now - (ws[key] || 0) < ms) return true; ws[key] = now; return false; }; // true = too soon, ignore it
const reEsc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function mentions(r, text) { // names in the room that the text @s; longest first so "@Sam 2" is not also read as "@Sam", and "@Sam" does not match inside "@Samantha"
  let low = text.toLowerCase(); const at = [];
  [...r.members.values()].map(p => p.name).sort((a, b) => b.length - a.length).forEach(n => {
    const re = new RegExp('@' + reEsc(n.toLowerCase()) + '(?![\\w])', 'g');
    if (re.test(low)) { at.push(n); low = low.replace(re, ' '); }
  });
  return at;
}
// Mini-games live inside a chat message (msg.game) and the server checks every move.
// secrets: hidden answers (rock-paper-scissors picks, the number to guess). seats: who holds each seat, by connection, not by name. draws: Quick Draw's countdown timers.
const GAMES = ['ttt', 'c4', 'rps', 'dice', 'guess', 'draw'], RPS = ['rock', 'paper', 'scissors'], secrets = new WeakMap(), seats = new WeakMap(), draws = new WeakMap();
const TTT = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
const d6 = () => 1 + Math.floor(Math.random() * 6);
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
function startDraw(r, msg) { // Quick Draw: after a random wait the screen says GO, and the first to press wins. Pressing early loses
  const g = msg.game; g.phase = 'wait';
  draws.set(msg, setTimeout(() => { if (g.win !== null) return; g.phase = 'go'; g.t0 = Date.now(); toRoom(r, { type: 'game', mid: msg.id, game: g }); }, 2000 + Math.random() * 3500));
}
function leave(ws) {
  const r = ws.room; if (!r) return;
  r.members.delete(ws.id); ws.room = null;
  toRoom(r, { type: 'peer-left', id: ws.id });
  say(r, `${ws.name} left`);
  if (r.vote) { r.vote.yes.delete(ws.id); r.vote.no.delete(ws.id); checkVote(r); }
  if (!r.members.size) { r.topic = ''; r.chat = []; r.board = []; } // empty room resets
  pushLobby();
}

wss.on('connection', (ws, req) => {
  ws.name = uniqueName(new URL(req.url, 'http://x').searchParams.get('name'));
  ws.id = nextId++; ws.room = null; ws.alive = true;
  ws.on('pong', () => ws.alive = true);
  send(ws, { type: 'hello', id: ws.id, name: ws.name, rooms: lobby(), ice: ICE, gifs: !!KLIPY, stats: stats(), recent: recentView() });
  pushLobby();

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'join') {
      const r = rooms[(m.room | 0) - 1]; if (!r) return;
      if (r.members.size >= r.max) return send(ws, { type: 'error', text: `${r.name} is full` });
      const banned = Math.max(r.bans.get('c:' + ws.code) || 0, r.bans.get('n:' + ws.name.toLowerCase()) || 0) - Date.now();
      if (banned > 0) return send(ws, { type: 'error', text: `You were voted out of ${r.name}. Try again in ${Math.ceil(banned / 60000)} min.` });
      leave(ws); ws.st = {};
      const peers = [...r.members.values()].map(p => ({ id: p.id, name: p.name, avatar: p.avatar, code: p.code, ...p.st }));
      r.members.set(ws.id, ws); ws.room = r;
      send(ws, { type: 'joined', room: r.id, name: r.name, max: r.max, topic: r.topic, board: r.board, peers, chat: r.chat, vote: voteInfo(r) });
      toRoom(r, { type: 'peer-joined', id: ws.id, name: ws.name, avatar: ws.avatar, code: ws.code, ...ws.st }, ws.id);
      say(r, `${ws.name} joined`); pushLobby();
    } else if (m.type === 'leave') leave(ws);
    else if (m.type === 'state' && ws.room) { // mute / camera-off status, shown on everyone's tiles
      ws.st = { muted: !!m.muted, camOff: !!m.camOff, sharing: !!m.sharing };
      toRoom(ws.room, { type: 'state', id: ws.id, ...ws.st }, ws.id);
    } else if (m.type === 'avatar') { // small JPEG profile picture, validated before it is shared
      const d = typeof m.data === 'string' && m.data.length < 30000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(m.data) ? m.data : '';
      ws.avatar = d; if (ws.room) toRoom(ws.room, { type: 'avatar', id: ws.id, data: d }, ws.id);
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
      ws.room.topic = t; toRoom(ws.room, { type: 'topic', text: t });
      say(ws.room, t ? `${ws.name} set the topic: ${t}` : `${ws.name} cleared the topic`); pushLobby();
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
      const text = gif ? '' : String(m.text || '').trim().slice(0, 500); if (!text && !gif) return;
      if (gif && slow(ws, 'lastGif', 1000)) return;
      const msg = newMsg(ws, { text }); if (gif) msg.gif = gif;
      const src = findMsg(ws.room, m.re); // the message this one replies to, if any
      if (src) msg.re = { id: src.id, name: src.name, text: src.text ? src.text.slice(0, 80) : src.gif ? 'GIF' : src.poll ? 'Poll' : 'Game' };
      const at = mentions(ws.room, text); if (at.length) msg.at = at;
      post(ws.room, msg);
    } else if (m.type === 'poll' && ws.room) { // a poll is a chat message with options people vote on
      const q = clean(m.q, 100), opts = (Array.isArray(m.opts) ? m.opts.slice(0, 6) : []).map(o => clean(o, 50)).filter(Boolean);
      if (!q || opts.length < 2 || slow(ws, 'lastPoll', 3000)) return;
      post(ws.room, newMsg(ws, { poll: { q, opts: opts.map(t => ({ t, v: [] })) } }));
    } else if (m.type === 'vote' && ws.room) { // one vote each: picking another option moves it, picking yours again removes it
      const msg = findMsg(ws.room, m.mid), p = msg && msg.poll, o = p && p.opts[m.opt | 0]; if (!o) return;
      const had = o.v.includes(ws.name);
      p.opts.forEach(x => { const i = x.v.indexOf(ws.name); if (i >= 0) x.v.splice(i, 1); });
      if (!had) o.v.push(ws.name);
      toRoom(ws.room, { type: 'poll', mid: msg.id, poll: p });
    } else if (m.type === 'luck' && ws.room) {
      if (slow(ws, 'lastLuck', 1000)) return;
      if (m.kind === 'roll') say(ws.room, `${ws.name} rolled a ${d6()}`);
      else if (m.kind === 'flip') say(ws.room, `${ws.name} flipped a coin: ${Math.random() < .5 ? 'heads' : 'tails'}`);
    } else if (m.type === 'game' && ws.room && GAMES.includes(m.kind)) { // start a game; most wait for a second player
      if (slow(ws, 'lastGame', 3000)) return;
      const g = { kind: m.kind, p: [ws.name], turn: 0, win: null };
      if (m.kind === 'ttt') g.b = Array(9).fill(null); else if (m.kind === 'c4') g.b = Array(42).fill(null);
      else if (m.kind === 'rps') g.done = [false, false]; else if (m.kind === 'dice') g.rolls = [null, null];
      else if (m.kind === 'guess') { g.lo = 1; g.hi = 50; g.log = []; } else g.phase = 'ready'; // Quick Draw starts once someone joins
      const msg = newMsg(ws, { game: g }); seats.set(msg, [ws.id]); if (m.kind === 'guess') secrets.set(msg, 1 + Math.floor(Math.random() * 50));
      post(ws.room, msg);
    } else if (m.type === 'gjoin' && ws.room) {
      const msg = findMsg(ws.room, m.mid), g = msg && msg.game, ids = (msg && seats.get(msg)) || [];
      if (!g || g.kind === 'guess' || g.p.length > 1 || ids[0] === ws.id) return;
      g.p.push(ws.name); ids.push(ws.id); seats.set(msg, ids);
      if (g.kind === 'draw') startDraw(ws.room, msg);
      toRoom(ws.room, { type: 'game', mid: msg.id, game: g });
    } else if (m.type === 'gmove' && ws.room) {
      const msg = findMsg(ws.room, m.mid), g = msg && msg.game; if (!g) return;
      if (g.kind === 'guess') { // anyone in the room can guess; each wrong guess narrows the range
        if (g.win !== null || slow(ws, 'lastGuess', 400)) return;
        const n = m.n | 0, s = secrets.get(msg); if (n < g.lo || n > g.hi) return;
        const hint = n === s ? 'correct' : n < s ? 'higher' : 'lower';
        if (n === s) { g.win = 0; g.by = ws.name; g.answer = s; } else if (n < s) g.lo = n + 1; else g.hi = n - 1;
        g.log.push({ name: ws.name, n, hint }); if (g.log.length > 6) g.log.shift();
        return toRoom(ws.room, { type: 'game', mid: msg.id, game: g });
      }
      const me = (seats.get(msg) || []).indexOf(ws.id);
      if (g.p.length < 2 || g.win !== null || me < 0) return;
      if (g.kind === 'rps') {
        if (!RPS.includes(m.pick) || g.done[me]) return;
        const s = secrets.get(msg) || []; s[me] = m.pick; secrets.set(msg, s); g.done[me] = true;
        if (g.done[0] && g.done[1]) { // both chose: show the picks. Each choice beats the one before it in RPS
          const d = (RPS.indexOf(s[0]) - RPS.indexOf(s[1]) + 3) % 3;
          g.picks = s; g.win = d === 0 ? 'draw' : d === 1 ? 0 : 1;
        }
      } else if (g.kind === 'dice') { // each player rolls two dice once; the bigger total wins
        if (g.rolls[me]) return;
        g.rolls[me] = [d6(), d6()];
        if (g.rolls[0] && g.rolls[1]) { const a = g.rolls[0][0] + g.rolls[0][1], b = g.rolls[1][0] + g.rolls[1][1]; g.win = a === b ? 'draw' : a > b ? 0 : 1; }
      } else if (g.kind === 'draw') {
        if (g.phase === 'wait') { clearTimeout(draws.get(msg)); g.win = 1 - me; g.early = true; } // jumped the gun
        else if (g.phase === 'go') { g.win = me; g.ms = Date.now() - g.t0; }
        else return;
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
    } else if (m.type === 'id') { // the browser's secret id, sent once after connecting
      if (ws.code || typeof m.key !== 'string' || !/^[a-f0-9]{32,64}$/.test(m.key)) return;
      ws.code = codeOf(m.key);
      if (!online.has(ws.code)) online.set(ws.code, new Set());
      online.get(ws.code).add(ws); seen(ws.code);
      send(ws, { type: 'me', code: ws.code, admin: ADMINS.has(ws.code) }); send(ws, { type: 'gpoll', poll: gpollView(ws) }); pushLobby();
    } else if (m.type === 'friends' && ws.code && Array.isArray(m.codes)) { // this browser's whole friend list, sent again whenever it changes
      ws.friends = new Set(m.codes.slice(0, 100).filter(c => typeof c === 'string' && /^[A-Z2-9]{8}$/.test(c) && c !== ws.code));
      wss.clients.forEach(o => { // anyone who has added one side but not the other gets asked to add them back
        if (!o.code || o === ws || o.code === ws.code) return;
        if (isFriend(ws, o.code) && !isFriend(o, ws.code)) send(o, { type: 'friend-req', code: ws.code, name: ws.name });
        if (isFriend(o, ws.code) && !isFriend(ws, o.code)) send(ws, { type: 'friend-req', code: o.code, name: o.name });
      });
      pushLobby();
    } else if (m.type === 'dm' && ws.code) { // direct message: passed straight on, never stored here
      const text = String(m.text || '').trim().slice(0, 500); if (!text || slow(ws, 'lastDm', 300)) return;
      if (!mutual(ws, m.to)) return send(ws, { type: 'dm-fail', text: 'Not sent: they are offline or have not added you back' });
      const t = Date.now();
      socketsOf(m.to).forEach(o => { if (isFriend(o, ws.code)) send(o, { type: 'dm', from: ws.code, name: ws.name, text, t }); });
      socketsOf(ws.code).forEach(o => send(o, { type: 'dm', to: m.to, text, t }));
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
      const text = String(m.text || '').replace(/[\u0000-\u0009\u000b-\u001f]/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 500);
      let img = ''; // an optional photo: a JPEG the browser already shrank, checked here before it is kept
      if (typeof m.img === 'string' && m.img) {
        const mm = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(m.img);
        const buf = mm && mm[1].length <= 220000 ? Buffer.from(mm[1], 'base64') : null;
        if (!buf || buf[0] !== 0xff || buf[1] !== 0xd8) return send(ws, { type: 'error', text: 'That photo could not be used. Try a smaller one' });
        img = mm[1];
      }
      if (!text && !img) return;
      if (slow(ws, 'lastPost', 10000)) return send(ws, { type: 'error', text: 'Wait a few seconds before posting again' });
      const p = { id: ++store.seq, code: ws.code, name: ws.name, text, img, t: Date.now(), likes: [], comments: [] };
      store.posts.push(p); if (store.posts.length > 200) store.posts.shift(); trimImages();
      save(); pushPost(p);
      wss.clients.forEach(c => { if (c !== ws && c.name && c.code !== ws.code && isFriend(c, ws.code)) send(c, { type: 'post-note', name: ws.name, code: ws.code, text: text.slice(0, 80) || 'shared a photo' }); }); // friends of the poster get a pop-up
    } else if (m.type === 'post-like' && ws.code) {
      const p = store.posts.find(x => x.id === m.id); if (!p || slow(ws, 'lastLike', 150)) return;
      const i = p.likes.indexOf(ws.code); if (i >= 0) p.likes.splice(i, 1); else p.likes.push(ws.code);
      save(); pushPost(p);
    } else if (m.type === 'post-comment' && ws.code) {
      const p = store.posts.find(x => x.id === m.id), text = clean(m.text, 300); if (!p || !text || p.comments.length >= 100) return;
      if (slow(ws, 'lastCom', 3000)) return send(ws, { type: 'error', text: 'Wait a few seconds before commenting again' });
      p.comments.push({ id: ++store.seq, code: ws.code, name: ws.name, text, t: Date.now() });
      save(); pushPost(p);
    } else if (m.type === 'post-del' && ws.code) { // your own post or comment, a comment on your post, or anything if you are an admin
      const p = store.posts.find(x => x.id === m.id), boss = ADMINS.has(ws.code); if (!p) return;
      if (m.cid) {
        const c = p.comments.find(x => x.id === m.cid); if (!c || !(boss || c.code === ws.code || p.code === ws.code)) return;
        p.comments.splice(p.comments.indexOf(c), 1); save(); pushPost(p);
      } else if (boss || p.code === ws.code) { store.posts.splice(store.posts.indexOf(p), 1); save(); toFeed(() => ({ type: 'post-del', id: p.id })); pushRecent(); }
    }
  });
  ws.on('close', () => {
    leave(ws); ws.name = null;
    const set = online.get(ws.code);
    if (set) { set.delete(ws); if (!set.size) online.delete(ws.code); }
    pushLobby(); // friends see them go offline, and the menu count drops
  });
});
setInterval(() => wss.clients.forEach(c => { if (!c.alive) return c.terminate(); c.alive = false; c.ping(); }), 30000);
server.listen(PORT, () => console.log(`Ten Rooms running on port ${PORT}`));
