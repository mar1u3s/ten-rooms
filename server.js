// Ten Rooms: lobby + signaling server. Video/audio go browser-to-browser (WebRTC); this only handles names, rooms, handshakes and chat.
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

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
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
const pushLobby = () => { const l = lobby(); wss.clients.forEach(c => { if (c.name) { send(c, { type: 'lobby', rooms: l }); presence(c); } }); };

// Friends without accounts: each browser keeps a secret id and the server turns it into a short friend code.
// Nothing here is saved; friend lists live in the browsers. Two people count as friends once each has added the other's code.
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
const GAMES = ['ttt', 'c4', 'rps'], RPS = ['rock', 'paper', 'scissors'], secrets = new WeakMap(); // secrets: rock-paper-scissors picks, hidden until both have chosen
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
  send(ws, { type: 'hello', id: ws.id, name: ws.name, rooms: lobby(), ice: ICE, gifs: !!KLIPY });
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
      if (m.kind === 'roll') say(ws.room, `${ws.name} rolled a ${1 + Math.floor(Math.random() * 6)}`);
      else if (m.kind === 'flip') say(ws.room, `${ws.name} flipped a coin: ${Math.random() < .5 ? 'heads' : 'tails'}`);
    } else if (m.type === 'game' && ws.room && GAMES.includes(m.kind)) { // start a game; it waits for a second player
      if (slow(ws, 'lastGame', 3000)) return;
      const g = { kind: m.kind, p: [ws.name], turn: 0, win: null };
      if (m.kind === 'ttt') g.b = Array(9).fill(null); else if (m.kind === 'c4') g.b = Array(42).fill(null); else g.done = [false, false];
      post(ws.room, newMsg(ws, { game: g }));
    } else if (m.type === 'gjoin' && ws.room) {
      const msg = findMsg(ws.room, m.mid), g = msg && msg.game;
      if (!g || g.p.length > 1 || g.p[0] === ws.name) return;
      g.p.push(ws.name); toRoom(ws.room, { type: 'game', mid: msg.id, game: g });
    } else if (m.type === 'gmove' && ws.room) {
      const msg = findMsg(ws.room, m.mid), g = msg && msg.game, me = g ? g.p.indexOf(ws.name) : -1;
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
      online.get(ws.code).add(ws); send(ws, { type: 'me', code: ws.code });
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
    }
  });
  ws.on('close', () => {
    leave(ws); ws.name = null;
    const set = online.get(ws.code);
    if (set) { set.delete(ws); if (!set.size) online.delete(ws.code); pushLobby(); } // friends see them go offline
  });
});
setInterval(() => wss.clients.forEach(c => { if (!c.alive) return c.terminate(); c.alive = false; c.ping(); }), 30000);
server.listen(PORT, () => console.log(`Ten Rooms running on port ${PORT}`));
