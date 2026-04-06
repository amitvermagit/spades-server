const WebSocket = require('ws');
const http = require('http');
const PORT = process.env.PORT || 3000;

const server = http.createServer((req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.writeHead(200,{'Content-Type':'text/plain'});
  res.end('Spades Royale ♠');
});

const wss = new WebSocket.Server({server, verifyClient:()=>true});
const rooms = {};

function send(ws, data){ if(ws&&ws.readyState===1) try{ws.send(JSON.stringify(data));}catch(e){} }
function broadcast(roomId, data){
  const r=rooms[roomId]; if(!r) return;
  r.players.filter(p=>p.ws.readyState===1).forEach(p=>send(p.ws,data));
}
function broadcastExceptAdmin(roomId, data){
  const r=rooms[roomId]; if(!r) return;
  r.players.filter(p=>p.playerIndex>=0&&p.ws.readyState===1).forEach(p=>send(p.ws,data));
}

// ── CARD UTILS ──
function genDeck(){
  const S=['♠','♥','♦','♣'],R=['2','3','4','5','6','7','8','9','10','J','Q','K','A'],d=[];
  for(const s of S)for(const r of R)d.push({s,r});
  for(let i=d.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[d[i],d[j]]=[d[j],d[i]];}
  return d;
}
function cardVal(c){
  const R={'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14};
  const S={'♠':4,'♥':3,'♦':2,'♣':1};
  return S[c.s]*100+R[c.r];
}
function trickWinner(trick, leader){
  let w=leader,wc=trick[leader];
  for(let i=0;i<4;i++){
    if(i===leader) continue;
    const c=trick[i];
    if(c.s==='♠'&&wc.s!=='♠'){w=i;wc=c;}
    else if(c.s===wc.s&&cardVal(c)>cardVal(wc)){w=i;wc=c;}
  }
  return w;
}

// ── SEND STATE (hide other hands) ──
function sendStateToAll(roomId){
  const r=rooms[roomId]; if(!r) return;
  r.players.filter(p=>p.ws.readyState===1).forEach(p=>{
    const view=JSON.parse(JSON.stringify(r.state));
    if(p.playerIndex>=0){
      // players only see their own hand
      view.hands=view.hands.map((h,i)=>i===p.playerIndex?h:h.map(()=>({hidden:true})));
    }
    view.myIndex=p.playerIndex; // -1 for admin
    send(p.ws,{type:'state',state:view});
  });
}

wss.on('connection',(ws)=>{
  let roomId=null, playerIndex=-1;
  const ping=setInterval(()=>{if(ws.readyState===1)ws.ping();},25000);

  ws.on('message',(raw)=>{
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
        players:[{ws,playerIndex:-1}]
      };
      send(ws,{type:'created',roomId});
      sendStateToAll(roomId);
      console.log(`[${roomId}] created by ${msg.adminName}`);
      return;
    }

    // ── JOIN (player) ──
    if(msg.type==='join'){
      const r=rooms[msg.roomId];
      if(!r){send(ws,{type:'error',msg:'Room not found.'});return;}
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
      if(!r){send(ws,{type:'error',msg:'Room gone.'});return;}
      roomId=msg.roomId; playerIndex=msg.playerIndex;
      r.players=r.players.filter(p=>p.playerIndex!==playerIndex);
      r.players.push({ws,playerIndex});
      send(ws,{type:'rejoined',playerIndex});
      sendStateToAll(roomId);
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
      const pi=msg.playerIndex, bid=msg.bid;
      if(G.phase!=='bidding') return;
      if(G.bidOrder[G.bidTurn]!==pi||G.players[pi].bid>=0) return;
      if(G.bidTurn===3&&G.totalBids+bid===13){
        send(ws,{type:'bidError',msg:"Can't make total equal 13!"});return;
      }
      G.players[pi].bid=bid; G.totalBids+=bid; G.bidTurn++;
      if(G.bidTurn>=4){
        let mx=-1,ldr=0;
        G.players.forEach((p,i)=>{if(p.bid>mx){mx=p.bid;ldr=i;}});
        G.phase='playing'; G.turnIndex=ldr; G.trickLeader=ldr;
        console.log(`[${roomId}] All bids in, ${G.players[ldr].name} leads`);
      }
      sendStateToAll(roomId);
      return;
    }

    // ── PLAY ──
    if(msg.type==='play'){
      const pi=msg.playerIndex, ci=msg.cardIndex;
      if(G.phase!=='playing'||G.turnIndex!==pi) return;
      const hand=G.hands[pi], card=hand[ci];
      if(!card) return;
      const led=G.currentTrick.find(c=>c!==null);
      if(led&&hand.some(c=>c.s===led.s)&&card.s!==led.s){
        send(ws,{type:'playError',msg:'Must follow suit ('+led.s+')'});return;
      }
      hand.splice(ci,1); G.currentTrick[pi]=card;
      if(G.currentTrick.every(c=>c!==null)){
        const w=trickWinner(G.currentTrick,G.trickLeader);
        G.players[w].tricks++; G.trickResult=w; G.trickCount++;
        sendStateToAll(roomId);
        if(G.trickCount>=13){
          // Score and end round
          setTimeout(()=>{
            G.players.forEach(p=>{p.score+=p.bid===p.tricks?p.bid*10:-(p.bid*10);});
            G.phase='roundEnd';
            sendStateToAll(roomId);
          },2000);
        } else {
          setTimeout(()=>{
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
      return;
    }

    // ── END GAME ──
    if(msg.type==='endGame'){
      G.endGame=true; G.phase='gameEnd';
      sendStateToAll(roomId);
      return;
    }
  });

  ws.on('close',()=>{
    clearInterval(ping);
    console.log(`[${roomId}] P${playerIndex} disconnected`);
    setTimeout(()=>{
      if(rooms[roomId]){
        const alive=rooms[roomId].players.filter(p=>p.ws.readyState===1).length;
        if(alive===0){delete rooms[roomId];console.log(`[${roomId}] cleaned up`);}
      }
    },120000);
  });
  ws.on('error',()=>{});
});

setInterval(()=>{
  const rc=Object.keys(rooms).length;
  if(rc>0) console.log(`Heartbeat: ${rc} rooms, ${wss.clients.size} clients`);
},30000);

server.listen(PORT,()=>console.log(`♠ Spades on port ${PORT}`));
