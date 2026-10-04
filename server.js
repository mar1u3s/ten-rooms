// Ten Rooms: lobby + signaling server. Video/audio go browser-to-browser (WebRTC); this only handles names, rooms, handshakes and chat.
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000, MAX = 6;
const NAMES = ['Lounge','Studio','Kitchen','Garage','Rooftop','Library','Arcade','Garden','Workshop','Porch'];
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

const wss = new WebSocketServer({ server });
const rooms = NAMES.map((name, i) => ({ id: i + 1, name, members: new Map(), chat: [] }));
let nextId = 1;
const send = (ws, m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
const toRoom = (r, m, except) => r.members.forEach((p, id) => id !== except && send(p, m));
const lobby = () => rooms.map(r => ({ id: r.id, name: r.name, max: MAX, users: [...r.members.values()].map(p => p.name) }));
const pushLobby = () => wss.clients.forEach(c => c.name && send(c, { type: 'lobby', rooms: lobby() }));

function uniqueName(raw) { // two people can't share a name: "Sam" becomes "Sam 2"
  const base = String(raw || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 20) || 'Guest';
  const taken = new Set([...wss.clients].filter(c => c.name).map(c => c.name.toLowerCase()));
  let n = base, i = 2;
  while (taken.has(n.toLowerCase())) n = `${base} ${i++}`;
  return n;
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
  say(r, `${ws.name} left`); pushLobby();
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
      if (r.members.size >= MAX) return send(ws, { type: 'error', text: `${r.name} is full` });
      leave(ws);
      const peers = [...r.members.values()].map(p => ({ id: p.id, name: p.name, muted: p.muted, camOff: p.camOff }));
      r.members.set(ws.id, ws); ws.room = r;
      send(ws, { type: 'joined', room: r.id, name: r.name, peers, chat: r.chat });
      toRoom(r, { type: 'peer-joined', id: ws.id, name: ws.name, muted: ws.muted, camOff: ws.camOff }, ws.id);
      say(r, `${ws.name} joined`); pushLobby();
    } else if (m.type === 'leave') leave(ws);
    else if (m.type === 'state' && ws.room) { // mute / camera-off status, shown on everyone's tiles
      ws.muted = !!m.muted; ws.camOff = !!m.camOff;
      toRoom(ws.room, { type: 'state', id: ws.id, muted: ws.muted, camOff: ws.camOff }, ws.id);
    }
    else if (m.type === 'signal' && ws.room) {
      const to = ws.room.members.get(m.to);
      if (to) send(to, { type: 'signal', from: ws.id, data: m.data });
    } else if (m.type === 'chat' && ws.room) {
      const text = String(m.text || '').trim().slice(0, 500); if (!text) return;
      const msg = { name: ws.name, text, t: Date.now() };
      ws.room.chat.push(msg); if (ws.room.chat.length > 50) ws.room.chat.shift();
      toRoom(ws.room, { type: 'chat', msg });
    }
  });
  ws.on('close', () => { leave(ws); ws.name = null; });
});
setInterval(() => wss.clients.forEach(c => { if (!c.alive) return c.terminate(); c.alive = false; c.ping(); }), 30000);
server.listen(PORT, () => console.log(`Ten Rooms running on port ${PORT}`));
