const WebSocket = require('ws');
const http = require('http');
const PORT = process.env.PORT || 3000;

const server = http.createServer((req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.writeHead(200,{'Content-Type':'text/plain'});
  res.end('Spades Royale ♠ — Running');
});

const wss = new WebSocket.Server({server, verifyClient:()=>true});
const rooms = {};

// ── UTILS ──
function send(ws, data){
  if(ws&&ws.readyState===1) try{ws.send(JSON.stringify(data));}catch(e){}
}

function sendStateToAll(roomId){
  const r=rooms[roomId]; if(!r) return;
  r.players.filter(p=>p.ws.readyState===1).forEach(p=>{
    const view=JSON.parse(JSON.stringify(r.state));
    if(p.playerIndex>=0){
      view.hands=view.hands.map((h,i)=>i===p.playerIndex?h:h.map(()=>({hidden:true})));
    }
    view.myIndex=p.playerIndex;
    send(p.ws,{type:'state',state:view});
  });
}

// ── CARD UTILS ──
function genDeck(){
  const S=['♠','♥','♦','♣'],R=['2','3','4','5','6','7','8','9','10','J','Q','K','A'],d=[];
  for(const s of S)for(const r of R)d.push({s,r});
  for(let i=d.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[d[i],d[j]]=[d[j],d[i]];}
  return d;
}
function cardVal(c){
  return({'♠':4,'♥':3,'♦':2,'♣':1}[c.s])*100+({'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14}[c.r]);
}
function trickWinner(trick,leader){
  let w=leader,wc=trick[leader];
  for(let i=0;i<4;i++){
    if(i===leader)continue;
    const c=trick[i];
    if(c.s==='♠'&&wc.s!=='♠'){w=i;wc=c;}
    else if(c.s===wc.s&&cardVal(c)>cardVal(wc)){w=i;wc=c;}
  }
  return w;
}

// ── ROOM CLEANUP ──
function scheduleRoomCleanup(roomId, delayMs){
  setTimeout(()=>{
    if(!rooms[roomId]) return;
    const alive=rooms[roomId].players.filter(p=>p.ws.readyState===1).length;
    if(alive===0){
      delete rooms[roomId];
      console.log(`[${roomId}] Room cleaned up (no alive connections)`);
    }
  }, delayMs);
}

// Expire abandoned rooms after 2 hours regardless
function setRoomExpiry(roomId){
  setTimeout(()=>{
    if(rooms[roomId]){
      delete rooms[roomId];
      console.log(`[${roomId}] Room expired (2hr limit)`);
    }
  }, 2*60*60*1000);
}

// ── WEBSOCKET ──
wss.on('connection',(ws)=>{
  let roomId=null, playerIndex=-1;
  let isAlive=true;

  // Ping every 25s; terminate if no pong received (dead connection)
  const pingInterval=setInterval(()=>{
    if(!isAlive){
      console.log(`[${roomId}] P${playerIndex} — no pong, terminating`);
      ws.terminate();
      return;
    }
    isAlive=false;
    if(ws.readyState===1) ws.ping();
  }, 25000);

  ws.on('pong',()=>{ isAlive=true; });

  ws.on('message',(raw)=>{
    isAlive=true; // any message counts as alive
    let msg; try{msg=JSON.parse(raw);}catch(e){return;}

    // ── CREATE (admin) ──
    if(msg.type==='create'){
      roomId=msg.roomId; playerIndex=-1;
      const d=genDeck();
      rooms[roomId]={
        state:{
          phase:'waiting', round:1, codes:msg.codes,
          players:[
            {name:msg.adminName,score:0,bid:-1,tricks:0},
            {name:'',score:0,bid:-1,tricks:0},
            {name:'',score:0,bid:-1,tricks:0},
            {name:'',score:0,bid:-1,tricks:0}
          ],
          hands:[d.slice(0,13),d.slice(13,26),d.slice(26,39),d.slice(39,52)],
          currentTrick:[null,null,null,null],trickLeader:0,
          bidOrder:[0,1,2,3],bidTurn:0,totalBids:0,
          trickCount:0,turnIndex:-1,trickResult:null,endGame:false
        },
        players:[{ws,playerIndex:-1}],
        createdAt:Date.now()
      };
      setRoomExpiry(roomId);
      send(ws,{type:'created',roomId});
      sendStateToAll(roomId);
      console.log(`[${roomId}] Created by ${msg.adminName}`);
      return;
    }

    // ── JOIN (player) ──
    if(msg.type==='join'){
      const r=rooms[msg.roomId];
      if(!r){send(ws,{type:'error',msg:'Room not found. Ask admin to check connection.'});return;}
      const si=r.state.codes.indexOf(msg.code);
      if(si<0){send(ws,{type:'error',msg:'Invalid code.'});return;}
      const pi=si+1;
      if(r.state.players[pi].name&&r.state.players[pi].name!==msg.name){
        send(ws,{type:'error',msg:'Slot taken by '+r.state.players[pi].name});return;
      }
      roomId=msg.roomId; playerIndex=pi;
      r.players=r.players.filter(p=>p.playerIndex!==pi);
      r.players.push({ws,playerIndex:pi});
      r.state.players[pi].name=msg.name;
      send(ws,{type:'joined',playerIndex:pi});
      sendStateToAll(roomId);
      console.log(`[${roomId}] ${msg.name} joined as P${pi}`);
      return;
    }

    // ── REJOIN ──
    if(msg.type==='rejoin'){
      const r=rooms[msg.roomId];
      if(!r){send(ws,{type:'error',msg:'Room no longer exists.'});return;}
      roomId=msg.roomId; playerIndex=msg.playerIndex;
      r.players=r.players.filter(p=>p.playerIndex!==playerIndex);
      r.players.push({ws,playerIndex});
      send(ws,{type:'rejoined',playerIndex});
      sendStateToAll(roomId);
      console.log(`[${roomId}] P${playerIndex} rejoined`);
      return;
    }

    if(!roomId||!rooms[roomId]) return;
    const r=rooms[roomId];
    const G=r.state;

    // ── START ──
    if(msg.type==='start'){
      if(G.phase!=='waiting') return;
      const d=genDeck();
      G.phase='bidding';
      G.hands=[d.slice(0,13),d.slice(13,26),d.slice(26,39),d.slice(39,52)];
      G.bidOrder=[0,1,2,3]; G.bidTurn=0; G.totalBids=0;
      G.currentTrick=[null,null,null,null]; G.trickLeader=0;
      G.trickCount=0; G.turnIndex=-1; G.trickResult=null;
      G.players.forEach(p=>{p.bid=-1;p.tricks=0;});
      sendStateToAll(roomId);
      console.log(`[${roomId}] Game started`);
      return;
    }

    // ── BID ──
    if(msg.type==='bid'){
      const pi=msg.playerIndex, bid=Number(msg.bid);
      if(G.phase!=='bidding') return;
      if(G.bidOrder[G.bidTurn]!==pi||G.players[pi].bid>=0) return;
      if(bid<0||bid>13){send(ws,{type:'bidError',msg:'Bid must be 0–13'});return;}
      if(G.bidTurn===3&&G.totalBids+bid===13){
        send(ws,{type:'bidError',msg:"Can't make total exactly 13!"});return;
      }
      G.players[pi].bid=bid; G.totalBids+=bid; G.bidTurn++;
      if(G.bidTurn>=4){
        let mx=-1,ldr=0;
        G.players.forEach((p,i)=>{if(p.bid>mx){mx=p.bid;ldr=i;}});
        G.phase='playing'; G.turnIndex=ldr; G.trickLeader=ldr;
        console.log(`[${roomId}] All bids in — P${ldr} leads`);
      }
      sendStateToAll(roomId);
      return;
    }

    // ── PLAY ──
    if(msg.type==='play'){
      const pi=msg.playerIndex;
      if(G.phase!=='playing'||G.turnIndex!==pi) return;
      const hand=G.hands[pi];

      // Find card by rank+suit (immune to index drift)
      let ci=-1;
      if(msg.cardRank&&msg.cardSuit){
        ci=hand.findIndex(c=>c&&c.r===msg.cardRank&&c.s===msg.cardSuit);
      } else {
        ci=msg.cardIndex;
      }
      if(ci<0||ci>=hand.length) return;
      const card=hand[ci];
      if(!card||card.hidden) return;

      // Suit-follow: led card = trick leader's card
      const led=G.currentTrick[G.trickLeader]||null;
      if(led){
        const hasSuit=hand.some(c=>c&&!c.hidden&&c.s===led.s);
        if(hasSuit&&card.s!==led.s){
          send(ws,{type:'playError',msg:'Must follow suit ('+led.s+')! Play a '+led.s+' card.'});
          return;
        }
      }

      hand.splice(ci,1);
      G.currentTrick[pi]=card;

      if(G.currentTrick.every(c=>c!==null)){
        const w=trickWinner(G.currentTrick,G.trickLeader);
        G.players[w].tricks++; G.trickResult=w; G.trickCount++;
        sendStateToAll(roomId);

        if(G.trickCount>=13){
          setTimeout(()=>{
            if(!rooms[roomId]) return; // room may have been cleaned up
            G.players.forEach(p=>{p.score+=p.bid===p.tricks?p.bid*10:-(p.bid*10);});
            G.phase='roundEnd';
            sendStateToAll(roomId);
          },2000);
        } else {
          setTimeout(()=>{
            if(!rooms[roomId]) return;
            G.currentTrick=[null,null,null,null];
            G.trickLeader=w; G.turnIndex=w; G.trickResult=null;
            sendStateToAll(roomId);
          },2000);
        }
      } else {
        let nx=(pi+1)%4; while(G.currentTrick[nx]!==null) nx=(nx+1)%4;
        G.turnIndex=nx;
        sendStateToAll(roomId);
      }
      return;
    }

    // ── NEXT ROUND ──
    if(msg.type==='nextRound'){
      if(G.phase!=='roundEnd') return;
      G.bidOrder=[...G.bidOrder.slice(1),G.bidOrder[0]]; G.round++;
      const d=genDeck();
      G.phase='bidding';
      G.hands=[d.slice(0,13),d.slice(13,26),d.slice(26,39),d.slice(39,52)];
      G.bidTurn=0; G.totalBids=0;
      G.currentTrick=[null,null,null,null];
      G.trickLeader=G.bidOrder[0]; G.trickCount=0;
      G.turnIndex=-1; G.trickResult=null;
      G.players.forEach(p=>{p.bid=-1;p.tricks=0;});
      sendStateToAll(roomId);
      console.log(`[${roomId}] Round ${G.round} started`);
      return;
    }

    // ── END GAME ──
    if(msg.type==='endGame'){
      G.endGame=true; G.phase='gameEnd';
      sendStateToAll(roomId);
      console.log(`[${roomId}] Game ended`);
      // Clean up room after 5 min
      setTimeout(()=>{
        if(rooms[roomId]){delete rooms[roomId];console.log(`[${roomId}] Cleaned up after game end`);}
      }, 5*60*1000);
      return;
    }
  });

  ws.on('close',()=>{
    clearInterval(pingInterval);
    console.log(`[${roomId||'?'}] P${playerIndex} disconnected`);
    if(roomId) scheduleRoomCleanup(roomId, 3*60*1000); // clean if all gone after 3min
  });

  ws.on('error',(err)=>{
    console.log(`WS error [${roomId}] P${playerIndex}:`, err.message);
  });
});

// ── KEEP SERVER AWAKE on Render free tier ──
// Render free tier sleeps after 15 min of no HTTP requests.
// Self-ping every 14 min guarantees the server never sleeps mid-game.
const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'https://spades-server-xjlq.onrender.com';
const https = require('https');
function selfPing(){
  const mod = SELF_URL.startsWith('https') ? https : require('http');
  mod.get(SELF_URL, (res)=>{
    console.log(`[Self-ping] OK ${res.statusCode} — server stays awake`);
  }).on('error',(e)=>{
    console.log(`[Self-ping] Error: ${e.message}`);
  });
}
// First ping after 13 min, then every 14 min
setTimeout(()=>{
  selfPing();
  setInterval(selfPing, 14*60*1000);
}, 13*60*1000);
console.log(`[Self-ping] Scheduled every 14 min to prevent Render sleep`);

// Heartbeat log every 30s
setInterval(()=>{
  const rc=Object.keys(rooms).length;
  const cc=wss.clients.size;
  console.log(`[Heartbeat] ${rc} rooms, ${cc} clients connected`);
}, 30000);

server.listen(PORT,()=>console.log(`♠ Spades Royale server running on port ${PORT}`));
