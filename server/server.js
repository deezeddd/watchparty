// WatchParty signaling server.
// Relays playback-sync events, chat, and WebRTC signaling between
// clients in the same room. No media ever passes through here.

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8787;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('WatchParty signaling server. Connect via WebSocket.\n');
});

const wss = new WebSocketServer({ server });

// room -> Map<clientId, ws>
const rooms = new Map();

function roomOf(ws) {
  return rooms.get(ws.room);
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(ws, obj, includeSelf = false) {
  const room = roomOf(ws);
  if (!room) return;
  for (const [id, peer] of room) {
    if (!includeSelf && id === ws.id) continue;
    send(peer, obj);
  }
}

wss.on('connection', (ws) => {
  ws.id = crypto.randomBytes(6).toString('hex');
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'join': {
        const roomId = String(msg.room || '').slice(0, 32);
        if (!roomId) return;
        ws.room = roomId;
        ws.name = String(msg.name || 'Guest').slice(0, 40);
        if (!rooms.has(roomId)) rooms.set(roomId, new Map());
        const room = rooms.get(roomId);
        const peers = [...room.entries()].map(([id, p]) => ({ id, name: p.name }));
        room.set(ws.id, ws);
        send(ws, { type: 'joined', selfId: ws.id, room: roomId, peers });
        broadcast(ws, { type: 'peer-joined', id: ws.id, name: ws.name });
        break;
      }

      // Room-wide relays: playback sync, chat, call membership.
      case 'sync':
      case 'chat':
      case 'call':
      case 'state-request': {
        if (!ws.room) return;
        broadcast(ws, { ...msg, from: ws.id, name: ws.name });
        break;
      }

      // Directed relays: WebRTC signaling and playback state replies.
      case 'signal':
      case 'state': {
        const room = roomOf(ws);
        if (!room) return;
        const target = room.get(msg.to);
        if (target) send(target, { ...msg, from: ws.id, name: ws.name });
        break;
      }
    }
  });

  ws.on('close', () => {
    const room = roomOf(ws);
    if (!room) return;
    room.delete(ws.id);
    broadcast(ws, { type: 'peer-left', id: ws.id, name: ws.name }, true);
    if (room.size === 0) rooms.delete(ws.room);
  });
});

// Drop dead connections so rooms don't fill with ghosts.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`WatchParty signaling server listening on :${PORT}`);
});
