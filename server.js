const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const PORT = process.env.PORT || 3000;

const server = http.createServer((req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.writeHead(200,{'Content-Type':'text/plain'});
  res.end('Spades Royale ♠ — Running');
});

const wss = new WebSocket.Server({server,verifyClient:()=>true});
const rooms = {};

// ── UTILS ──
function send(ws,data){
  if(ws&&ws.readyState===1)try{ws.send(JSON.stringify(data));}catch(e){}
}
function sendStateToAll(roomId){
  const r=rooms[roomId];if(!r)return;
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
    if(alive===0){delete rooms[roomId];console.log('['+roomId+'] cleaned up');}
  },delayMs);
}
function setRoomExpiry(roomId){
  setTimeout(()=>{if(rooms[roomId]){delete rooms[roomId];console.log('['+roomId+'] expired');}},2*60*60*1000);
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

// ── BOT AI ──
function botBid(hand,totalBidsSoFar,isLastBidder,trump){
  // Count strong cards: aces, kings, trump cards
  let pts=0;
  hand.forEach(c=>{
    const r=c.r;
    if(r==='A')pts+=1;
    else if(r==='K')pts+=0.75;
    else if(r==='Q')pts+=0.5;
    else if(r==='J')pts+=0.25;
    // Extra weight for trump suit cards
    if(trump&&c.s===trump)pts+=0.3;
  });
  let bid=Math.round(pts);
  bid=Math.max(0,Math.min(bid,7)); // bots cap at 7
  // Last bidder can't make total exactly 13
  if(isLastBidder&&totalBidsSoFar+bid===13){
    bid=bid>0?bid-1:bid+1;
    bid=Math.max(0,Math.min(bid,13));
  }
  return bid;
}

function botSelectTrump(hand){
  // Count cards per suit, pick suit with most cards (or strongest)
  const counts={};
  const strength={};
  ['♠','♥','♦','♣'].forEach(s=>{counts[s]=0;strength[s]=0;});
  hand.forEach(c=>{
    counts[c.s]++;
    strength[c.s]+=cardVal({s:'♣',r:c.r}); // rank only
  });
  // Pick suit with most cards; tie-break by strength
  let best='♠';
  ['♠','♥','♦','♣'].forEach(s=>{
    if(counts[s]>counts[best]||(counts[s]===counts[best]&&strength[s]>strength[best]))best=s;
  });
  return best;
}

function botChooseCard(hand,G,pi){
  if(!hand||hand.length===0)return null;
  const trump=G.trump||'♠';
  const led=G.currentTrick[G.trickLeader]||null;
  const ledSuit=led?led.s:null;

  // Filter to legal cards (must follow suit if possible)
  let legal=hand.slice();
  if(ledSuit&&hand.some(c=>c.s===ledSuit)){
    legal=hand.filter(c=>c.s===ledSuit);
  }
  if(legal.length===0)legal=hand.slice();

  // If leading — play highest non-trump card
  if(!led){
    const nonTrump=hand.filter(c=>c.s!==trump);
    const pool=nonTrump.length>0?nonTrump:hand;
    return pool.reduce((best,c)=>cardVal(c)>cardVal(best)?c:best,pool[0]);
  }

  // Find what's currently winning the trick (only look at played cards)
  let winnerCard=led;
  let winnerIdx=G.trickLeader;
  for(let i=0;i<4;i++){
    const tc=G.currentTrick[i];
    if(!tc||i===pi)continue;
    if(tc.s===trump&&winnerCard.s!==trump){winnerCard=tc;winnerIdx=i;}
    else if(tc.s===winnerCard.s&&cardVal(tc)>cardVal(winnerCard)){winnerCard=tc;winnerIdx=i;}
  }
  const iAmWinning=(winnerIdx===pi); // won't be true here since pi hasn't played

  // If I can follow suit
  if(ledSuit){
    const ledCards=legal.filter(c=>c.s===ledSuit);
    if(ledCards.length>0){
      // Try to beat current winner with lowest possible card
      const beaters=ledCards.filter(c=>{
        if(winnerCard.s===trump&&c.s!==trump)return false;
        if(c.s===winnerCard.s)return cardVal(c)>cardVal(winnerCard);
        return false;
      });
      if(beaters.length>0)return beaters.reduce((low,c)=>cardVal(c)<cardVal(low)?c:low,beaters[0]);
      // Can't beat in suit — play lowest
      return ledCards.reduce((low,c)=>cardVal(c)<cardVal(low)?c:low,ledCards[0]);
    }
  }

  // Can't follow suit — try trump
  const trumpCards=hand.filter(c=>c.s===trump);
  if(trumpCards.length>0){
    if(winnerCard.s!==trump){
      // Play lowest trump to win
      return trumpCards.reduce((low,c)=>cardVal(c)<cardVal(low)?c:low,trumpCards[0]);
    }
    // Existing winner is trump — beat it with lowest higher trump
    const higherTrump=trumpCards.filter(c=>cardVal(c)>cardVal(winnerCard));
    if(higherTrump.length>0)return higherTrump.reduce((low,c)=>cardVal(c)<cardVal(low)?c:low,higherTrump[0]);
  }

  // Can't win — discard lowest card
  return hand.reduce((low,c)=>cardVal(c)<cardVal(low)?c:low,hand[0]);
}

// ── BOT ACTION: called after any state change when it's a bot's turn ──
function scheduleBotAction(roomId){
  const r=rooms[roomId];if(!r)return;
  const G=r.state;
  const bots=G.bots||[];

  if(G.phase==='bidding'){
    const pi=G.bidOrder[G.bidTurn];
    if(pi===undefined||!bots.includes(pi))return;
    setTimeout(()=>{
      if(!rooms[roomId])return;
      const bid=botBid(G.hands[pi],G.totalBids,G.bidTurn===3,null);
      G.players[pi].bid=bid;G.totalBids+=bid;G.bidTurn++;
      if(G.bidTurn>=4){
        let mx=-1,ldr=0;
        G.players.forEach((p,i)=>{if(p.bid>mx){mx=p.bid;ldr=i;}});
        G.phase='selectTrump';G.trumpSelector=ldr;G.trump=null;G.trickLeader=ldr;
        console.log('['+roomId+'] All bids — P'+ldr+' selects trump');
      }
      sendStateToAll(roomId);
      scheduleBotAction(roomId); // chain — maybe next bidder is also a bot
    },800);
  }

  else if(G.phase==='selectTrump'){
    const pi=G.trumpSelector;
    if(!bots.includes(pi))return;
    setTimeout(()=>{
      if(!rooms[roomId])return;
      G.trump=botSelectTrump(G.hands[pi]);
      G.phase='playing';G.turnIndex=G.trumpSelector;
      console.log('['+roomId+'] Bot P'+pi+' selected trump: '+G.trump);
      sendStateToAll(roomId);
      scheduleBotAction(roomId);
    },600);
  }

  else if(G.phase==='playing'){
    const pi=G.turnIndex;
    if(!bots.includes(pi))return;
    setTimeout(()=>{
      if(!rooms[roomId])return;
      try{
        const hand=G.hands[pi];
        if(!hand||hand.length===0)return;
        const card=botChooseCard(hand,G,pi);
        if(!card)return;
        const ci=hand.findIndex(c=>c.r===card.r&&c.s===card.s);
        if(ci<0)return;
        hand.splice(ci,1);G.currentTrick[pi]=card;
        if(G.currentTrick.every(c=>c!==null)){
          const w=trickWinner(G.currentTrick,G.trickLeader,G.trump||'♠');
          G.players[w].tricks++;G.trickResult=w;G.trickCount++;
          sendStateToAll(roomId);
          if(G.trickCount>=13){
            setTimeout(()=>{
              if(!rooms[roomId])return;
              G.players.forEach(p=>{
                if(p.bid===p.tricks){p.score+=p.bid===0?10:p.bid*10;}
                else{p.score-=p.bid===0?10:p.bid*10;}
              });
              G.phase='roundEnd';sendStateToAll(roomId);
            },2000);
          } else {
            setTimeout(()=>{
              if(!rooms[roomId])return;
              G.currentTrick=[null,null,null,null];
              G.trickLeader=w;G.turnIndex=w;G.trickResult=null;
              sendStateToAll(roomId);
              scheduleBotAction(roomId);
            },2000);
          }
        } else {
          let nx=(pi+1)%4;while(G.currentTrick[nx]!==null)nx=(nx+1)%4;
          G.turnIndex=nx;
          sendStateToAll(roomId);
          scheduleBotAction(roomId);
        }
      } catch(e){
        console.error('['+roomId+'] Bot P'+pi+' error:',e.message);
      }
    },900);
  }
}

function freshGameState(adminName,humanCount){
  const d=genDeck();
  // humanCount = total humans including admin (1-4)
  // bots fill remaining slots
  const botNames=['Bot Alpha','Bot Beta','Bot Gamma'];
  const players=[{name:adminName,score:0,bid:-1,tricks:0}];
  const bots=[];
  for(let i=1;i<=3;i++){
    const isBot=i>=humanCount; // slots >= humanCount are bots
    players.push({name:isBot?botNames[i-1]:'',score:0,bid:-1,tricks:0,isBot:isBot});
    if(isBot)bots.push(i);
  }
  return{
    phase:'waiting',round:1,humanCount,bots,
    players,
    hands:[d.slice(0,13),d.slice(13,26),d.slice(26,39),d.slice(39,52)],
    currentTrick:[null,null,null,null],trickLeader:0,
    bidOrder:[0,1,2,3],bidTurn:0,totalBids:0,
    trickCount:0,turnIndex:-1,trickResult:null,endGame:false,
    trump:null,trumpSelector:null
  };
}

// ── WEBSOCKET ──
wss.on('connection',(ws)=>{
  let roomId=null,playerIndex=-1,isAlive=true;
  const pingInterval=setInterval(()=>{
    if(!isAlive){ws.terminate();return;}
    isAlive=false;if(ws.readyState===1)ws.ping();
  },25000);
  ws.on('pong',()=>{isAlive=true;});

  ws.on('message',(raw)=>{
    isAlive=true;
    let msg;try{msg=JSON.parse(raw);}catch(e){return;}

    // ── CREATE ──
    if(msg.type==='create'){
      roomId=msg.roomId;playerIndex=-1;
      const humanCount=Math.min(4,Math.max(1,(msg.humanCount||4)));
      rooms[roomId]={
        state:freshGameState(msg.adminName,humanCount),
        players:[{ws,playerIndex:-1}],
        createdAt:Date.now()
      };
      setRoomExpiry(roomId);
      send(ws,{type:'created',roomId});
      sendStateToAll(roomId);
      console.log('['+roomId+'] Created by '+msg.adminName+', humans:'+humanCount);
      return;
    }

    // ── JOIN ──
    if(msg.type==='join'){
      const r=rooms[msg.roomId];
      if(!r){send(ws,{type:'error',msg:'Room not found. Check the Room ID.'});return;}
      if(r.state.phase!=='waiting'){send(ws,{type:'error',msg:'Game already started.'});return;}
      // Only allow joining human slots (not bot slots)
      const bots=r.state.bots||[];
      let pi=-1;
      // Allow rejoin by same name
      for(let i=1;i<=3;i++){
        if(!bots.includes(i)&&r.state.players[i].name===msg.name){pi=i;break;}
      }
      if(pi===-1){
        for(let i=1;i<=3;i++){
          if(!bots.includes(i)&&!r.state.players[i].name){pi=i;break;}
        }
      }
      if(pi===-1){send(ws,{type:'error',msg:'No open slots in this room.'});return;}
      roomId=msg.roomId;playerIndex=pi;
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
      roomId=msg.roomId;playerIndex=msg.playerIndex;
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
      scheduleBotAction(roomId); // trigger bots if first bidder is bot
      return;
    }

    // ── BID ──
    if(msg.type==='bid'){
      const pi=msg.playerIndex,bid=Number(msg.bid);
      if(G.phase!=='bidding')return;
      if(G.bidOrder[G.bidTurn]!==pi||G.players[pi].bid>=0)return;
      if(bid<0||bid>13){send(ws,{type:'bidError',msg:'Bid must be 0-13'});return;}
      if(G.bidTurn===3&&G.totalBids+bid===13){send(ws,{type:'bidError',msg:"Can't make total exactly 13!"});return;}
      G.players[pi].bid=bid;G.totalBids+=bid;G.bidTurn++;
      if(G.bidTurn>=4){
        let mx=-1,ldr=0;
        G.players.forEach((p,i)=>{if(p.bid>mx){mx=p.bid;ldr=i;}});
        G.phase='selectTrump';G.trumpSelector=ldr;G.trump=null;G.trickLeader=ldr;
        console.log('['+roomId+'] All bids — P'+ldr+' selects trump');
      }
      sendStateToAll(roomId);
      scheduleBotAction(roomId);
      return;
    }

    // ── SELECT TRUMP ──
    if(msg.type==='selectTrump'){
      if(G.phase!=='selectTrump')return;
      if(msg.playerIndex!==G.trumpSelector)return;
      if(!['♠','♥','♦','♣'].includes(msg.suit))return;
      G.trump=msg.suit;G.phase='playing';G.turnIndex=G.trumpSelector;
      console.log('['+roomId+'] Trump: '+msg.suit);
      sendStateToAll(roomId);
      scheduleBotAction(roomId);
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
      }else{ci=msg.cardIndex;}
      if(ci<0||ci>=hand.length)return;
      const card=hand[ci];
      if(!card||card.hidden)return;
      const led=G.currentTrick[G.trickLeader]||null;
      if(led){
        const hasSuit=hand.some(c=>c&&!c.hidden&&c.s===led.s);
        if(hasSuit&&card.s!==led.s){send(ws,{type:'playError',msg:'Must follow suit ('+led.s+')!'});return;}
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
              if(p.bid===p.tricks){p.score+=p.bid===0?10:p.bid*10;}
              else{p.score-=p.bid===0?10:p.bid*10;}
            });
            G.phase='roundEnd';sendStateToAll(roomId);
          },2000);
        }else{
          setTimeout(()=>{
            if(!rooms[roomId])return;
            G.currentTrick=[null,null,null,null];
            G.trickLeader=w;G.turnIndex=w;G.trickResult=null;
            sendStateToAll(roomId);
            scheduleBotAction(roomId);
          },2000);
        }
      }else{
        let nx=(pi+1)%4;while(G.currentTrick[nx]!==null)nx=(nx+1)%4;
        G.turnIndex=nx;
        sendStateToAll(roomId);
        scheduleBotAction(roomId);
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
      scheduleBotAction(roomId);
      return;
    }

    // ── RESET ROUND ──
    if(msg.type==='resetRound'){
      if(playerIndex!==-1)return;
      const d=genDeck();
      G.phase='bidding';G.trump=null;G.trumpSelector=null;
      G.hands=[d.slice(0,13),d.slice(13,26),d.slice(26,39),d.slice(39,52)];
      G.bidTurn=0;G.totalBids=0;
      G.currentTrick=[null,null,null,null];
      G.trickLeader=G.bidOrder[0];G.trickCount=0;
      G.turnIndex=-1;G.trickResult=null;
      G.players.forEach(p=>{p.bid=-1;p.tricks=0;});
      G.roundReset=true;sendStateToAll(roomId);G.roundReset=false;
      console.log('['+roomId+'] Round reset');
      scheduleBotAction(roomId);
      return;
    }

    // ── END GAME ──
    if(msg.type==='endGame'){
      G.endGame=true;G.phase='gameEnd';
      sendStateToAll(roomId);
      setTimeout(()=>{if(rooms[roomId]){delete rooms[roomId];}},5*60*1000);
      return;
    }
  });

  ws.on('close',()=>{
    clearInterval(pingInterval);
    if(roomId)scheduleRoomCleanup(roomId,3*60*1000);
  });
  ws.on('error',(err)=>{console.log('WS error:',err.message);});
});

// ── SELF-PING ──
const SELF_URL=process.env.RENDER_EXTERNAL_URL||'https://spades-server-xjlq.onrender.com';
function selfPing(){
  const mod=SELF_URL.startsWith('https')?https:http;
  mod.get(SELF_URL,(res)=>console.log('[Self-ping] '+res.statusCode)).on('error',(e)=>console.log('[Self-ping] Error:',e.message));
}
setTimeout(()=>{selfPing();setInterval(selfPing,14*60*1000);},13*60*1000);

setInterval(()=>console.log('[Heartbeat] '+Object.keys(rooms).length+' rooms, '+wss.clients.size+' clients'),30000);
server.listen(PORT,()=>console.log('♠ Spades Royale running on port '+PORT));
