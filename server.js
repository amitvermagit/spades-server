const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Spades Royale Server Running ♠');
});

const wss = new WebSocket.Server({ server, verifyClient: () => true });

// rooms: { roomId: { state, players: { ws, playerIndex }[] } }
const rooms = {};

function getRoomClients(roomId) {
  if (!rooms[roomId]) return [];
  return rooms[roomId].players.filter(p => p.ws.readyState === WebSocket.OPEN);
}

function sendTo(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(data)); } catch(e) {}
  }
}

function broadcastRoom(roomId, data) {
  getRoomClients(roomId).forEach(p => sendTo(p.ws, data));
}

wss.on('connection', (ws) => {
  let currentRoom = null;
  let myPlayerIndex = -1; // -1 = admin

  // Keepalive ping every 25s
  const ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 25000);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch(e) { return; }
    const { type, roomId } = msg;

    // ── CREATE (admin) ──
    if (type === 'create') {
      currentRoom = roomId;
      myPlayerIndex = -1;
      rooms[roomId] = {
        state: msg.state,
        players: [{ ws, playerIndex: -1 }]  // admin is -1
      };
      sendTo(ws, { type: 'created', roomId });
      console.log(`[${roomId}] Room created`);
      return;
    }

    // ── JOIN (player) ──
    if (type === 'join') {
      const room = rooms[roomId];
      if (!room) {
        sendTo(ws, { type: 'error', msg: 'Room not found. Make sure admin has created the game first.' });
        return;
      }
      const state = room.state;
      const si = state.codes ? state.codes.indexOf(msg.code) : -1;
      if (si < 0) {
        sendTo(ws, { type: 'error', msg: 'Invalid code. Double-check with admin.' });
        return;
      }
      const pi = si + 1;
      if (state.players[pi].name && state.players[pi].name !== msg.name) {
        sendTo(ws, { type: 'error', msg: 'Slot already taken by ' + state.players[pi].name });
        return;
      }

      currentRoom = roomId;
      myPlayerIndex = pi;

      // Remove any old entry for this playerIndex (reconnect case)
      room.players = room.players.filter(p => p.playerIndex !== pi);
      room.players.push({ ws, playerIndex: pi });

      // Update state
      state.players[pi].name = msg.name;
      room.state = state;

      // Tell this player they joined
      sendTo(ws, { type: 'joined', playerIndex: pi, state });

      // Tell everyone the updated state
      broadcastRoom(roomId, { type: 'state', state });
      console.log(`[${roomId}] ${msg.name} joined as P${pi} — ${room.players.length} connected`);
      return;
    }

    // ── REJOIN (player reconnecting) ──
    if (type === 'rejoin') {
      const room = rooms[roomId];
      if (!room) { sendTo(ws, { type: 'error', msg: 'Room no longer exists.' }); return; }
      currentRoom = roomId;
      myPlayerIndex = msg.playerIndex;
      room.players = room.players.filter(p => p.playerIndex !== myPlayerIndex);
      room.players.push({ ws, playerIndex: myPlayerIndex });
      sendTo(ws, { type: 'rejoined', playerIndex: myPlayerIndex, state: room.state });
      console.log(`[${roomId}] P${myPlayerIndex} rejoined`);
      return;
    }

    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];

    // ── ACTION (player → admin) ──
    if (type === 'action') {
      // Forward to admin (playerIndex === -1)
      const adminEntry = room.players.find(p => p.playerIndex === -1);
      if (adminEntry) sendTo(adminEntry.ws, msg);
      return;
    }

    // ── STATE (admin → everyone) ──
    if (type === 'state') {
      room.state = msg.state;
      broadcastRoom(currentRoom, { type: 'state', state: msg.state });
      console.log(`[${currentRoom}] State pushed to ${getRoomClients(currentRoom).length} clients, phase: ${msg.state.phase}, bidTurn: ${msg.state.bidTurn}`);
      return;
    }
  });

  ws.on('close', () => {
    clearInterval(ping);
    if (currentRoom && rooms[currentRoom]) {
      // Don't remove — keep slot so player can rejoin
      console.log(`[${currentRoom}] P${myPlayerIndex} disconnected`);
      // Clean up room only if completely empty after delay
      setTimeout(() => {
        if (rooms[currentRoom]) {
          const alive = getRoomClients(currentRoom).length;
          if (alive === 0) { delete rooms[currentRoom]; console.log(`[${currentRoom}] Room cleaned up`); }
        }
      }, 120000);
    }
  });

  ws.on('error', () => {});
});

// Heartbeat log
setInterval(() => {
  const roomCount = Object.keys(rooms).length;
  if (roomCount > 0) console.log(`Heartbeat: ${roomCount} rooms, ${wss.clients.size} clients`);
}, 30000);

server.listen(PORT, () => console.log(`♠ Spades Royale on port ${PORT}`));
