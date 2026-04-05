const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Spades Royale Server Running');
});

const wss = new WebSocket.Server({ server });

// rooms: { roomId: { state: {}, clients: Set<ws> } }
const rooms = {};

function broadcast(roomId, data, excludeWs = null) {
  const room = rooms[roomId];
  if (!room) return;
  const msg = JSON.stringify(data);
  room.clients.forEach(client => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

function broadcastAll(roomId, data) {
  const room = rooms[roomId];
  if (!room) return;
  const msg = JSON.stringify(data);
  room.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

wss.on('connection', (ws) => {
  let currentRoom = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    const { type, roomId } = msg;

    // ── CREATE ROOM ──
    if (type === 'create') {
      currentRoom = roomId;
      rooms[roomId] = { state: msg.state, clients: new Set([ws]) };
      ws.send(JSON.stringify({ type: 'created', roomId }));
      return;
    }

    // ── JOIN ROOM ──
    if (type === 'join') {
      const room = rooms[roomId];
      if (!room) {
        ws.send(JSON.stringify({ type: 'error', msg: 'Room not found. Check Room ID.' }));
        return;
      }
      // Validate code
      const state = room.state;
      const si = state.codes.indexOf(msg.code);
      if (si < 0) {
        ws.send(JSON.stringify({ type: 'error', msg: 'Invalid code. Check with admin.' }));
        return;
      }
      const pi = si + 1;
      if (state.players[pi].name && state.players[pi].name !== msg.name) {
        ws.send(JSON.stringify({ type: 'error', msg: 'Slot already taken.' }));
        return;
      }

      // Register player
      currentRoom = roomId;
      room.clients.add(ws);
      state.players[pi].name = msg.name;

      // Tell player their index and send full state
      ws.send(JSON.stringify({ type: 'joined', playerIndex: pi, state }));

      // Tell admin a player joined (send updated state to all)
      broadcastAll(roomId, { type: 'state', state });
      return;
    }

    // ── ALL OTHER MESSAGES: forward to room ──
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];

    if (type === 'action') {
      // Admin processes action and sends back updated state
      // Just broadcast the action to admin (first client = admin)
      const clients = [...room.clients];
      if (clients[0] && clients[0].readyState === WebSocket.OPEN) {
        clients[0].send(JSON.stringify(msg)); // send to admin
      }
      return;
    }

    if (type === 'state') {
      // Admin broadcasting updated state to all players
      room.state = msg.state;
      broadcast(currentRoom, { type: 'state', state: msg.state }, ws);
      return;
    }
  });

  ws.on('close', () => {
    if (currentRoom && rooms[currentRoom]) {
      rooms[currentRoom].clients.delete(ws);
      // Clean up empty rooms
      if (rooms[currentRoom].clients.size === 0) {
        delete rooms[currentRoom];
      }
    }
  });

  ws.on('error', () => {});
});

server.listen(PORT, () => {
  console.log(`Spades Royale server running on port ${PORT}`);
});
