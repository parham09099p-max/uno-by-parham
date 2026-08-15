var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") === "websocket") {
      const roomCode = url.searchParams.get("room") || "UNO";
      const id = env.UNO_ROOM.idFromName(roomCode);
      return env.UNO_ROOM.get(id).fetch(request);
    }
    return new Response(getFrontEndHTML(), {
      headers: { "Content-Type": "text/html;charset=UTF-8" }
    });
  }
};
var MyDurableObject = class {
  static {
    __name(this, "MyDurableObject");
  }
  constructor(state, env) {
    this.state = state;
    this.sessions = /* @__PURE__ */ new Map();
    this.initGame();
  }
  initGame() {
    this.players = [];
    this.deck = [];
    this.discardPile = [];
    this.status = "LOBBY";
    this.currentTurn = 0;
    this.direction = 1;
    this.currentColor = "";
    this.penaltyStack = 0;
    this.rankings = [];
  }
  generateDeck() {
    const colors = ["RED", "BLUE", "GREEN", "YELLOW"];
    let newDeck = [];
    colors.forEach((color) => {
      newDeck.push({ id: crypto.randomUUID(), type: "NUMBER", color, value: 0 });
      for (let i = 1; i <= 9; i++) {
        newDeck.push({ id: crypto.randomUUID(), type: "NUMBER", color, value: i });
        newDeck.push({ id: crypto.randomUUID(), type: "NUMBER", color, value: i });
      }
      ["SKIP", "REVERSE", "DRAW_2"].forEach((action) => {
        newDeck.push({ id: crypto.randomUUID(), type: "ACTION", color, value: action });
        newDeck.push({ id: crypto.randomUUID(), type: "ACTION", color, value: action });
      });
    });
    for (let i = 0; i < 4; i++) {
      newDeck.push({ id: crypto.randomUUID(), type: "WILD", color: "ANY", value: "WILD" });
      newDeck.push({ id: crypto.randomUUID(), type: "WILD", color: "ANY", value: "DRAW_4" });
    }
    return newDeck.sort(() => Math.random() - 0.5);
  }
  async fetch(request) {
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    const url = new URL(request.url);
    const playerName = url.searchParams.get("name") || "\u0646\u0627\u0634\u0646\u0627\u0633";
    const playerId = crypto.randomUUID();
    server.accept();
    const isHost = this.players.length === 0;
    this.sessions.set(server, { id: playerId, name: playerName, isHost });
    if (this.status === "LOBBY") {
      this.players.push({ id: playerId, name: playerName, isHost, hand: [], hasFinished: false });
    }
    server.addEventListener("message", async (event) => {
      if (event.data instanceof ArrayBuffer) {
        for (const [otherWs] of this.sessions) {
          if (otherWs !== server && otherWs.readyState === WebSocket.OPEN) {
            try {
              otherWs.send(event.data);
            } catch (e) {
            }
          }
        }
        return;
      }
      const data = JSON.parse(event.data);
      const session = this.sessions.get(server);
      if (data.type === "CHAT") {
        this.broadcast({ type: "CHAT", sender: session.name, text: data.text });
        return;
      }
      if (data.type === "START_GAME" && session.isHost) {
        this.deck = this.generateDeck();
        this.players.forEach((p) => {
          p.hand = this.deck.splice(0, 7);
          p.hasFinished = false;
        });
        this.discardPile = [this.deck.pop()];
        while (this.discardPile[0].type === "WILD") {
          this.deck.push(this.discardPile.pop());
          this.deck = this.deck.sort(() => Math.random() - 0.5);
          this.discardPile = [this.deck.pop()];
        }
        this.currentColor = this.discardPile[0].color;
        this.status = "PLAYING";
        this.currentTurn = 0;
        this.penaltyStack = 0;
        this.rankings = [];
      }
      if (data.type === "PLAY_CARD") {
        this.handlePlayCard(session.id, data.cardId, data.chosenColor);
      }
      if (data.type === "DRAW_CARD") {
        this.handleDrawCard(session.id, server);
      }
      if (data.type === "RESET_ROOM" && session.isHost) {
        this.initGame();
        this.players = Array.from(this.sessions.values()).map((s) => ({ id: s.id, name: s.name, isHost: s.isHost, hand: [], hasFinished: false }));
      }
      if (data.type === "CLOSE_ROOM" && session.isHost) {
        this.broadcast({ type: "ROOM_CLOSED" });
        this.sessions.forEach((s, ws) => ws.close());
        this.sessions.clear();
        this.initGame();
        return;
      }
      this.broadcastState();
    });
    server.addEventListener("close", () => {
      this.sessions.delete(server);
      if (this.status === "LOBBY") {
        this.players = this.players.filter((p) => p.id !== playerId);
        if (this.players.length > 0 && isHost) this.players[0].isHost = true;
      }
      this.broadcastState();
    });
    this.broadcastState();
    return new Response(null, { status: 101, webSocket: client });
  }
  nextTurn(step = 1) {
    let activePlayers = this.players.filter((p) => !p.hasFinished);
    if (activePlayers.length <= 1) {
      this.status = "ENDED";
      if (activePlayers.length === 1) this.rankings.push(activePlayers[0]);
      return;
    }
    let next = this.currentTurn;
    for (let i = 0; i < step; i++) {
      do {
        next = (next + this.direction + this.players.length) % this.players.length;
      } while (this.players[next].hasFinished);
    }
    this.currentTurn = next;
  }
  handlePlayCard(playerId, cardId, chosenColor) {
    const player = this.players[this.currentTurn];
    if (player.id !== playerId) return;
    const cardIndex = player.hand.findIndex((c) => c.id === cardId);
    if (cardIndex === -1) return;
    const card = player.hand[cardIndex];
    const topCard = this.discardPile[this.discardPile.length - 1];
    if (this.penaltyStack > 0) {
      if (topCard.value === "DRAW_4" && card.value !== "DRAW_4") return;
      if (topCard.value === "DRAW_2" && card.value !== "DRAW_2") return;
    } else {
      const isValid = card.type === "WILD" || card.color === this.currentColor || card.value === topCard.value;
      if (!isValid) return;
    }
    player.hand.splice(cardIndex, 1);
    this.discardPile.push(card);
    let step = 1;
    if (card.type === "WILD") this.currentColor = chosenColor || "RED";
    else this.currentColor = card.color;
    if (card.value === "DRAW_2") this.penaltyStack += 2;
    if (card.value === "DRAW_4") this.penaltyStack += 4;
    if (card.value === "REVERSE") this.direction *= -1;
    if (card.value === "SKIP") step = 2;
    if (player.hand.length === 0) {
      player.hasFinished = true;
      this.rankings.push(player);
    }
    this.nextTurn(step);
  }
  handleDrawCard(playerId, serverWs) {
    const player = this.players[this.currentTurn];
    if (player.id !== playerId) return;
    const drawnCards = [];
    const drawCount = this.penaltyStack > 0 ? this.penaltyStack : 1;
    for (let i = 0; i < drawCount; i++) {
      if (this.deck.length === 0) {
        const top = this.discardPile.pop();
        this.deck = this.discardPile.sort(() => Math.random() - 0.5);
        this.discardPile = [top];
      }
      if (this.deck.length > 0) {
        const c = this.deck.pop();
        player.hand.push(c);
        drawnCards.push(c);
      }
    }
    this.penaltyStack = 0;
    try {
      serverWs.send(JSON.stringify({ type: "DRAWN_CARDS_NOTIFICATION", cards: drawnCards }));
    } catch (e) {
    }
    this.nextTurn(1);
  }
  broadcast(message) {
    const payload = JSON.stringify(message);
    for (const [ws] of this.sessions) {
      try {
        ws.send(payload);
      } catch (e) {
        this.sessions.delete(ws);
      }
    }
  }
  broadcastState() {
    const stateMsg = {
      type: "STATE",
      status: this.status,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        isHost: p.isHost,
        cardCount: p.hand.length,
        hasFinished: p.hasFinished
      })),
      topCard: this.discardPile[this.discardPile.length - 1],
      currentColor: this.currentColor,
      currentTurnId: this.players[this.currentTurn]?.id,
      penaltyStack: this.penaltyStack,
      rankings: this.rankings,
      direction: this.direction
    };
    for (const [ws, session] of this.sessions) {
      const pData = this.players.find((p) => p.id === session.id);
      const personalState = { ...stateMsg, myHand: pData ? pData.hand : [], myId: session.id, amIHost: session.isHost };
      try {
        ws.send(JSON.stringify(personalState));
      } catch (e) {
      }
    }
  }
};
function getFrontEndHTML() {
  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>UNO Party Deluxe - \u067E\u0631\u0647\u0627\u0645</title>
  <link href="https://cdn.jsdelivr.net/gh/rastikerdar/vazirmatn@v33.003/Vazirmatn-font-face.css" rel="stylesheet" type="text/css" />
  <style>
    :root {
      --bg-gradient: linear-gradient(135deg, #0f0c20 0%, #15102a 50%, #060814 100%);
      --card-bg: rgba(255, 255, 255, 0.05);
      --card-border: rgba(255, 255, 255, 0.1);
      --accent-red: #ff3366;
      --accent-blue: #00d2ff;
      --accent-green: #00e676;
      --accent-yellow: #ffea00;
    }
    
    * { box-sizing: border-box; font-family: 'Vazirmatn', sans-serif; user-select: none; }
    
    body {
      background: var(--bg-gradient);
      color: #fff;
      text-align: center;
      margin: 0;
      padding: 15px;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      overflow-x: hidden;
    }

    .hidden { display: none !important; }

    .card-ui {
      background: var(--card-bg);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid var(--card-border);
      padding: 24px;
      border-radius: 20px;
      width: 100%;
      max-width: 550px;
      box-shadow: 0 15px 35px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.1);
      margin: 10px auto;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }

    input, button {
      width: 100%;
      padding: 14px 18px;
      margin: 8px 0;
      border-radius: 12px;
      border: 1px solid var(--card-border);
      font-size: 15px;
      outline: none;
      transition: all 0.2s ease;
    }

    input {
      background: rgba(0, 0, 0, 0.4);
      color: #fff;
    }
    input:focus {
      border-color: var(--accent-blue);
      box-shadow: 0 0 12px rgba(0,210,255,0.3);
    }

    button {
      background: linear-gradient(135deg, #ff3366 0%, #ff1144 100%);
      color: white;
      cursor: pointer;
      font-weight: 700;
      box-shadow: 0 4px 15px rgba(255,51,102,0.4);
      border: none;
    }
    button:active { transform: scale(0.97); }

    .btn-green {
      background: linear-gradient(135deg, #00e676 0%, #00b0ff 100%);
      box-shadow: 0 4px 15px rgba(0,230,118,0.3);
    }
    .btn-danger {
      background: linear-gradient(135deg, #e53935 0%, #b71c1c 100%);
      box-shadow: 0 4px 15px rgba(229,57,53,0.3);
    }

    .uno-card {
      width: 70px;
      height: 105px;
      border-radius: 12px;
      border: 2px solid rgba(255, 255, 255, 0.8);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-weight: 900;
      font-size: 24px;
      color: white;
      margin: 6px;
      cursor: pointer;
      position: relative;
      text-shadow: 0 2px 4px rgba(0,0,0,0.6);
      box-shadow: 0 8px 20px rgba(0,0,0,0.4);
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .uno-card:hover { transform: translateY(-8px) rotate(1deg); }
    
    .c-RED { background: linear-gradient(135deg, #ff4757, #ff6b81); }
    .c-BLUE { background: linear-gradient(135deg, #1e90ff, #70a1ff); }
    .c-GREEN { background: linear-gradient(135deg, #2ed573, #7bed9f); }
    .c-YELLOW { background: linear-gradient(135deg, #ffa502, #eccc68); }
    .c-ANY { background: linear-gradient(135deg, #2f3542, #57606f); }

    .uno-card.playable {
      animation: pulseGlow 1.5s infinite alternate;
      border-color: #fff;
    }

    @keyframes pulseGlow {
      0% { box-shadow: 0 0 10px #ffea00; transform: translateY(-4px); }
      100% { box-shadow: 0 0 22px #ffea00, 0 0 35px rgba(255,234,0,0.5); transform: translateY(-10px); }
    }

    .hand-container {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      margin-top: 15px;
      max-height: 250px;
      overflow-y: auto;
      padding: 10px;
    }

    .chat-box {
      height: 130px;
      background: rgba(0,0,0,0.3);
      overflow-y: auto;
      text-align: right;
      padding: 12px;
      border-radius: 12px;
      font-size: 13px;
      margin-top: 15px;
      border: 1px solid rgba(255,255,255,0.05);
    }

    .player-list {
      list-style: none;
      padding: 0;
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 8px;
    }
    .player-badge {
      background: rgba(255,255,255,0.08);
      padding: 6px 14px;
      border-radius: 30px;
      font-size: 13px;
      border: 2px solid transparent;
      display: flex;
      align-items: center;
      gap: 6px;
      backdrop-filter: blur(5px);
    }
    .active-turn {
      border-color: var(--accent-yellow);
      background: rgba(255,234,0,0.15);
      box-shadow: 0 0 15px rgba(255,234,0,0.3);
    }

    .ptt-wrapper {
      position: fixed;
      bottom: 25px;
      right: 25px;
      z-index: 1000;
      display: flex;
      flex-direction: column;
      align-items: center;
    }

    #pttBtn {
      width: 70px;
      height: 70px;
      border-radius: 50%;
      background: linear-gradient(135deg, #00e676 0%, #00b0ff 100%);
      box-shadow: 0 8px 25px rgba(0,230,118,0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 28px;
      cursor: pointer;
      touch-action: manipulation;
      transition: all 0.15s ease;
    }
    #pttBtn:active, #pttBtn.talking {
      transform: scale(1.15);
      background: linear-gradient(135deg, #ff3366 0%, #ff1144 100%);
      box-shadow: 0 0 30px rgba(255,51,102,0.8);
    }

    .ptt-label {
      font-size: 11px;
      margin-top: 6px;
      background: rgba(0,0,0,0.6);
      padding: 2px 8px;
      border-radius: 10px;
    }

    #speakerToast {
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0,230,118,0.2);
      border: 1px solid var(--accent-green);
      backdrop-filter: blur(10px);
      padding: 8px 20px;
      border-radius: 20px;
      font-size: 14px;
      z-index: 2000;
      opacity: 0;
      transition: opacity 0.3s;
      pointer-events: none;
    }

    #newCardToast {
      background: rgba(0, 210, 255, 0.2);
      border: 1px solid var(--accent-blue);
      color: #fff;
      padding: 8px 15px;
      border-radius: 10px;
      font-size: 13px;
      margin-top: 10px;
      display: none;
      animation: fadeIn 0.3s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(-5px); }
      to { opacity: 1; transform: translateY(0); }
    }

    #colorPicker {
      position: fixed;
      top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0,0,0,0.85);
      backdrop-filter: blur(10px);
      z-index: 3000;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    .cp-btn {
      width: 90px;
      height: 90px;
      margin: 12px;
      font-size: 18px;
      border-radius: 50%;
      border: 3px solid white;
    }
  </style>
</head>
<body>

  <div id="speakerToast">\u{1F50A} \u062F\u0631 \u062D\u0627\u0644 \u0635\u062D\u0628\u062A: <span id="speakerName">...</span></div>

  <!-- LOGIN SCREEN -->
  <div class="card-ui" id="loginScreen">
    <h1 style="margin-bottom: 5px; font-weight: 900;">UNO Party \u{1F3B4}</h1>
    <p style="color: #aaa; font-size: 14px; margin-bottom: 20px;">\u062A\u062C\u0631\u0628\u0647 \u0633\u0631\u06CC\u0639 \u0627\u0648\u0646\u0648 \u0647\u0645\u0631\u0627\u0647 \u0628\u0627 \u0686\u062A \u0635\u0648\u062A\u06CC</p>
    <input type="text" id="nameInput" placeholder="\u0646\u0627\u0645 \u0645\u0633\u062A\u0639\u0627\u0631 \u0634\u0645\u0627...">
    <input type="text" id="roomInput" placeholder="\u06A9\u062F \u0627\u062A\u0627\u0642 (\u0645\u062B\u0644\u0627\u064B UNO1)">
    <button onclick="connect()">\u0648\u0631\u0648\u062F \u0628\u0647 \u0627\u062A\u0627\u0642</button>
  </div>

  <!-- LOBBY SCREEN -->
  <div class="card-ui hidden" id="lobbyScreen">
    <h3>\u0627\u062A\u0627\u0642: <span id="roomCodeDisplay" style="color: var(--accent-blue);"></span></h3>
    <ul class="player-list" id="lobbyPlayers"></ul>
    
    <div class="host-controls hidden" id="hostLobbyControls" style="margin-top: 15px;">
      <button class="btn-green" onclick="ws.send(JSON.stringify({type:'START_GAME'}))">\u0634\u0631\u0648\u0639 \u0628\u0627\u0632\u06CC \u{1F680}</button>
    </div>
    
    <div class="chat-box" id="lobbyChatBox"></div>
    <div style="display:flex; gap: 8px; margin-top: 8px;">
      <input type="text" id="chatInput" placeholder="\u0627\u0631\u0633\u0627\u0644 \u067E\u06CC\u0627\u0645..." onkeypress="if(event.key==='Enter') sendChat()">
      <button style="width:30%" onclick="sendChat()">\u0627\u0631\u0633\u0627\u0644</button>
    </div>
  </div>

  <!-- GAME SCREEN -->
  <div class="card-ui hidden" id="gameScreen">
    <div style="display:flex; justify-content: space-between; align-items: center; font-size: 13px; margin-bottom: 10px;">
      <span id="directionInfo">\u{1F504} \u062C\u0647\u062A: \u0633\u0627\u0639\u062A\u200C\u06AF\u0631\u062F</span>
      <span id="currentColorInfo" style="padding: 4px 12px; border-radius: 8px; font-weight: bold;">\u0631\u0646\u06AF: -</span>
    </div>
    
    <ul class="player-list" id="gamePlayers"></ul>
    
    <div style="margin: 15px 0; padding: 15px; background: rgba(0,0,0,0.3); border-radius: 16px; border: 1px solid var(--card-border);">
      <div style="font-size: 13px; color: #aaa; margin-bottom: 8px;">\u06A9\u0627\u0631\u062A \u0648\u0633\u0637:</div>
      <div id="topCardArea" style="display: flex; justify-content: center;"></div>
      <h4 id="penaltyAlert" style="color: var(--accent-yellow); margin: 8px 0 0 0;"></h4>
    </div>

    <div style="font-size: 14px; margin-bottom: 5px;">\u06A9\u0627\u0631\u062A\u200C\u0647\u0627\u06CC \u0634\u0645\u0627:</div>
    <div id="newCardToast">\u2728 \u06A9\u0627\u0631\u062A\u200C\u0647\u0627\u06CC \u062C\u062F\u06CC\u062F \u062F\u0631\u06CC\u0627\u0641\u062A \u0634\u062F\u0647: <b id="newCardNames"></b></div>
    <div class="hand-container" id="myHandArea"></div>
    <button class="btn-green" id="drawBtn" onclick="drawCard()" style="margin-top:15px;"></button>

    <div class="host-controls hidden" id="hostGameControls" style="margin-top: 20px; display: flex; gap: 10px;">
      <button class="btn-danger" onclick="ws.send(JSON.stringify({type:'RESET_ROOM'}))">\u0631\u06CC\u0633\u062A \u{1F504}</button>
      <button class="btn-danger" onclick="ws.send(JSON.stringify({type:'CLOSE_ROOM'}))">\u0628\u0633\u062A\u0646 \u0631\u0648\u0645 \u274C</button>
    </div>
  </div>

  <!-- END SCREEN -->
  <div class="card-ui hidden" id="endScreen">
    <h2>\u067E\u0627\u06CC\u0627\u0646 \u0628\u0627\u0632\u06CC! \u{1F3C6}</h2>
    <div id="rankingsArea" style="font-size: 18px; line-height: 2.2;"></div>
    <div class="host-controls hidden" id="hostEndControls">
      <button class="btn-green" onclick="ws.send(JSON.stringify({type:'RESET_ROOM'}))">\u0634\u0631\u0648\u0639 \u0645\u062C\u062F\u062F \u{1F504}</button>
    </div>
  </div>

  <!-- PTT BUTTON -->
  <div class="ptt-wrapper hidden" id="voiceControls">
    <div id="pttBtn">\u{1F399}\uFE0F</div>
    <div class="ptt-label">\u0646\u06AF\u0647 \u062F\u0627\u0631\u06CC\u062F</div>
  </div>

  <!-- WILD COLOR PICKER -->
  <div id="colorPicker" class="hidden">
    <h2 style="margin-bottom:20px;">\u0627\u0646\u062A\u062E\u0627\u0628 \u0631\u0646\u06AF \u062C\u062F\u06CC\u062F:</h2>
    <div style="display:flex; flex-wrap:wrap; justify-content:center; max-width:320px;">
      <button class="cp-btn c-RED" onclick="playWild('RED')">\u0642\u0631\u0645\u0632</button>
      <button class="cp-btn c-BLUE" onclick="playWild('BLUE')">\u0622\u0628\u06CC</button>
      <button class="cp-btn c-GREEN" onclick="playWild('GREEN')">\u0633\u0628\u0632</button>
      <button class="cp-btn c-YELLOW" onclick="playWild('YELLOW')">\u0632\u0631\u062F</button>
    </div>
  </div>

   <script>
    let ws;
    let myId = null;
    let pendingWildCardId = null;
    
    // ==========================================
    // Voice Engine System (Stablized PCM/WebM Stream)
    // ==========================================
    let mediaRecorder = null;
    let audioStream = null;
    let toastTimeout = null;
    let newCardToastTimeout = null;
    
    let remoteAudioElement = null;
    let mediaSource = null;
    let sourceBuffer = null;
    let audioQueue = [];
    let isAppending = false;

    function initAudioPlayer() {
      if (remoteAudioElement) return;

      remoteAudioElement = document.createElement('audio');
      remoteAudioElement.autoplay = true;
      document.body.appendChild(remoteAudioElement);

      mediaSource = new MediaSource();
      remoteAudioElement.src = URL.createObjectURL(mediaSource);

      mediaSource.addEventListener('sourceopen', () => {
        try {
          // \u0627\u0633\u062A\u0641\u0627\u062F\u0647 \u0627\u0632 \u0646\u0648\u06CC\u062F\u0628\u062E\u0634\u200C\u062A\u0631\u06CC\u0646 \u06A9\u062F\u06A9 \u0635\u0648\u062A\u06CC \u0648\u0628
          sourceBuffer = mediaSource.addSourceBuffer('audio/webm; codecs=opus');
          sourceBuffer.mode = 'sequence'; // \u0686\u0633\u0628\u0627\u0646\u062F\u0646 \u062A\u0631\u062A\u06CC\u0628\u06CC \u0628\u0631\u0627\u06CC \u062C\u0644\u0648\u06AF\u06CC\u0631\u06CC \u0627\u0632 \u0642\u0637\u0639\u06CC

          sourceBuffer.addEventListener('updateend', processAudioQueue);
          sourceBuffer.addEventListener('error', () => {
            // \u062F\u0631 \u0635\u0648\u0631\u062A \u0628\u0631\u0648\u0632 \u062E\u0637\u0627 \u062F\u0631 \u0627\u0633\u062A\u0631\u06CC\u0645 \u0635\u0648\u062A\u06CC\u060C \u0635\u0641 \u067E\u0627\u06A9\u0633\u0627\u0632\u06CC \u0645\u06CC\u200C\u0634\u0648\u062F \u062A\u0627 \u0628\u0627\u0632\u06CC \u0642\u0641\u0644 \u0646\u06A9\u0646\u062F
            audioQueue = [];
            isAppending = false;
          });
        } catch (e) {
          console.error("Audio Buffer Initialization Error:", e);
        }
      });
    }

    function processAudioQueue() {
      if (sourceBuffer && !sourceBuffer.updating && audioQueue.length > 0) {
        try {
          isAppending = true;
          const chunk = audioQueue.shift();
          sourceBuffer.appendBuffer(chunk);
        } catch (e) {
          audioQueue = [];
          isAppending = false;
        }
      } else {
        isAppending = false;
      }
    }

    function playReceivedAudio(arrayBuffer, senderName) {
      initAudioPlayer();

      if (remoteAudioElement && remoteAudioElement.paused) {
        remoteAudioElement.play().catch(() => {});
      }

      const toast = document.getElementById('speakerToast');
      document.getElementById('speakerName').innerText = senderName;
      toast.style.opacity = '1';
      clearTimeout(toastTimeout);
      toastTimeout = setTimeout(() => { toast.style.opacity = '0'; }, 1500);

      audioQueue.push(arrayBuffer);
      if (!isAppending) {
        processAudioQueue();
      }
    }

    function getCardLabel(card) {
      if(card.value === 'DRAW_2') return '+2';
      if(card.value === 'DRAW_4') return '+4';
      if(card.value === 'REVERSE') return '\u{1F504}';
      if(card.value === 'SKIP') return '\u{1F6AB}';
      if(card.value === 'WILD') return '\u{1F3A8}';
      return card.value;
    }

    function getCardColorName(color) {
      if(color === 'RED') return '\u0642\u0631\u0645\u0632';
      if(color === 'BLUE') return '\u0622\u0628\u06CC';
      if(color === 'GREEN') return '\u0633\u0628\u0632';
      if(color === 'YELLOW') return '\u0632\u0631\u062F';
      return '\u06A9\u0627\u0631\u062A \u0648\u06CC\u0698\u0647';
    }

    function renderCard(card, onClick = null) {
      const div = document.createElement('div');
      div.className = "uno-card c-" + card.color;
      div.innerText = getCardLabel(card);
      if(onClick) div.onclick = onClick;
      return div;
    }

    async function initAudioRecording() {
      try {
        audioStream = await navigator.mediaDevices.getUserMedia({ 
          audio: { 
            echoCancellation: true, 
            noiseSuppression: true, 
            autoGainControl: true,
            channelCount: 1, // \u062A\u06A9 \u06A9\u0627\u0646\u0627\u0644\u0647 \u06A9\u0631\u062F\u0646 \u0628\u0631\u0627\u06CC \u06A9\u0627\u0647\u0634 \u06F5\u06F0 \u062F\u0631\u0635\u062F\u06CC \u062D\u062C\u0645 \u062F\u06CC\u062A\u0627\u06CC \u0635\u0648\u062A\u06CC
            sampleRate: 16000 // \u0628\u0647\u06CC\u0646\u0647\u200C\u0633\u0627\u0632\u06CC \u0635\u062F\u0627 \u0628\u0631\u0627\u06CC \u06AF\u0641\u062A\u0627\u0631
          } 
        });
        document.getElementById('voiceControls').classList.remove('hidden');
        setupPTTEvents();
      } catch(e) {
        console.warn('\u062F\u0633\u062A\u0631\u0633\u06CC \u0628\u0647 \u0645\u06CC\u06A9\u0631\u0648\u0641\u0648\u0646 \u062F\u0627\u062F\u0647 \u0646\u0634\u062F \u06CC\u0627 \u067E\u0634\u062A\u06CC\u0628\u0627\u0646\u06CC \u0646\u0645\u06CC\u200C\u0634\u0648\u062F.', e);
      }
    }

    function setupPTTEvents() {
      const btn = document.getElementById('pttBtn');

      const startRecording = () => {
        initAudioPlayer();
        if (!audioStream || (mediaRecorder && mediaRecorder.state === "recording")) return;
        btn.classList.add('talking');
        
        // \u0627\u0631\u0633\u0627\u0644 \u0686\u0646\u06A9\u200C\u0647\u0627 \u0628\u0627 \u0641\u0631\u0645\u062A \u0641\u0634\u0631\u062F\u0647\u200C\u062A\u0631
        mediaRecorder = new MediaRecorder(audioStream, { 
          mimeType: 'audio/webm;codecs=opus',
          audioBitsPerSecond: 16000 
        });
        
        mediaRecorder.ondataavailable = async (e) => {
          if (e.data.size > 0 && ws && ws.readyState === WebSocket.OPEN) {
            const arrayBuffer = await e.data.arrayBuffer();
            ws.send(arrayBuffer);
          }
        };
        // \u062A\u0627\u06CC\u0645\u0631 \u06F5\u06F0\u06F0 \u0645\u06CC\u0644\u06CC\u200C\u062B\u0627\u0646\u06CC\u0647: \u0635\u062F\u0627\u06CC \u0628\u0633\u06CC\u0627\u0631 \u067E\u0627\u06CC\u062F\u0627\u0631\u062A\u0631 \u0648 \u0631\u0633\u0634 \u0645\u0637\u0645\u0626\u0646 \u0628\u0647 \u0645\u0642\u0635\u062F
        mediaRecorder.start(500);
      };

      const stopRecording = () => {
        btn.classList.remove('talking');
        if (mediaRecorder && mediaRecorder.state === "recording") {
          mediaRecorder.stop();
        }
      };

      btn.addEventListener('mousedown', startRecording);
      btn.addEventListener('mouseup', stopRecording);
      btn.addEventListener('mouseleave', stopRecording);
      
      btn.addEventListener('touchstart', (e) => { e.preventDefault(); startRecording(); });
      btn.addEventListener('touchend', (e) => { e.preventDefault(); stopRecording(); });
    }

    async function connect() {
      const name = document.getElementById('nameInput').value || '\u0628\u0627\u0632\u06CC\u06A9\u0646';
      const room = document.getElementById('roomInput').value || 'UNO1';
      document.getElementById('roomCodeDisplay').innerText = room;
      
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(protocol + '//' + location.host + '?room=' + room + '&name=' + encodeURIComponent(name));
      ws.binaryType = "arraybuffer";

      ws.onmessage = async (event) => {
        if (event.data instanceof ArrayBuffer) {
          playReceivedAudio(event.data, "\u0628\u0627\u0632\u06CC\u06A9\u0646");
          return;
        }

        const data = JSON.parse(event.data);
        
        if(data.type === "ROOM_CLOSED") {
           alert("\u0627\u062A\u0627\u0642 \u062A\u0648\u0633\u0637 \u0645\u06CC\u0632\u0628\u0627\u0646 \u0628\u0633\u062A\u0647 \u0634\u062F.");
           location.reload();
        }
        if(data.type === "DRAWN_CARDS_NOTIFICATION") {
          showDrawnCardsNotification(data.cards);
        }
        if(data.type === "CHAT") {
          const box = document.getElementById('lobbyChatBox');
          box.innerHTML += '<div style="margin-bottom:4px"><b>' + data.sender + ':</b> ' + data.text + '</div>';
          box.scrollTop = box.scrollHeight;
        }
        if(data.type === "STATE") {
          myId = data.myId;
          updateUI(data);
        }
      };

      await initAudioRecording();
    }

    function showDrawnCardsNotification(cards) {
      if (!cards || cards.length === 0) return;
      const names = cards.map(c => '[' + getCardColorName(c.color) + ' ' + getCardLabel(c) + ']').join(' \u060C ');
      const toast = document.getElementById('newCardToast');
      document.getElementById('newCardNames').innerText = names;
      toast.style.display = 'block';
      
      clearTimeout(newCardToastTimeout);
      newCardToastTimeout = setTimeout(() => {
        toast.style.display = 'none';
      }, 4000);
    }

    function sendChat() {
      const input = document.getElementById('chatInput');
      if(input.value) { ws.send(JSON.stringify({ type: 'CHAT', text: input.value })); input.value = ''; }
    }

    function drawCard() { ws.send(JSON.stringify({ type: 'DRAW_CARD' })); }

    function initiatePlayCard(card) {
      if(card.type === 'WILD') {
        pendingWildCardId = card.id;
        document.getElementById('colorPicker').classList.remove('hidden');
      } else {
        ws.send(JSON.stringify({ type: 'PLAY_CARD', cardId: card.id }));
      }
    }

    function playWild(color) {
      document.getElementById('colorPicker').classList.add('hidden');
      ws.send(JSON.stringify({ type: 'PLAY_CARD', cardId: pendingWildCardId, chosenColor: color }));
      pendingWildCardId = null;
    }

    function updateUI(state) {
      ['loginScreen', 'lobbyScreen', 'gameScreen', 'endScreen'].forEach(id => document.getElementById(id).classList.add('hidden'));
      document.querySelectorAll('.host-controls').forEach(el => el.classList.add('hidden'));
      
      if(state.amIHost) {
        document.getElementById('hostLobbyControls').classList.remove('hidden');
        document.getElementById('hostGameControls').classList.remove('hidden');
        document.getElementById('hostEndControls').classList.remove('hidden');
      }

      if(state.status === "LOBBY") {
        document.getElementById('lobbyScreen').classList.remove('hidden');
        const list = document.getElementById('lobbyPlayers');
        list.innerHTML = '';
        state.players.forEach(p => list.innerHTML += '<li class="player-badge">\u{1F464} ' + p.name + ' ' + (p.isHost ? '\u{1F451}' : '') + '</li>');
      } 
      else if (state.status === "PLAYING") {
        document.getElementById('gameScreen').classList.remove('hidden');
        
        const pList = document.getElementById('gamePlayers');
        pList.innerHTML = '';
        state.players.forEach(p => {
          let extra = p.hasFinished ? ' (\u062A\u0645\u0627\u0645\u{1F3C6})' : ' (' + p.cardCount + ' \u06A9\u0627\u0631\u062A)';
          let cssClass = (p.id === state.currentTurnId) ? 'player-badge active-turn' : 'player-badge';
          pList.innerHTML += '<li class="' + cssClass + '">' + (p.isHost ? '\u{1F451}' : '') + ' ' + p.name + extra + '</li>';
        });

        document.getElementById('topCardArea').innerHTML = '';
        if(state.topCard) document.getElementById('topCardArea').appendChild(renderCard(state.topCard));
        
        const cColor = document.getElementById('currentColorInfo');
        const colorFa = state.currentColor==='RED'?'\u0642\u0631\u0645\u0632':state.currentColor==='BLUE'?'\u0622\u0628\u06CC':state.currentColor==='GREEN'?'\u0633\u0628\u0632':'\u0632\u0631\u062F';
        cColor.innerText = '\u0631\u0646\u06AF: ' + colorFa;
        cColor.style.backgroundColor = state.currentColor==='RED'?'#ff4757':state.currentColor==='BLUE'?'#1e90ff':state.currentColor==='GREEN'?'#2ed573':'#ffa502';
        
        document.getElementById('directionInfo').innerText = state.direction === 1 ? '\u{1F504} \u0633\u0627\u0639\u062A\u200C\u06AF\u0631\u062F' : '\u{1F503} \u067E\u0627\u062F\u0633\u0627\u0639\u062A\u200C\u06AF\u0631\u062F';
        
        const pAlert = document.getElementById('penaltyAlert');
        if(state.penaltyStack > 0) pAlert.innerText = '\u26A0\uFE0F \u062C\u0631\u06CC\u0645\u0647 \u0627\u0646\u0628\u0627\u0634\u062A\u0647: ' + state.penaltyStack + ' \u06A9\u0627\u0631\u062A!';
        else pAlert.innerText = '';

        const handDiv = document.getElementById('myHandArea');
        handDiv.innerHTML = '';
        const myTurn = state.currentTurnId === myId;
        
        state.myHand.forEach(card => {
          const el = renderCard(card, myTurn ? () => initiatePlayCard(card) : null);
          if(myTurn) el.classList.add('playable');
          handDiv.appendChild(el);
        });

        const dBtn = document.getElementById('drawBtn');
        dBtn.innerText = state.penaltyStack > 0 ? ('\u06A9\u0634\u06CC\u062F\u0646 ' + state.penaltyStack + ' \u06A9\u0627\u0631\u062A \u062C\u0631\u06CC\u0645\u0647') : '\u06CC\u06A9 \u06A9\u0627\u0631\u062A \u0628\u06A9\u0634 \u{1F3B4}';
        dBtn.style.display = myTurn ? 'block' : 'none';
      }
      else if (state.status === "ENDED") {
        document.getElementById('endScreen').classList.remove('hidden');
        const rArea = document.getElementById('rankingsArea');
        rArea.innerHTML = '';
        state.rankings.forEach((p, index) => {
          let medal = index === 0 ? '\u{1F947}' : index === 1 ? '\u{1F948}' : index === 2 ? '\u{1F949}' : '\u{1F396}\uFE0F';
          rArea.innerHTML += '<div>' + medal + ' \u0645\u0642\u0627\u0645 ' + (index + 1) + ': ' + p.name + '</div>';
        });
      }
    }
  <\/script>

</body>
</html>`;
}
__name(getFrontEndHTML, "getFrontEndHTML");
export {
  MyDurableObject,
  index_default as default
};
//# sourceMappingURL=index.js.map
