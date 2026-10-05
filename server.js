// Ten Rooms: lobby + signaling server. Video/audio go browser-to-browser (WebRTC); this only handles names, rooms, handshakes and chat.
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000, REACTS = ['👍', '😂', '🎉', '👏', '🔥', '💜'];
// [name, max people]. Small rooms keep full video; bigger rooms get lower per-person video quality (see tune() in index.html).
const ROOMS = [['Lounge', 6], ['Studio', 6], ['Kitchen', 6], ['Garage', 10], ['Rooftop', 10], ['Library', 15], ['Arcade', 15], ['Workshop', 15], ['Garden', 50], ['Porch', 50]];
const ICE = (() => { try { return JSON.parse(process.env.ICE_SERVERS); } catch { return [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }]; } })();

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  if (req.url === '/' || req.url.startsWith('/?')) {
    return fs.readFile(path.join(__dirname, 'index.html'), (e, d) => {
      res.writeHead(e ? 500 : 200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(e ? 'index.html missing' : d);
    });
  }
  res.writeHead(404); res.end('Not found');
});

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
const rooms = ROOMS.map(([name, max], i) => ({ id: i + 1, name, max, topic: '', board: [], members: new Map(), chat: [] }));
let nextId = 1, msgSeq = 0;
const send = (ws, m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
const toRoom = (r, m, except) => r.members.forEach((p, id) => id !== except && send(p, m));
const lobby = () => rooms.map(r => ({ id: r.id, name: r.name, topic: r.topic, max: r.max, users: [...r.members.values()].map(p => p.name) }));
const pushLobby = () => wss.clients.forEach(c => c.name && send(c, { type: 'lobby', rooms: lobby() }));

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
function leave(ws) {
  const r = ws.room; if (!r) return;
  r.members.delete(ws.id); ws.room = null;
  toRoom(r, { type: 'peer-left', id: ws.id });
  say(r, `${ws.name} left`);
  if (!r.members.size) { r.topic = ''; r.chat = []; r.board = []; } // empty room resets
  pushLobby();
}

wss.on('connection', (ws, req) => {
  ws.name = uniqueName(new URL(req.url, 'http://x').searchParams.get('name'));
  ws.id = nextId++; ws.room = null; ws.alive = true;
  ws.on('pong', () => ws.alive = true);
  send(ws, { type: 'hello', id: ws.id, name: ws.name, rooms: lobby(), ice: ICE });
  pushLobby();

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'join') {
      const r = rooms[(m.room | 0) - 1]; if (!r) return;
      if (r.members.size >= r.max) return send(ws, { type: 'error', text: `${r.name} is full` });
      leave(ws); ws.st = {};
      const peers = [...r.members.values()].map(p => ({ id: p.id, name: p.name, avatar: p.avatar, ...p.st }));
      r.members.set(ws.id, ws); ws.room = r;
      send(ws, { type: 'joined', room: r.id, name: r.name, max: r.max, topic: r.topic, board: r.board, peers, chat: r.chat });
      toRoom(r, { type: 'peer-joined', id: ws.id, name: ws.name, avatar: ws.avatar, ...ws.st }, ws.id);
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
      const msg = ws.room.chat.find(x => x.id === m.mid); if (!msg) return;
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
      const text = String(m.text || '').trim().slice(0, 500); if (!text) return;
      const msg = { id: ++msgSeq, name: ws.name, text, t: Date.now(), reacts: {} };
      ws.room.chat.push(msg); if (ws.room.chat.length > 50) ws.room.chat.shift();
      toRoom(ws.room, { type: 'chat', msg });
    }
  });
  ws.on('close', () => { leave(ws); ws.name = null; });
});
setInterval(() => wss.clients.forEach(c => { if (!c.alive) return c.terminate(); c.alive = false; c.ping(); }), 30000);
server.listen(PORT, () => console.log(`Ten Rooms running on port ${PORT}`));
