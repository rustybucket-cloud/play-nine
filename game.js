"use strict";

// ---------------------------------------------------------------- state
const SAVE_KEY = "playnine-save-v1"; // local pass-and-play save
let MODE = null;   // 'local' | 'online'
let MY = null;     // online: { id, player, token }
let NETV = 0;      // latest server version we hold
let S = null;      // game state (shared shape for both modes)
let posting = false;
let pollTimer = null;

const $ = (id) => document.getElementById(id);

function newDeck() {
  const deck = [];
  for (let v = 0; v <= 12; v++) for (let i = 0; i < 8; i++) deck.push(v);
  for (let i = 0; i < 4; i++) deck.push(-5);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function baseState(names, totalHoles) {
  return {
    names, totalHoles,
    hole: 1,
    scores: [[], []],
    startingPlayer: Math.floor(Math.random() * 2),
    stock: [], discard: [], grids: null,
    phase: "lobby",          // lobby | flip | turn | done
    flipTurn: 0,
    current: 0,
    drawn: null, drawnFrom: null,
    mustFlip: false,
    finisher: null,
    gameOver: false,
  };
}

function dealHole() {
  S.stock = newDeck();
  S.grids = [[], []];
  for (let p = 0; p < 2; p++)
    for (let i = 0; i < 8; i++)
      S.grids[p].push({ v: S.stock.pop(), up: false });
  S.discard = [S.stock.pop()];
  S.phase = "flip";
  S.flipTurn = S.startingPlayer;
  S.current = S.startingPlayer;
  S.drawn = null; S.drawnFrom = null;
  S.mustFlip = false;
  S.finisher = null;
  S.gameOver = false;
}

// ---------------------------------------------------------------- persistence
function saveLocal() { if (MODE === "local") localStorage.setItem(SAVE_KEY, JSON.stringify(S)); }
function clearLocalSave() { localStorage.removeItem(SAVE_KEY); }
function credsKey(id) { return "playnine-online-" + id; }
function saveCreds() { localStorage.setItem(credsKey(MY.id), JSON.stringify(MY)); }
function loadCreds(id) {
  try { return JSON.parse(localStorage.getItem(credsKey(id))); } catch { return null; }
}

// ---------------------------------------------------------------- networking
async function api(method, params) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  let url = "/api/game";
  if (method === "GET") url += "?" + new URLSearchParams(params);
  else opts.body = JSON.stringify(params);
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error || r.status); e.status = r.status; e.data = data; throw e; }
  return data;
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(poll, 2000);
}
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

async function poll() {
  if (MODE !== "online" || posting || !MY) return;
  try {
    const r = await api("GET", { id: MY.id, since: NETV });
    setOnlineStatus(true);
    if (r.unchanged) return;
    S = r.state; NETV = r.version;
    afterRemoteUpdate();
  } catch (e) {
    setOnlineStatus(false);
  }
}

function afterRemoteUpdate() {
  // host deals once the second player has taken their seat
  if (S.phase === "lobby" && MY.player === 0 && S.seats && S.seats[1]) {
    dealHole();
    commit();
    hideLobby();
    return;
  }
  if (S.phase !== "lobby") hideLobby();
  render();
}

async function commit() {
  render();
  if (MODE === "local") { saveLocal(); return; }
  posting = true;
  try {
    const r = await api("POST", { action: "move", id: MY.id, token: MY.token, baseVersion: NETV, state: S });
    NETV = r.version;
    setOnlineStatus(true);
  } catch (e) {
    if (e.status === 409 && e.data && e.data.state) {
      S = e.data.state; NETV = e.data.version;
      toast("Synced with your opponent");
      afterRemoteUpdate();
    } else {
      setOnlineStatus(false);
      toast("Connection hiccup — retrying…");
      setTimeout(poll, 800);
    }
  } finally {
    posting = false;
  }
}

// ---------------------------------------------------------------- helpers
function allUp(p) { return S.grids[p].every(c => c.up); }
function flippedCount(p) { return S.grids[p].filter(c => c.up).length; }
function total(p) { return S.scores[p].reduce((a, b) => a + b, 0); }
function isMe(p) { return MODE === "local" || (MY && p === MY.player); }
function gameStarted() { return S && S.phase !== "lobby" && S.grids; }

function holeScore(p) {
  let sum = 0;
  for (let col = 0; col < 4; col++) {
    const a = S.grids[p][col].v, b = S.grids[p][col + 4].v;
    if (a === b) sum += (a === -5) ? -10 : 0;
    else sum += a + b;
  }
  return sum;
}

function cardColor(v) {
  if (v === -5) return "linear-gradient(135deg,#b8860b,#ffd166)";
  const hues = [265, 250, 210, 190, 160, 130, 95, 60, 40, 25, 12, 0, 330];
  const h = hues[v];
  return `linear-gradient(135deg, hsl(${h},55%,38%), hsl(${h},65%,52%))`;
}

function makeCardEl(card, opts = {}) {
  const el = document.createElement("div");
  el.className = "card " + (card ? (card.up ? "up" : "down") : "empty");
  if (card && card.up) {
    el.style.background = cardColor(card.v);
    el.innerHTML = (card.v === -5 ? '<span class="star">★</span>−5' : card.v);
  }
  if (opts.clickable) el.classList.add("clickable");
  return el;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2200);
}

function setOnlineStatus(ok) {
  const el = $("net-status");
  if (MODE !== "online") { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  el.classList.toggle("bad", !ok);
  el.title = ok ? "Connected" : "Reconnecting…";
}

// ---------------------------------------------------------------- rendering
function render() {
  if (!S) return;
  $("hole-indicator").textContent = gameStarted() ? `Hole ${S.hole} of ${S.totalHoles}` : "";

  for (let p = 0; p < 2; p++) {
    const you = MODE === "online" && MY && p === MY.player;
    $("pname-" + p).textContent = (S.names[p] || "Waiting…") + (you ? " (you)" : "");
    $("ptotal-" + p).textContent = `Total: ${total(p)}`;
    $("board-" + p).classList.toggle("active", isActingPlayer(p));
  }
  if (gameStarted()) {
    renderGrids();
    renderCenter();
  }
  renderBanner();
  syncSummaryOverlay();
  saveLocal();
}

function isActingPlayer(p) {
  if (!gameStarted() || S.gameOver || S.phase === "done") return false;
  if (S.phase === "flip") {
    if (MODE === "online") return flippedCount(p) < 2;
    return p === S.flipTurn;
  }
  return p === S.current;
}

function canActNow(p) { return isActingPlayer(p) && isMe(p); }

function renderGrids() {
  for (let p = 0; p < 2; p++) {
    const grid = $("grid-" + p);
    grid.innerHTML = "";
    S.grids[p].forEach((card, i) => {
      let clickable = false;
      if (S.phase === "flip" && canActNow(p) && !card.up) clickable = true;
      if (S.phase === "turn" && p === S.current && isMe(p)) {
        if (S.drawn !== null) clickable = true;
        else if (S.mustFlip && !card.up) clickable = true;
      }
      const el = makeCardEl(card, { clickable });
      if (clickable) el.addEventListener("click", () => onGridClick(p, i));
      grid.appendChild(el);
    });
  }
}

function renderCenter() {
  const myTurn = S.phase === "turn" && isMe(S.current);
  const canDraw = myTurn && S.drawn === null && !S.mustFlip;

  const stockEl = $("stock-pile");
  stockEl.classList.toggle("clickable", canDraw);
  $("stock-count").textContent = S.stock.length;

  const dp = $("discard-pile");
  dp.innerHTML = "";
  const top = S.discard.length ? { v: S.discard[S.discard.length - 1], up: true } : null;
  const discardClickable = canDraw && top !== null;
  const dEl = makeCardEl(top, { clickable: discardClickable });
  if (discardClickable) dEl.addEventListener("click", takeDiscard);
  dp.appendChild(dEl);

  const da = $("drawn-area");
  if (S.drawn !== null) {
    da.classList.remove("hidden");
    const dc = $("drawn-card");
    dc.innerHTML = "";
    dc.appendChild(makeCardEl({ v: S.drawn, up: true }));
    $("discard-drawn-btn").classList.toggle("hidden", S.drawnFrom !== "stock" || !isMe(S.current));
  } else {
    da.classList.add("hidden");
  }
}

function renderBanner() {
  const b = $("banner");
  const who = (p) => `<span class="who">${escapeHTML(S.names[p] || "…")}</span>${MODE === "online" && MY && p === MY.player ? " (you)" : ""}`;
  let msg = "";
  if (S.phase === "lobby") {
    msg = (MODE === "online" && MY && MY.player === 1)
      ? "You're in! Starting the first hole…"
      : "Waiting for your opponent to join…";
  } else if (S.phase === "flip") {
    if (MODE === "online") {
      const meLeft = 2 - flippedCount(MY.player);
      msg = meLeft > 0
        ? `${who(MY.player)}: flip ${meLeft} of your cards to start the hole.`
        : `Waiting for ${who(1 - MY.player)} to flip their starting cards…`;
    } else {
      const left = 2 - flippedCount(S.flipTurn);
      msg = `${who(S.flipTurn)}: flip ${left} of your cards to start the hole.`;
    }
  } else if (S.phase === "turn") {
    if (MODE === "online" && !isMe(S.current)) {
      msg = `Waiting for ${who(S.current)} to play…`;
    } else if (S.drawn !== null) {
      msg = S.drawnFrom === "stock"
        ? `${who(S.current)}: swap the drawn card with one of yours, or discard it and flip a face-down card.`
        : `${who(S.current)}: swap the discard into one of your 8 spots.`;
    } else if (S.mustFlip) {
      msg = `${who(S.current)}: flip one of your face-down cards.`;
    } else {
      msg = `${who(S.current)}: draw from the pile or take the discard.`;
    }
    if (S.finisher !== null && S.current !== S.finisher) {
      msg += ` <em>(${escapeHTML(S.names[S.finisher])} is out — last turn!)</em>`;
    }
  }
  b.innerHTML = msg;
}

// ---------------------------------------------------------------- actions
function onGridClick(p, i) {
  const card = S.grids[p][i];

  if (S.phase === "flip") {
    if (!canActNow(p) || card.up) return;
    card.up = true;
    const bothReady = flippedCount(0) >= 2 && flippedCount(1) >= 2;
    if (MODE === "online") {
      if (bothReady) { S.phase = "turn"; S.current = S.startingPlayer; }
    } else {
      if (flippedCount(S.flipTurn) >= 2) {
        if (bothReady) { S.phase = "turn"; S.current = S.startingPlayer; }
        else S.flipTurn = 1 - S.flipTurn;
      }
    }
    commit();
    return;
  }

  if (S.phase !== "turn" || p !== S.current || !isMe(p)) return;

  if (S.drawn !== null) {
    S.discard.push(card.v);
    S.grids[p][i] = { v: S.drawn, up: true };
    S.drawn = null; S.drawnFrom = null;
    endAction();
    return;
  }

  if (S.mustFlip && !card.up) {
    card.up = true;
    S.mustFlip = false;
    endAction();
  }
}

function drawFromStock() {
  if (!gameStarted() || S.phase !== "turn" || !isMe(S.current) || S.drawn !== null || S.mustFlip) return;
  if (S.stock.length === 0) reshuffleDiscardIntoStock();
  if (S.stock.length === 0) return;
  S.drawn = S.stock.pop();
  S.drawnFrom = "stock";
  commit();
}

function takeDiscard() {
  if (S.phase !== "turn" || !isMe(S.current) || S.drawn !== null || S.mustFlip || !S.discard.length) return;
  S.drawn = S.discard.pop();
  S.drawnFrom = "discard";
  commit();
}

function discardDrawn() {
  if (S.drawn === null || S.drawnFrom !== "stock" || !isMe(S.current)) return;
  S.discard.push(S.drawn);
  S.drawn = null; S.drawnFrom = null;
  S.mustFlip = S.grids[S.current].some(c => !c.up);
  if (!S.mustFlip) endAction(); else commit();
}

function reshuffleDiscardIntoStock() {
  if (S.discard.length <= 1) return;
  const top = S.discard.pop();
  S.stock = S.discard;
  S.discard = [top];
  for (let i = S.stock.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [S.stock[i], S.stock[j]] = [S.stock[j], S.stock[i]];
  }
}

function endAction() {
  if (S.finisher !== null && S.current !== S.finisher) {
    finishHole();
    return;
  }
  if (allUp(S.current)) {
    S.finisher = S.current;
    if (allUp(1 - S.current)) { finishHole(); return; }
  }
  S.current = 1 - S.current;
  commit();
}

function finishHole() {
  S.phase = "done";
  for (let p = 0; p < 2; p++) S.grids[p].forEach(c => c.up = true);
  const h0 = holeScore(0), h1 = holeScore(1);
  S.scores[0].push(h0);
  S.scores[1].push(h1);
  if (h0 !== h1) S.startingPlayer = h0 < h1 ? 0 : 1;
  else S.startingPlayer = 1 - S.startingPlayer;
  S.gameOver = S.hole >= S.totalHoles;
  commit();
}

// ---------------------------------------------------------------- summary
function syncSummaryOverlay() {
  const overlay = $("summary-overlay");
  if (S.phase !== "done") { overlay.classList.add("hidden"); return; }

  $("summary-title").textContent = S.gameOver ? "Final Results" : `Hole ${S.hole} complete`;
  const winnerEl = $("summary-winner");
  if (S.gameOver) {
    const t0 = total(0), t1 = total(1);
    winnerEl.classList.remove("hidden");
    winnerEl.textContent = t0 === t1 ? "It's a tie!" : `🏆 ${S.names[t0 < t1 ? 0 : 1]} wins!`;
  } else {
    winnerEl.classList.add("hidden");
  }
  $("summary-table").innerHTML = scorecardHTML(true);
  $("summary-next-btn").textContent = S.gameOver
    ? (MODE === "online" ? "Rematch" : "Play Again")
    : `Start hole ${S.hole + 1}`;
  overlay.classList.remove("hidden");
}

function onSummaryNext() {
  if (S.phase !== "done") return;
  if (S.gameOver) {
    if (MODE === "online") {
      S.scores = [[], []];
      S.hole = 1;
      S.startingPlayer = Math.floor(Math.random() * 2);
      dealHole();
      commit();
      toast("Rematch!");
    } else {
      clearLocalSave();
      S = null;
      showSetup();
    }
    return;
  }
  S.hole++;
  dealHole();
  commit();
}

// ---------------------------------------------------------------- scorecard
function scorecardHTML(highlightLast) {
  const rows = [];
  rows.push(`<tr><th>Hole</th><th>${escapeHTML(S.names[0])}</th><th>${escapeHTML(S.names[1] || "—")}</th></tr>`);
  const played = S.scores[0].length;
  for (let h = 0; h < S.totalHoles; h++) {
    const a = h < played ? S.scores[0][h] : "–";
    const b = h < played ? S.scores[1][h] : "–";
    const cls = (highlightLast && h === played - 1) ? ' class="current-hole"' : "";
    rows.push(`<tr${cls}><td>${h + 1}</td><td>${a}</td><td>${b}</td></tr>`);
  }
  const t0 = total(0), t1 = total(1);
  const c0 = t0 < t1 ? ' class="leader"' : "", c1 = t1 < t0 ? ' class="leader"' : "";
  rows.push(`<tr class="total-row"><td>Total</td><td${c0}>${t0}</td><td${c1}>${t1}</td></tr>`);
  return `<table class="scorecard">${rows.join("")}</table>`;
}

// ---------------------------------------------------------------- online flows
function shareURL() { return location.origin + location.pathname + "?g=" + MY.id; }

async function createOnline() {
  const name = $("online-name").value.trim() || "Player 1";
  const holes = parseInt($("holes").value, 10);
  const btn = $("create-online-btn");
  btn.disabled = true; btn.textContent = "Creating…";
  try {
    S = baseState([name, ""], holes);
    MODE = "online";
    const r = await api("POST", { action: "create", state: S });
    MY = { id: r.id, player: 0, token: r.token };
    NETV = r.version;
    S.seats = [null, null]; // server owns real seat hashes
    saveCreds();
    history.replaceState(null, "", "?g=" + MY.id);
    showGame();
    showLobby();
    startPolling();
  } catch (e) {
    toast("Could not create game: " + e.message);
    MODE = null;
  } finally {
    btn.disabled = false; btn.textContent = "Create online game";
  }
}

async function joinOnline(id) {
  const name = $("join-name").value.trim() || "Player 2";
  const btn = $("join-btn");
  btn.disabled = true; btn.textContent = "Joining…";
  try {
    const r = await api("POST", { action: "join", id, name });
    MODE = "online";
    MY = { id, player: 1, token: r.token };
    NETV = r.version;
    S = r.state;
    saveCreds();
    showGame();
    render();
    startPolling();
    toast("Joined! The game will start in a moment…");
  } catch (e) {
    $("join-error").textContent =
      e.status === 403 ? "This game already has two players." :
      e.status === 404 ? "Game not found — check the link." :
      "Could not join: " + e.message;
    $("join-error").classList.remove("hidden");
  } finally {
    btn.disabled = false; btn.textContent = "Join game";
  }
}

async function resumeOnline(creds) {
  MODE = "online";
  MY = creds;
  try {
    const r = await api("GET", { id: MY.id });
    S = r.state; NETV = r.version;
    showGame();
    if (S.phase === "lobby") showLobby();
    render();
    startPolling();
  } catch (e) {
    toast("Couldn't load that game.");
    MODE = null; MY = null;
    history.replaceState(null, "", location.pathname);
    showSetup();
  }
}

function showLobby() {
  $("share-link").value = shareURL();
  $("lobby-overlay").classList.remove("hidden");
}
function hideLobby() { $("lobby-overlay").classList.add("hidden"); }

async function copyShareLink() {
  const url = shareURL();
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied — send it to your opponent!");
  } catch {
    $("share-link").select();
    document.execCommand("copy");
    toast("Link copied!");
  }
}

// ---------------------------------------------------------------- screens
function showSetup() {
  stopPolling();
  $("setup").classList.remove("hidden");
  $("game").classList.add("hidden");
  $("join-panel").classList.add("hidden");
  $("create-panel").classList.remove("hidden");
  const saved = localStorage.getItem(SAVE_KEY);
  $("resume-note").classList.toggle("hidden", !saved);
}

function showJoin(id) {
  $("setup").classList.remove("hidden");
  $("game").classList.add("hidden");
  $("create-panel").classList.add("hidden");
  $("join-panel").classList.remove("hidden");
  $("join-btn").onclick = () => joinOnline(id);
}

function showGame() {
  $("setup").classList.add("hidden");
  $("game").classList.remove("hidden");
  setOnlineStatus(true);
  render();
}

function startLocal() {
  const n1 = $("p1-name").value.trim() || "Player 1";
  const n2 = $("p2-name").value.trim() || "Player 2";
  MODE = "local";
  MY = null;
  S = baseState([n1, n2], parseInt($("holes").value, 10));
  dealHole();
  showGame();
  saveLocal();
}

// ---------------------------------------------------------------- wiring
$("create-online-btn").addEventListener("click", createOnline);
$("start-local-btn").addEventListener("click", () => {
  if ($("local-names").classList.contains("hidden")) {
    $("local-names").classList.remove("hidden");
    $("start-local-btn").textContent = "Start local game";
  } else {
    startLocal();
  }
});
$("resume-btn") && $("resume-btn").addEventListener("click", () => {
  try {
    S = JSON.parse(localStorage.getItem(SAVE_KEY));
    if (!S || !S.grids) throw new Error("bad save");
    MODE = "local";
    showGame();
  } catch {
    clearLocalSave();
    showSetup();
  }
});

$("stock-pile").addEventListener("click", drawFromStock);
$("discard-drawn-btn").addEventListener("click", discardDrawn);
$("summary-next-btn").addEventListener("click", onSummaryNext);
$("copy-link-btn").addEventListener("click", copyShareLink);
$("lobby-back-btn").addEventListener("click", () => {
  stopPolling();
  MODE = null; MY = null; S = null;
  history.replaceState(null, "", location.pathname);
  showSetup();
});

$("newgame-btn").addEventListener("click", () => {
  if (confirm("Leave the current game and go back to the menu?")) {
    if (MODE === "local") clearLocalSave();
    stopPolling();
    MODE = null; MY = null; S = null;
    history.replaceState(null, "", location.pathname);
    showSetup();
  }
});

$("scorecard-btn").addEventListener("click", () => {
  $("scorecard-table").innerHTML = scorecardHTML(false);
  $("scorecard-overlay").classList.remove("hidden");
});
$("scorecard-close-btn").addEventListener("click", () => $("scorecard-overlay").classList.add("hidden"));
$("rules-btn").addEventListener("click", () => $("rules-overlay").classList.remove("hidden"));
$("rules-close-btn").addEventListener("click", () => $("rules-overlay").classList.add("hidden"));

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && MODE === "online") poll();
});

// debug handle (also used by automated tests)
Object.defineProperty(window, "__pn", { get: () => ({ S, MY, NETV, MODE }) });

// ---------------------------------------------------------------- boot
(function boot() {
  const gid = new URLSearchParams(location.search).get("g");
  if (gid) {
    const creds = loadCreds(gid);
    if (creds) resumeOnline(creds);
    else showJoin(gid);
  } else {
    showSetup();
  }
})();
