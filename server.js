const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const PORT = process.env.PORT || 3000;

const server = http.createServer((req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.writeHead(200,{'Content-Type':'text/plain'});
  res.end('Spades Royale ♠ — Running');
});

const wss = new WebSocket.Server({server, verifyClient:()=>true});
const rooms = {};

// ── UTILS ──
function send(ws,data){
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
function scheduleRoomCleanup(roomId,delayMs){
  setTimeout(()=>{
    if(!rooms[roomId])return;
    const alive=rooms[roomId].players.filter(p=>p.ws.readyState===1).length;
    if(alive===0){delete rooms[roomId];console.log('['+roomId+'] Room cleaned up');}
  },delayMs);
}
function setRoomExpiry(roomId){
  setTimeout(()=>{
    if(rooms[roomId]){delete rooms[roomId];console.log('['+roomId+'] Room expired (2hr)');}
  },2*60*60*1000);
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
function trickWinner(trick,leader,trump){
  let w=leader,wc=trick[leader];
  for(let i=0;i<4;i++){
    if(i===leader)continue;
    const c=trick[i];
    if(c.s===trump&&wc.s!==trump){w=i;wc=c;}
    else if(c.s===wc.s&&cardVal(c)>cardVal(wc)){w=i;wc=c;}
  }
  return w;
}
function freshGameState(adminName){
  const d=genDeck();
  return{
    phase:'waiting',round:1,
    players:[
      {name:adminName,score:0,bid:-1,tricks:0},
      {name:'',score:0,bid:-1,tricks:0},
      {name:'',score:0,bid:-1,tricks:0},
      {name:'',score:0,bid:-1,tricks:0}
    ],
    hands:[d.slice(0,13),d.slice(13,26),d.slice(26,39),d.slice(39,52)],
    currentTrick:[null,null,null,null],trickLeader:0,
    bidOrder:[0,1,2,3],bidTurn:0,totalBids:0,
    trickCount:0,turnIndex:-1,trickResult:null,endGame:false,
    trump:null,trumpSelector:null
  };
}

// ── WEBSOCKET ──
wss.on('connection',(ws)=>{
  let roomId=null, playerIndex=-1, isAlive=true;

  const pingInterval=setInterval(()=>{
    if(!isAlive){ws.terminate();return;}
    isAlive=false;
    if(ws.readyState===1)ws.ping();
  },25000);
  ws.on('pong',()=>{isAlive=true;});

  ws.on('message',(raw)=>{
    isAlive=true;
    let msg;try{msg=JSON.parse(raw);}catch(e){return;}

    // ── CREATE ──
    if(msg.type==='create'){
      roomId=msg.roomId; playerIndex=-1;
      rooms[roomId]={state:freshGameState(msg.adminName),players:[{ws,playerIndex:-1}],createdAt:Date.now()};
      setRoomExpiry(roomId);
      send(ws,{type:'created',roomId});
      sendStateToAll(roomId);
      console.log('['+roomId+'] Created by '+msg.adminName);
      return;
    }

    // ── JOIN ──
    if(msg.type==='join'){
      const r=rooms[msg.roomId];
      if(!r){send(ws,{type:'error',msg:'Room not found. Check the Room ID.'});return;}
      if(r.state.phase!=='waiting'){send(ws,{type:'error',msg:'Game already started.'});return;}
      // Find next empty slot (1, 2, or 3)
      let pi=-1;
      // Allow rejoin by same name
      for(let i=1;i<=3;i++){
        if(r.state.players[i].name===msg.name){pi=i;break;}
      }
      if(pi===-1){
        for(let i=1;i<=3;i++){
          if(!r.state.players[i].name){pi=i;break;}
        }
      }
      if(pi===-1){send(ws,{type:'error',msg:'Room is full (4/4 players).'});return;}
      roomId=msg.roomId; playerIndex=pi;
      r.players=r.players.filter(p=>p.playerIndex!==pi);
      r.players.push({ws,playerIndex:pi});
      r.state.players[pi].name=msg.name;
      send(ws,{type:'joined',playerIndex:pi});
      sendStateToAll(roomId);
      console.log('['+roomId+'] '+msg.name+' joined as P'+pi);
      return;
    }

    // ── REJOIN ──
    if(msg.type==='rejoin'){
      const r=rooms[msg.roomId];
      if(!r){send(ws,{type:'error',msg:'Room gone.'});return;}
      roomId=msg.roomId; playerIndex=msg.playerIndex;
      r.players=r.players.filter(p=>p.playerIndex!==playerIndex);
      r.players.push({ws,playerIndex});
      send(ws,{type:'rejoined',playerIndex});
      sendStateToAll(roomId);
      return;
    }

    if(!roomId||!rooms[roomId])return;
    const r=rooms[roomId];
    const G=r.state;

    // ── START ──
    if(msg.type==='start'){
      if(G.phase!=='waiting')return;
      const d=genDeck();
      G.phase='bidding';
      G.hands=[d.slice(0,13),d.slice(13,26),d.slice(26,39),d.slice(39,52)];
      G.bidOrder=[0,1,2,3];G.bidTurn=0;G.totalBids=0;
      G.currentTrick=[null,null,null,null];G.trickLeader=0;
      G.trickCount=0;G.turnIndex=-1;G.trickResult=null;
      G.trump=null;G.trumpSelector=null;
      G.players.forEach(p=>{p.bid=-1;p.tricks=0;});
      sendStateToAll(roomId);
      console.log('['+roomId+'] Game started');
      return;
    }

    // ── BID ──
    if(msg.type==='bid'){
      const pi=msg.playerIndex, bid=Number(msg.bid);
      if(G.phase!=='bidding')return;
      if(G.bidOrder[G.bidTurn]!==pi||G.players[pi].bid>=0)return;
      if(bid<0||bid>13){send(ws,{type:'bidError',msg:'Bid must be 0-13'});return;}
      if(G.bidTurn===3&&G.totalBids+bid===13){send(ws,{type:'bidError',msg:"Can't make total exactly 13!"});return;}
      G.players[pi].bid=bid;G.totalBids+=bid;G.bidTurn++;
      if(G.bidTurn>=4){
        // Highest bidder selects trump
        let mx=-1,ldr=0;
        G.players.forEach((p,i)=>{if(p.bid>mx){mx=p.bid;ldr=i;}});
        G.phase='selectTrump';
        G.trumpSelector=ldr;
        G.trump=null;
        G.trickLeader=ldr;
        console.log('['+roomId+'] All bids in — P'+ldr+' ('+G.players[ldr].name+') selects trump');
      }
      sendStateToAll(roomId);
      return;
    }

    // ── SELECT TRUMP ──
    if(msg.type==='selectTrump'){
      if(G.phase!=='selectTrump')return;
      if(msg.playerIndex!==G.trumpSelector)return;
      if(!['♠','♥','♦','♣'].includes(msg.suit))return;
      G.trump=msg.suit;
      G.phase='playing';
      G.turnIndex=G.trumpSelector;
      console.log('['+roomId+'] Trump: '+msg.suit+' chosen by P'+G.trumpSelector+' ('+G.players[G.trumpSelector].name+')');
      sendStateToAll(roomId);
      return;
    }

    // ── PLAY ──
    if(msg.type==='play'){
      const pi=msg.playerIndex;
      if(G.phase!=='playing'||G.turnIndex!==pi)return;
      const hand=G.hands[pi];
      let ci=-1;
      if(msg.cardRank&&msg.cardSuit){
        ci=hand.findIndex(c=>c&&c.r===msg.cardRank&&c.s===msg.cardSuit);
      } else {
        ci=msg.cardIndex;
      }
      if(ci<0||ci>=hand.length)return;
      const card=hand[ci];
      if(!card||card.hidden)return;
      // Suit-follow: led = trick leader's card
      const led=G.currentTrick[G.trickLeader]||null;
      if(led){
        const hasSuit=hand.some(c=>c&&!c.hidden&&c.s===led.s);
        if(hasSuit&&card.s!==led.s){
          send(ws,{type:'playError',msg:'Must follow suit ('+led.s+')!'});return;
        }
      }
      hand.splice(ci,1);G.currentTrick[pi]=card;
      if(G.currentTrick.every(c=>c!==null)){
        const w=trickWinner(G.currentTrick,G.trickLeader,G.trump||'♠');
        G.players[w].tricks++;G.trickResult=w;G.trickCount++;
        sendStateToAll(roomId);
        if(G.trickCount>=13){
          setTimeout(()=>{
            if(!rooms[roomId])return;
            G.players.forEach(p=>{
              if(p.bid===p.tricks){
                p.score += p.bid===0 ? 10 : p.bid*10; // bid 0 & win 0 = +10 bonus
              } else {
                p.score -= p.bid===0 ? 10 : p.bid*10; // failed bid 0 = -10
              }
            });
            G.phase='roundEnd';
            sendStateToAll(roomId);
          },2000);
        } else {
          setTimeout(()=>{
            if(!rooms[roomId])return;
            G.currentTrick=[null,null,null,null];
            G.trickLeader=w;G.turnIndex=w;G.trickResult=null;
            sendStateToAll(roomId);
          },2000);
        }
      } else {
        let nx=(pi+1)%4;while(G.currentTrick[nx]!==null)nx=(nx+1)%4;
        G.turnIndex=nx;
        sendStateToAll(roomId);
      }
      return;
    }

    // ── NEXT ROUND ──
    if(msg.type==='nextRound'){
      if(G.phase!=='roundEnd')return;
      G.bidOrder=[...G.bidOrder.slice(1),G.bidOrder[0]];G.round++;
      const d=genDeck();
      G.phase='bidding';
      G.hands=[d.slice(0,13),d.slice(13,26),d.slice(26,39),d.slice(39,52)];
      G.bidTurn=0;G.totalBids=0;
      G.currentTrick=[null,null,null,null];
      G.trickLeader=G.bidOrder[0];G.trickCount=0;
      G.turnIndex=-1;G.trickResult=null;
      G.trump=null;G.trumpSelector=null;
      G.players.forEach(p=>{p.bid=-1;p.tricks=0;});
      sendStateToAll(roomId);
      console.log('['+roomId+'] Round '+G.round+' started');
      return;
    }

    // ── RESET ROUND (admin discards current round, deals fresh) ──
    if(msg.type==='resetRound'){
      if(playerIndex!==-1) return; // only admin
      const d=genDeck();
      // Reset round completely — same round number, same bid order, fresh deck
      G.phase='bidding';
      G.trump=null; G.trumpSelector=null;
      G.hands=[d.slice(0,13),d.slice(13,26),d.slice(26,39),d.slice(39,52)];
      // Keep same bidOrder (don't rotate — it's the same round restarted)
      G.bidTurn=0; G.totalBids=0;
      G.currentTrick=[null,null,null,null];
      G.trickLeader=G.bidOrder[0]; G.trickCount=0;
      G.turnIndex=-1; G.trickResult=null;
      G.bidError=null; G.playError=null;
      G.players.forEach(p=>{p.bid=-1;p.tricks=0;});
      // Scores are NOT changed — only current round discarded
      // Signal to clients that this is a reset (so they close modals)
      G.roundReset=true;
      sendStateToAll(roomId);
      G.roundReset=false; // clear after broadcast
      console.log(`[${roomId}] Round reset by admin`);
      return;
    }

    // ── END GAME ──
    if(msg.type==='endGame'){
      G.endGame=true;G.phase='gameEnd';
      sendStateToAll(roomId);
      setTimeout(()=>{if(rooms[roomId]){delete rooms[roomId];console.log('['+roomId+'] Cleaned up after game end');}},5*60*1000);
      return;
    }
  });

  ws.on('close',()=>{
    clearInterval(pingInterval);
    console.log('['+(roomId||'?')+'] P'+playerIndex+' disconnected');
    if(roomId)scheduleRoomCleanup(roomId,3*60*1000);
  });
  ws.on('error',(err)=>{console.log('WS error ['+roomId+']:',err.message);});
});

// ── SELF-PING to prevent Render free tier sleep ──
const SELF_URL=process.env.RENDER_EXTERNAL_URL||'https://spades-server-xjlq.onrender.com';
function selfPing(){
  const mod=SELF_URL.startsWith('https')?https:http;
  mod.get(SELF_URL,(res)=>console.log('[Self-ping] OK '+res.statusCode)).on('error',(e)=>console.log('[Self-ping] Error:',e.message));
}
setTimeout(()=>{selfPing();setInterval(selfPing,14*60*1000);},13*60*1000);
console.log('[Self-ping] Scheduled every 14 min');

// ── HEARTBEAT LOG ──
setInterval(()=>{
  console.log('[Heartbeat] '+Object.keys(rooms).length+' rooms, '+wss.clients.size+' clients');
},30000);

server.listen(PORT,()=>console.log('♠ Spades Royale running on port '+PORT));
