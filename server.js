const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  // Allow CORS for all origins
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Spades Royale Server Running ♠');
});

const wss = new WebSocket.Server({ 
  server,
  // Allow connections from any origin
  verifyClient: () => true
});

// rooms: { roomId: { state: {}, clients: Set<ws>, adminWs: ws } }
const rooms = {};

function broadcastAll(roomId, data) {
  const room = rooms[roomId];
  if (!room) return;
  const msg = JSON.stringify(data);
  room.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(msg); } catch(e) {}
    }
  });
}

function broadcastExcept(roomId, data, excludeWs) {
  const room = rooms[roomId];
  if (!room) return;
  const msg = JSON.stringify(data);
  room.clients.forEach(client => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      try { client.send(msg); } catch(e) {}
    }
  });
}

wss.on('connection', (ws, req) => {
  let currentRoom = null;
  let pingInterval = null;

  // Keep connection alive with ping/pong
  pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 25000);

  ws.on('pong', () => { /* still alive */ });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    const { type, roomId } = msg;

    // ── CREATE ROOM (admin) ──
    if (type === 'create') {
      currentRoom = roomId;
      rooms[roomId] = { 
        state: msg.state, 
        clients: new Set([ws]),
        adminWs: ws  // track who is admin
      };
      ws.send(JSON.stringify({ type: 'created', roomId }));
      console.log(`Room created: ${roomId}`);
      return;
    }

    // ── JOIN ROOM (player) ──
    if (type === 'join') {
      const room = rooms[roomId];
      if (!room) {
        ws.send(JSON.stringify({ type: 'error', msg: 'Room not found. Ask admin to check their connection and share the Room ID again.' }));
        return;
      }

      const state = room.state;
      const si = state.codes ? state.codes.indexOf(msg.code) : -1;
      if (si < 0) {
        ws.send(JSON.stringify({ type: 'error', msg: 'Invalid code. Double-check with admin.' }));
        return;
      }
      const pi = si + 1;
      if (state.players[pi].name && state.players[pi].name !== msg.name) {
        ws.send(JSON.stringify({ type: 'error', msg: 'This slot is already taken by ' + state.players[pi].name }));
        return;
      }

      currentRoom = roomId;
      room.clients.add(ws);
      state.players[pi].name = msg.name;

      // Confirm join to this player
      ws.send(JSON.stringify({ type: 'joined', playerIndex: pi, state }));

      // Notify everyone (including admin) of updated state
      broadcastAll(roomId, { type: 'state', state });
      console.log(`Player ${msg.name} joined room ${roomId} as P${pi}`);
      return;
    }

    // ── RECONNECT (player rejoining after disconnect) ──
    if (type === 'rejoin') {
      const room = rooms[roomId];
      if (!room) { ws.send(JSON.stringify({ type: 'error', msg: 'Room no longer exists.' })); return; }
      currentRoom = roomId;
      room.clients.add(ws);
      // Send current state
      ws.send(JSON.stringify({ type: 'rejoined', playerIndex: msg.playerIndex, state: room.state }));
      return;
    }

    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];

    // ── ACTION (player → admin) ──
    if (type === 'action') {
      // Forward to admin
      if (room.adminWs && room.adminWs.readyState === WebSocket.OPEN) {
        try { room.adminWs.send(JSON.stringify(msg)); } catch(e) {}
      }
      return;
    }

    // ── STATE UPDATE (admin → all players) ──
    if (type === 'state') {
      room.state = msg.state;
      // Send to ALL clients including admin so everyone is in sync
      broadcastAll(currentRoom, { type: 'state', state: msg.state });
      return;
    }
  });

  ws.on('close', () => {
    clearInterval(pingInterval);
    if (currentRoom && rooms[currentRoom]) {
      rooms[currentRoom].clients.delete(ws);
      console.log(`Client left room ${currentRoom}, ${rooms[currentRoom].clients.size} remaining`);
      // Clean up empty rooms after delay (give admin time to reconnect)
      setTimeout(() => {
        if (rooms[currentRoom] && rooms[currentRoom].clients.size === 0) {
          delete rooms[currentRoom];
          console.log(`Room ${currentRoom} cleaned up`);
        }
      }, 60000);
    }
  });

  ws.on('error', (err) => {
    console.log('WS error:', err.message);
  });
});

// Keep-alive: prevent Render free tier from sleeping
setInterval(() => {
  console.log(`Heartbeat — ${Object.keys(rooms).length} active rooms, ${wss.clients.size} clients`);
}, 30000);

server.listen(PORT, () => {
  console.log(`♠ Spades Royale server running on port ${PORT}`);
});
