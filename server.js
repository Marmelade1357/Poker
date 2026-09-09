// Poker - Online-Server
// Einfacher, selbst-gehosteter Mehrspieler-Server auf Basis von Express + Socket.IO.
// Regelwerk: Texas Hold'em, No-Limit, mit Elimination (letzter Spieler mit Chips gewinnt).

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Konstanten
// ---------------------------------------------------------------------------

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 8;
const MAX_ROOMS = 500; // Sicherheitsventil gegen Speicher-Erschöpfung durch Missbrauch
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne verwechselbare Zeichen

const SUITS = ['s', 'h', 'd', 'c'];

const BOT_NAME_POOL = [
  'Bot Ass', 'Bot Bluff', 'Bot Chip', 'Bot Ante',
  'Bot River', 'Bot Flop', 'Bot Showdown', 'Bot Allin',
];

// Blind-Level als Vielfaches des vom Host eingestellten Small Blind.
// Big Blind ist immer das Doppelte. Wird nur bei blindMode "levels" verwendet.
const LEVEL_SB_MULTIPLIER = [1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 100, 150, 200];

// Verzögerungen für Bot-Aktionen bzw. Anzeigepausen - über Umgebungsvariablen
// konfigurierbar, damit automatisierte Tests nicht in Echtzeit-Tempo laufen müssen.
const BOT_DELAY_MIN = Number(process.env.BOT_DELAY_MIN_MS) || 900;
const BOT_DELAY_MAX = Number(process.env.BOT_DELAY_MAX_MS) || 2000;
const HAND_RESULT_DELAY_MS = Number(process.env.HAND_RESULT_DELAY_MS) || 7000;
const RUNOUT_DELAY_MS = Number(process.env.RUNOUT_DELAY_MS) || 900;

function randomDelay(min = BOT_DELAY_MIN, max = BOT_DELAY_MAX) {
  return min + Math.random() * (max - min);
}

function rankChar(r) {
  if (r === 14) return 'A';
  if (r === 13) return 'K';
  if (r === 12) return 'Q';
  if (r === 11) return 'J';
  if (r === 10) return 'T';
  return String(r);
}

function buildDeck() {
  const deck = [];
  SUITS.forEach((suit) => {
    for (let rank = 2; rank <= 14; rank++) {
      deck.push({ id: `${rankChar(rank)}${suit}`, rank, suit });
    }
  });
  return deck; // 52 Karten
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    }
  } while (rooms.has(code));
  return code;
}

function makeId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ---------------------------------------------------------------------------
// Handbewertung (Texas Hold'em: beste 5 aus 7 Karten)
// ---------------------------------------------------------------------------

function combinations(arr, k) {
  const results = [];
  function rec(start, combo) {
    if (combo.length === k) { results.push(combo.slice()); return; }
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]);
      rec(i + 1, combo);
      combo.pop();
    }
  }
  rec(0, []);
  return results;
}

// Bewertet genau 5 Karten. Rückgabe ist ein Array [Kategorie, Kicker...],
// das sich elementweise (lexikographisch) mit einer anderen Bewertung
// vergleichen lässt - höher gewinnt. Kategorien: 8 Straight Flush,
// 7 Vierling, 6 Full House, 5 Flush, 4 Straße, 3 Drilling, 2 Zwei Paare,
// 1 Ein Paar, 0 High Card.
function rank5(cards) {
  const ranks = cards.map((c) => c.rank).sort((a, b) => b - a);
  const isFlush = cards.every((c) => c.suit === cards[0].suit);

  const uniqueRanks = Array.from(new Set(ranks)).sort((a, b) => b - a);
  let straightHigh = null;
  if (uniqueRanks.length === 5) {
    if (uniqueRanks[0] - uniqueRanks[4] === 4) straightHigh = uniqueRanks[0];
    else if (uniqueRanks.join(',') === '14,5,4,3,2') straightHigh = 5; // Ass-Straße (Wheel)
  }
  const isStraight = straightHigh !== null;

  const counts = {};
  ranks.forEach((r) => { counts[r] = (counts[r] || 0) + 1; });
  const groups = Object.entries(counts)
    .map(([r, c]) => ({ rank: Number(r), count: c }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);
  const pattern = groups.map((g) => g.count).join('');

  if (isStraight && isFlush) return [8, straightHigh];
  if (pattern === '41') return [7, groups[0].rank, groups[1].rank];
  if (pattern === '32') return [6, groups[0].rank, groups[1].rank];
  if (isFlush) return [5, ...ranks];
  if (isStraight) return [4, straightHigh];
  if (pattern === '311') return [3, groups[0].rank, groups[1].rank, groups[2].rank];
  if (pattern === '221') return [2, groups[0].rank, groups[1].rank, groups[2].rank];
  if (pattern === '2111') return [1, groups[0].rank, groups[1].rank, groups[2].rank, groups[3].rank];
  return [0, ...ranks];
}

// ponytail: 21 5er-Kombinationen brute force statt Lookup-Table - bei 8
// Spielern ~170 Aufrufe pro Showdown, völlig unproblematisch.
function evaluateSeven(cards7) {
  let best = null;
  combinations(cards7, 5).forEach((combo) => {
    const r = rank5(combo);
    if (!best || compareRank(r, best) > 0) best = r;
  });
  return best;
}

function compareRank(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

const RANK_NAME = {
  14: 'Ass', 13: 'König', 12: 'Dame', 11: 'Bube', 10: '10',
  9: '9', 8: '8', 7: '7', 6: '6', 5: '5', 4: '4', 3: '3', 2: '2',
};

// Wandelt eine evaluateSeven()-Bewertung in einen lesbaren deutschen Text um,
// z.B. "Zwei Paare, Damen und Achten" oder "Ass hoch".
function describeRank(rank) {
  const n = (r) => RANK_NAME[r] || String(r);
  switch (rank[0]) {
    case 8: return `Straight Flush, ${n(rank[1])} hoch`;
    case 7: return `Vierling ${n(rank[1])}`;
    case 6: return `Full House, ${n(rank[1])} über ${n(rank[2])}`;
    case 5: return `Flush, ${n(rank[1])} hoch`;
    case 4: return `Straße bis ${n(rank[1])}`;
    case 3: return `Drilling ${n(rank[1])}`;
    case 2: return `Zwei Paare, ${n(rank[1])} und ${n(rank[2])}`;
    case 1: return `Ein Paar ${n(rank[1])}`;
    default: return `${n(rank[1])} hoch`;
  }
}

// ---------------------------------------------------------------------------
// Side Pots
// ---------------------------------------------------------------------------

// contributions: [{ id, amount, folded }] - amount = Gesamteinsatz dieser Hand.
// Baut aus den Einsatzhöhen schichtweise Pots. Wer bei einer Schicht gefoldet
// hat, zahlt trotzdem in den Pot ein, ist aber nicht berechtigt zu gewinnen.
function buildPots(contributions) {
  const positive = contributions.filter((c) => c.amount > 0);
  if (!positive.length) return [];
  const levels = Array.from(new Set(positive.map((c) => c.amount))).sort((a, b) => a - b);
  const pots = [];
  let prev = 0;
  levels.forEach((level) => {
    const layer = level - prev;
    const payers = positive.filter((c) => c.amount >= level);
    const amount = layer * payers.length;
    const eligible = payers.filter((c) => !c.folded).map((c) => c.id);
    // eligible ist praktisch nie leer: wer als Letztes erhöht hat, ist nie
    // derjenige, der später foldet (siehe Setzregeln) - trotzdem abgesichert.
    if (amount > 0 && eligible.length) pots.push({ amount, eligible });
    prev = level;
  });
  const merged = [];
  pots.forEach((p) => {
    const last = merged[merged.length - 1];
    if (last && last.eligible.length === p.eligible.length && last.eligible.every((id) => p.eligible.includes(id))) {
      last.amount += p.amount;
    } else {
      merged.push(p);
    }
  });
  return merged;
}

// ---------------------------------------------------------------------------
// Einfaches Rate-Limiting (Schutz vor Missbrauch, da öffentlich erreichbar)
// ---------------------------------------------------------------------------

function getClientIp(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return socket.handshake.address || 'unknown';
}

const rateLimitHits = new Map();

function isRateLimited(key, limit, windowMs) {
  const now = Date.now();
  const hits = (rateLimitHits.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    rateLimitHits.set(key, hits);
    return true;
  }
  hits.push(now);
  rateLimitHits.set(key, hits);
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of rateLimitHits) {
    const fresh = hits.filter((t) => now - t < 10 * 60 * 1000);
    if (fresh.length) rateLimitHits.set(key, fresh);
    else rateLimitHits.delete(key);
  }
}, 10 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Raumverwaltung
// ---------------------------------------------------------------------------

const rooms = new Map(); // code -> room
const ROOM_CLEANUP_MS = 3 * 60 * 60 * 1000; // Räume ohne Aktivität nach 3h entsorgen

function createRoom() {
  const code = makeRoomCode();
  const room = {
    code,
    hostId: null,
    players: [], // { id, token, name, socketId, connected, isBot }
    phase: 'lobby', // lobby | hand | handend | gameover
    settings: { startingStack: 1000, blindMode: 'fixed', smallBlind: 10, levelMinutes: 10 },
    stacks: {}, // playerId -> chips
    eliminated: [], // playerIds in Ausscheide-Reihenfolge
    winnerId: null,
    placements: null,
    level: 0,
    levelTimer: null,
    buttonIndex: 0,
    sbId: null,
    bbId: null,
    handNumber: 0,
    deck: [],
    board: [],
    hole: {}, // playerId -> [card, card] (nur wer diese Hand dabei ist)
    street: 'preflop',
    committed: {}, // playerId -> Chips in dieser Setzrunde
    totalCommitted: {}, // playerId -> Chips in dieser Hand
    folded: new Set(),
    allIn: new Set(),
    hasActed: {},
    currentBet: 0,
    minRaise: 0,
    currentTurnIndex: 0,
    handResult: null,
    lastAction: null,
    handEndTimer: null,
    runoutTimer: null,
    logs: [],
    lastActivity: Date.now(),
    cleanupTimer: null,
  };
  rooms.set(code, room);
  touchRoom(room);
  return room;
}

function touchRoom(room) {
  room.lastActivity = Date.now();
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  room.cleanupTimer = setTimeout(() => {
    if (room.levelTimer) clearInterval(room.levelTimer);
    rooms.delete(room.code);
  }, ROOM_CLEANUP_MS);
}

function log(room, text) {
  room.logs.push({ text, at: Date.now() });
  if (room.logs.length > 200) room.logs.shift();
}

function findPlayer(room, playerId) {
  return room.players.find((p) => p.id === playerId);
}

function publicPlayer(room, p) {
  return {
    id: p.id,
    name: p.name,
    connected: p.connected,
    isHost: p.id === room.hostId,
    isBot: p.isBot === true,
    stack: room.stacks[p.id] || 0,
    eliminated: room.eliminated.includes(p.id),
    inHand: !!room.hole[p.id],
    bet: room.committed[p.id] || 0,
    totalBet: room.totalCommitted[p.id] || 0,
    folded: room.folded.has(p.id),
    allIn: room.allIn.has(p.id),
  };
}

function blindsForLevel(room) {
  const base = room.settings.smallBlind;
  const mult = LEVEL_SB_MULTIPLIER[Math.min(room.level, LEVEL_SB_MULTIPLIER.length - 1)];
  const sb = Math.max(1, Math.round(base * mult));
  return { sb, bb: sb * 2 };
}

// Nächster Sitzplatz (im Uhrzeigersinn) mit Chips - für Button/Blind-Zuordnung.
function nextSeatWithChips(room, fromIdx) {
  let idx = fromIdx;
  for (let k = 0; k < room.players.length; k++) {
    idx = (idx + 1) % room.players.length;
    if (room.stacks[room.players[idx].id] > 0) return idx;
  }
  return fromIdx;
}

// Nächster Sitzplatz, der in der laufenden Hand noch am Zug sein kann
// (Karten bekommen, nicht gefoldet, nicht all-in).
function nextToActSeat(room, fromIdx) {
  let idx = fromIdx;
  for (let k = 0; k < room.players.length; k++) {
    idx = (idx + 1) % room.players.length;
    const id = room.players[idx].id;
    if (room.hole[id] && !room.folded.has(id) && !room.allIn.has(id)) return idx;
  }
  return fromIdx;
}

// ---------------------------------------------------------------------------
// Setzrunden-Logik
// ---------------------------------------------------------------------------

function legalActionsFor(room, playerId) {
  if (room.phase !== 'hand') return null;
  if (!room.hole[playerId]) return null;
  if (room.folded.has(playerId) || room.allIn.has(playerId)) return null;
  const turnPlayer = room.players[room.currentTurnIndex];
  if (!turnPlayer || turnPlayer.id !== playerId) return null;

  const stack = room.stacks[playerId] || 0;
  const committed = room.committed[playerId] || 0;
  const toCall = room.currentBet - committed;
  const canCheck = toCall <= 0;
  const callAmount = Math.max(0, Math.min(toCall, stack));
  const canCall = toCall > 0;
  const maxTotal = committed + stack;
  const canRaise = stack > callAmount;
  const raiseMin = canRaise ? Math.min(room.currentBet + room.minRaise, maxTotal) : 0;
  const raiseMax = maxTotal;

  return { canFold: true, canCheck, canCall, callAmount, canRaise, raiseMin, raiseMax };
}

function commitChips(room, playerId, amount) {
  const stack = room.stacks[playerId] || 0;
  const pay = Math.max(0, Math.min(amount, stack));
  room.stacks[playerId] = stack - pay;
  room.committed[playerId] = (room.committed[playerId] || 0) + pay;
  room.totalCommitted[playerId] = (room.totalCommitted[playerId] || 0) + pay;
  if (room.stacks[playerId] === 0) room.allIn.add(playerId);
}

function bettingRoundComplete(room) {
  const contenders = room.players.filter((p) => room.hole[p.id] && !room.folded.has(p.id));
  const stillToAct = contenders.filter((p) => !room.allIn.has(p.id)
    && (!room.hasActed[p.id] || (room.committed[p.id] || 0) !== room.currentBet));
  return stillToAct.length === 0;
}

function applyAction(room, playerId, type, amount) {
  const legal = legalActionsFor(room, playerId);
  if (!legal) return;
  const player = findPlayer(room, playerId);

  if (type === 'fold') {
    room.folded.add(playerId);
    room.lastAction = { playerId, type: 'fold', text: 'Fold' };
    log(room, `${player.name} foldet.`);
  } else if (type === 'check') {
    if (!legal.canCheck) return;
    room.hasActed[playerId] = true;
    room.lastAction = { playerId, type: 'check', text: 'Check' };
    log(room, `${player.name} checkt.`);
  } else if (type === 'call') {
    if (!legal.canCall) return;
    commitChips(room, playerId, legal.callAmount);
    room.hasActed[playerId] = true;
    room.lastAction = { playerId, type: 'call', text: `Call ${legal.callAmount}` };
    log(room, `${player.name} callt ${legal.callAmount}.`);
  } else if (type === 'raise') {
    if (!legal.canRaise) return;
    let total = Math.round(Number(amount));
    if (!Number.isFinite(total)) return;
    total = Math.max(legal.raiseMin, Math.min(legal.raiseMax, total));
    const delta = total - (room.committed[playerId] || 0);
    if (delta <= 0) return;
    const wasBet = room.currentBet === 0;
    const increaseSize = total - room.currentBet;
    commitChips(room, playerId, delta);
    room.currentBet = total;
    if (increaseSize > 0) room.minRaise = increaseSize;
    room.hasActed = {};
    room.hasActed[playerId] = true;
    const allIn = room.allIn.has(playerId) ? ' (All-in)' : '';
    room.lastAction = { playerId, type: 'raise', text: `${wasBet ? 'Bet' : 'Raise auf'} ${total}${allIn}` };
    log(room, `${player.name} erhöht auf ${total}.`);
  } else {
    return;
  }

  touchRoom(room);
  afterAction(room);
}

function afterAction(room) {
  const contenders = room.players.filter((p) => room.hole[p.id] && !room.folded.has(p.id));
  if (contenders.length === 1) { finishHandByFold(room, contenders[0].id); return; }
  if (bettingRoundComplete(room)) { advanceStreetOrShowdown(room); return; }
  room.currentTurnIndex = nextToActSeat(room, room.currentTurnIndex);
  touchRoom(room);
  broadcastState(room);
}

function dealBoard(room, count) {
  for (let i = 0; i < count; i++) room.board.push(room.deck.pop());
}

function advanceStreetOrShowdown(room) {
  if (room.phase !== 'hand') return; // Verteidigung gegen einen verspäteten/doppelten Timer
  const contenders = room.players.filter((p) => room.hole[p.id] && !room.folded.has(p.id));
  room.committed = {};
  room.hasActed = {};
  room.currentBet = 0;
  room.minRaise = blindsForLevel(room).bb;
  room.lastAction = null;

  if (room.street === 'river') { showdown(room); return; }
  if (room.street === 'preflop') { room.street = 'flop'; dealBoard(room, 3); }
  else if (room.street === 'flop') { room.street = 'turn'; dealBoard(room, 1); }
  else if (room.street === 'turn') { room.street = 'river'; dealBoard(room, 1); }

  const nonAllIn = contenders.filter((p) => !room.allIn.has(p.id));
  if (nonAllIn.length <= 1) {
    // Alle bis auf höchstens eine(n) sind all-in: niemand kann mehr
    // handeln (kein Gegenüber, das auf ein Gebot reagieren könnte). currentTurnIndex
    // auf "niemand" setzen - sonst könnte scheduleBotTurnIfNeeded die/den letzte(n)
    // Nicht-All-in-Spieler(in) fälschlich zu einer Aktion einladen, während parallel
    // der Runout-Timer bereits die nächste Straße vorbereitet (doppelte Auszahlung).
    room.currentTurnIndex = -1;
    touchRoom(room);
    broadcastState(room);
    const streetAtSchedule = room.street;
    room.runoutTimer = setTimeout(() => {
      if (!rooms.has(room.code)) return;
      if (room.phase !== 'hand' || room.street !== streetAtSchedule) return;
      advanceStreetOrShowdown(room);
    }, RUNOUT_DELAY_MS);
    return;
  }
  room.currentTurnIndex = nextToActSeat(room, room.buttonIndex);
  touchRoom(room);
  broadcastState(room);
}

// Schickt einen abgeschlossenen Hand-Eintrag als eigenes Event, statt ihn bei
// jedem gameState mitzuschicken - die Historie wächst über eine Partie hinweg
// und würde sonst unnötig oft komplett neu übertragen werden.
function pushHistoryEntry(room, entry) {
  io.to(room.code).emit('handHistoryEntry', entry);
}

function finishHandByFold(room, winnerId) {
  const potAmount = Object.values(room.totalCommitted).reduce((a, b) => a + b, 0);
  room.stacks[winnerId] = (room.stacks[winnerId] || 0) + potAmount;
  room.handResult = { type: 'fold', winnerId, amount: potAmount, board: room.board.slice() };
  room.phase = 'handend';
  log(room, `${findPlayer(room, winnerId).name} gewinnt ${potAmount} Chips (alle anderen gefoldet).`);
  pushHistoryEntry(room, { handNumber: room.handNumber, ...room.handResult });
  touchRoom(room);
  broadcastState(room);
  afterHandDelay(room);
}

function showdown(room) {
  const contenders = room.players.filter((p) => room.hole[p.id] && !room.folded.has(p.id));
  const scored = contenders.map((p) => ({ id: p.id, rank: evaluateSeven(room.hole[p.id].concat(room.board)) }));
  const contributions = room.players
    .filter((p) => room.hole[p.id])
    .map((p) => ({ id: p.id, amount: room.totalCommitted[p.id] || 0, folded: room.folded.has(p.id) }));
  const pots = buildPots(contributions);

  const awards = [];
  pots.forEach((pot) => {
    const candidates = scored.filter((s) => pot.eligible.includes(s.id));
    let winners = [];
    candidates.forEach((c) => {
      if (!winners.length || compareRank(c.rank, candidates.find((w) => w.id === winners[0]).rank) > 0) {
        winners = [c.id];
      } else if (compareRank(c.rank, candidates.find((w) => w.id === winners[0]).rank) === 0) {
        winners.push(c.id);
      }
    });
    const share = Math.floor(pot.amount / winners.length);
    let remainder = pot.amount - share * winners.length;
    winners.forEach((id) => {
      const extra = remainder > 0 ? 1 : 0;
      if (remainder > 0) remainder -= 1;
      room.stacks[id] = (room.stacks[id] || 0) + share + extra;
    });
    const winningRank = candidates.find((c) => c.id === winners[0]).rank;
    awards.push({ amount: pot.amount, winners, description: describeRank(winningRank) });
  });

  const reveal = {};
  contenders.forEach((p) => {
    const found = scored.find((s) => s.id === p.id);
    reveal[p.id] = { cards: room.hole[p.id], description: describeRank(found.rank) };
  });
  room.handResult = { type: 'showdown', board: room.board.slice(), reveal, pots: awards };
  room.phase = 'handend';
  log(room, `Showdown: ${awards.map((a) => `${a.winners.map((id) => findPlayer(room, id).name).join('+')} gewinnt ${a.amount} mit ${a.description}`).join(', ')}.`);
  pushHistoryEntry(room, { handNumber: room.handNumber, ...room.handResult });
  touchRoom(room);
  broadcastState(room);
  afterHandDelay(room);
}

function afterHandDelay(room) {
  room.handEndTimer = setTimeout(() => {
    if (!rooms.has(room.code)) return;
    advanceAfterHand(room);
  }, HAND_RESULT_DELAY_MS);
}

function advanceAfterHand(room) {
  room.players.forEach((p) => {
    if ((room.stacks[p.id] || 0) <= 0 && !room.eliminated.includes(p.id)) {
      room.eliminated.push(p.id);
      log(room, `${p.name} ist ausgeschieden.`);
    }
  });
  const remaining = room.players.filter((p) => (room.stacks[p.id] || 0) > 0);
  if (remaining.length <= 1) {
    room.phase = 'gameover';
    room.winnerId = remaining[0] ? remaining[0].id : null;
    room.placements = [room.winnerId, ...room.eliminated.slice().reverse()].filter(Boolean);
    if (room.levelTimer) { clearInterval(room.levelTimer); room.levelTimer = null; }
    log(room, `Spiel beendet. Gewinner: ${remaining[0] ? remaining[0].name : '?'}.`);
    touchRoom(room);
    broadcastState(room);
    return;
  }
  startHand(room);
  broadcastState(room);
}

function startHand(room) {
  room.handNumber += 1;
  if (room.handNumber > 1) room.buttonIndex = nextSeatWithChips(room, room.buttonIndex);
  const contenders = room.players.filter((p) => room.stacks[p.id] > 0);

  room.deck = shuffle(buildDeck());
  room.board = [];
  room.street = 'preflop';
  room.folded = new Set();
  room.allIn = new Set();
  room.committed = {};
  room.totalCommitted = {};
  room.hasActed = {};
  room.hole = {};
  room.handResult = null;
  room.lastAction = null;

  let seat = room.buttonIndex;
  const dealOrder = [];
  for (let i = 0; i < room.players.length; i++) {
    seat = (seat + 1) % room.players.length;
    if (room.stacks[room.players[seat].id] > 0) dealOrder.push(room.players[seat].id);
  }
  dealOrder.forEach((id) => { room.hole[id] = [room.deck.pop(), room.deck.pop()]; });

  const { sb, bb } = blindsForLevel(room);
  let sbIdx, bbIdx, firstIdx;
  if (contenders.length === 2) {
    sbIdx = room.buttonIndex;
    bbIdx = nextSeatWithChips(room, room.buttonIndex);
    firstIdx = sbIdx; // Heads-up: Button/SB ist preflop zuerst am Zug
  } else {
    sbIdx = nextSeatWithChips(room, room.buttonIndex);
    bbIdx = nextSeatWithChips(room, sbIdx);
    firstIdx = nextSeatWithChips(room, bbIdx);
  }
  const sbId = room.players[sbIdx].id;
  const bbId = room.players[bbIdx].id;
  room.sbId = sbId;
  room.bbId = bbId;
  commitChips(room, sbId, sb);
  commitChips(room, bbId, bb);
  room.currentBet = room.committed[bbId];
  room.minRaise = bb;
  room.currentTurnIndex = firstIdx;
  room.phase = 'hand';
  log(room, `Hand ${room.handNumber}: Blinds ${sb}/${bb}. ${findPlayer(room, sbId).name} (SB), ${findPlayer(room, bbId).name} (BB).`);
  touchRoom(room);
}

function setLevelTimer(room) {
  if (room.levelTimer) clearInterval(room.levelTimer);
  if (room.settings.blindMode !== 'levels') return;
  room.levelTimer = setInterval(() => {
    room.level += 1;
    const { sb, bb } = blindsForLevel(room);
    log(room, `Blinds erhöhen sich: Level ${room.level + 1} (${sb}/${bb}).`);
    touchRoom(room);
    broadcastState(room);
  }, Math.max(1, room.settings.levelMinutes) * 60 * 1000);
}

function startGame(room) {
  room.stacks = {};
  room.players.forEach((p) => { room.stacks[p.id] = room.settings.startingStack; });
  room.eliminated = [];
  room.winnerId = null;
  room.placements = null;
  room.level = 0;
  room.handNumber = 0;
  room.buttonIndex = Math.floor(Math.random() * room.players.length);
  room.logs = [];
  log(room, 'Das Spiel beginnt.');
  setLevelTimer(room);
  startHand(room);
}

// ---------------------------------------------------------------------------
// Öffentlicher Zustand
// ---------------------------------------------------------------------------

function publicState(room) {
  const turnPlayer = room.phase === 'hand' ? room.players[room.currentTurnIndex] : null;
  const buttonPlayer = room.players[room.buttonIndex];
  const blinds = blindsForLevel(room);
  return {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    settings: room.settings,
    players: room.players.map((p) => publicPlayer(room, p)),
    buttonId: buttonPlayer ? buttonPlayer.id : null,
    sbId: room.sbId,
    bbId: room.bbId,
    handNumber: room.handNumber,
    level: room.level,
    smallBlind: blinds.sb,
    bigBlind: blinds.bb,
    street: room.street,
    board: room.board,
    pot: Object.values(room.totalCommitted).reduce((a, b) => a + b, 0),
    currentBet: room.currentBet,
    currentTurnId: turnPlayer ? turnPlayer.id : null,
    lastAction: room.lastAction || null,
    handResult: room.handResult,
    winnerId: room.winnerId || null,
    placements: room.placements || null,
    logs: room.logs.slice(-30),
  };
}

function sendCardsTo(room, player) {
  if (!player.socketId) return;
  const hole = room.hole[player.id] || null;
  const legal = hole ? legalActionsFor(room, player.id) : null;
  io.to(player.socketId).emit('yourCards', { hole, legal });
}

function broadcastState(room) {
  io.to(room.code).emit('gameState', publicState(room));
  room.players.forEach((p) => sendCardsTo(room, p));
  scheduleBotTurnIfNeeded(room);
}

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------

function addBot(room) {
  if (room.players.length >= MAX_PLAYERS) return null;
  const usedNames = new Set(room.players.map((p) => p.name));
  const name = BOT_NAME_POOL.find((n) => !usedNames.has(n)) || `Bot ${room.players.length + 1}`;
  const bot = { id: makeId(), token: null, name, socketId: null, connected: true, isBot: true };
  room.players.push(bot);
  log(room, `${name} (Bot) wurde hinzugefügt.`);
  return bot;
}

function preflopScore(hole) {
  const [c1, c2] = hole;
  const hi = Math.max(c1.rank, c2.rank);
  const lo = Math.min(c1.rank, c2.rank);
  const pair = c1.rank === c2.rank;
  const suited = c1.suit === c2.suit;
  const gap = hi - lo;
  let score = (hi + lo - 4) / 24;
  if (pair) score += 0.28;
  if (suited) score += 0.07;
  if (!pair && gap <= 1) score += 0.06;
  else if (!pair && gap === 2) score += 0.03;
  return Math.max(0, Math.min(1, score));
}

function postflopScore(hole, board) {
  const rank = evaluateSeven(hole.concat(board));
  return Math.min(1, rank[0] / 8 + (rank[1] || 0) / 100);
}

// ponytail: einfache Heuristik (Handstärke + Pot-Odds), kein Solver.
function decideBotAction(room, playerId) {
  const legal = legalActionsFor(room, playerId);
  if (!legal) return null;
  const hole = room.hole[playerId];
  const strength = room.board.length ? postflopScore(hole, room.board) : preflopScore(hole);
  const pot = Object.values(room.totalCommitted).reduce((a, b) => a + b, 0);
  const potOdds = legal.callAmount > 0 ? legal.callAmount / (pot + legal.callAmount) : 0;

  if (!legal.canCall) {
    if (legal.canRaise && strength > 0.68 && Math.random() < 0.55) {
      const size = Math.round(legal.raiseMin + Math.random() * (legal.raiseMax - legal.raiseMin) * 0.4);
      return { type: 'raise', amount: Math.min(size, legal.raiseMax) };
    }
    return { type: 'check' };
  }
  if (strength < potOdds * 1.15 && strength < 0.45) {
    return { type: 'fold' };
  }
  if (legal.canRaise && strength > 0.8 && Math.random() < 0.35) {
    const size = Math.round(legal.raiseMin + Math.random() * (legal.raiseMax - legal.raiseMin) * 0.5);
    return { type: 'raise', amount: Math.min(size, legal.raiseMax) };
  }
  return { type: 'call' };
}

function scheduleBotTurnIfNeeded(room) {
  if (room.phase !== 'hand') return;
  const turnPlayer = room.players[room.currentTurnIndex];
  if (!turnPlayer) return;
  const isDisconnectedHuman = !turnPlayer.isBot && !turnPlayer.connected;
  if (!turnPlayer.isBot && !isDisconnectedHuman) return;
  if (!room.hole[turnPlayer.id] || room.folded.has(turnPlayer.id) || room.allIn.has(turnPlayer.id)) return;

  const turnIdxAtSchedule = room.currentTurnIndex;
  const streetAtSchedule = room.street;
  setTimeout(() => {
    if (!rooms.has(room.code)) return;
    if (room.phase !== 'hand') return;
    if (room.currentTurnIndex !== turnIdxAtSchedule || room.street !== streetAtSchedule) return;
    let action;
    if (isDisconnectedHuman) {
      // ponytail: kein Zug-Timer für Menschen, aber ein getrennter Spieler
      // darf das Spiel nicht dauerhaft blockieren - checkt oder foldet.
      const legal = legalActionsFor(room, turnPlayer.id);
      action = legal && legal.canCheck ? { type: 'check' } : { type: 'fold' };
    } else {
      action = decideBotAction(room, turnPlayer.id);
    }
    if (!action) return;
    applyAction(room, turnPlayer.id, action.type, action.amount);
  }, randomDelay());
}

// ---------------------------------------------------------------------------
// Socket.IO
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name }, cb) => {
    try {
      if (isRateLimited(`createRoom:${getClientIp(socket)}`, 8, 60 * 1000)) {
        return cb({ ok: false, error: 'Zu viele neue Räume in kurzer Zeit. Bitte kurz warten und erneut versuchen.' });
      }
      if (rooms.size >= MAX_ROOMS) {
        return cb({ ok: false, error: 'Gerade sind zu viele Räume aktiv. Bitte versuche es in ein paar Minuten erneut.' });
      }
      name = (name || '').trim().slice(0, 20) || 'Spieler';
      const room = createRoom();
      const player = { id: makeId(), token: makeId(), name, socketId: socket.id, connected: true };
      room.hostId = player.id;
      room.players.push(player);
      socket.join(room.code);
      socket.data.roomCode = room.code;
      socket.data.playerId = player.id;
      log(room, `${name} hat den Raum erstellt.`);
      touchRoom(room);
      cb({ ok: true, code: room.code, playerId: player.id, token: player.token });
      broadcastState(room);
    } catch (err) {
      cb({ ok: false, error: 'Raum konnte nicht erstellt werden.' });
    }
  });

  socket.on('joinRoom', ({ code, name, token }, cb) => {
    if (isRateLimited(`joinRoom:${getClientIp(socket)}`, 20, 60 * 1000)) {
      return cb({ ok: false, error: 'Zu viele Versuche in kurzer Zeit. Bitte kurz warten und erneut versuchen.' });
    }
    code = (code || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: 'Diesen Raum gibt es nicht.' });

    if (token) {
      const existing = room.players.find((p) => p.token === token);
      if (existing) {
        existing.socketId = socket.id;
        existing.connected = true;
        socket.join(room.code);
        socket.data.roomCode = room.code;
        socket.data.playerId = existing.id;
        touchRoom(room);
        log(room, `${existing.name} ist wieder verbunden.`);
        cb({ ok: true, code: room.code, playerId: existing.id, token: existing.token, rejoined: true });
        broadcastState(room);
        return;
      }
    }

    if (room.phase !== 'lobby') {
      return cb({ ok: false, error: 'Das Spiel läuft bereits. Bitte warte auf die nächste Partie.' });
    }
    if (room.players.length >= MAX_PLAYERS) {
      return cb({ ok: false, error: `Der Raum ist bereits voll (max. ${MAX_PLAYERS} Spieler).` });
    }
    name = (name || '').trim().slice(0, 20) || 'Spieler';
    if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      return cb({ ok: false, error: 'Dieser Name ist im Raum bereits vergeben.' });
    }
    const player = { id: makeId(), token: makeId(), name, socketId: socket.id, connected: true };
    room.players.push(player);
    if (!room.hostId) room.hostId = player.id;
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    touchRoom(room);
    log(room, `${name} ist dem Raum beigetreten.`);
    cb({ ok: true, code: room.code, playerId: player.id, token: player.token });
    broadcastState(room);
  });

  socket.on('leaveRoom', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const player = findPlayer(room, socket.data.playerId);
    if (!player) return;

    if (room.phase === 'lobby') {
      room.players = room.players.filter((p) => p.id !== player.id);
      if (room.hostId === player.id) {
        room.hostId = room.players.length ? room.players[0].id : null;
      }
      log(room, `${player.name} hat den Raum verlassen.`);
    } else {
      player.connected = false;
      log(room, `${player.name} hat das Spiel verlassen.`);
    }

    socket.leave(room.code);
    socket.data.roomCode = null;
    socket.data.playerId = null;
    touchRoom(room);
    if (room.players.length === 0) {
      if (room.levelTimer) clearInterval(room.levelTimer);
      rooms.delete(room.code);
    } else {
      broadcastState(room);
    }
  });

  socket.on('kickPlayer', ({ playerId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'lobby') return;
    if (socket.data.playerId !== room.hostId) return;
    if (playerId === room.hostId) return;
    room.players = room.players.filter((p) => p.id !== playerId);
    touchRoom(room);
    broadcastState(room);
  });

  socket.on('addBot', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'lobby') return;
    if (socket.data.playerId !== room.hostId) return;
    addBot(room);
    touchRoom(room);
    broadcastState(room);
  });

  socket.on('removeBot', ({ botId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'lobby') return;
    if (socket.data.playerId !== room.hostId) return;
    const bot = findPlayer(room, botId);
    if (!bot || !bot.isBot) return;
    room.players = room.players.filter((p) => p.id !== botId);
    touchRoom(room);
    broadcastState(room);
  });

  socket.on('fillBots', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'lobby') return;
    if (socket.data.playerId !== room.hostId) return;
    while (room.players.length < MIN_PLAYERS) addBot(room);
    touchRoom(room);
    broadcastState(room);
  });

  socket.on('setSettings', (settings) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'lobby') return;
    if (socket.data.playerId !== room.hostId) return;
    const s = settings || {};
    const startingStack = Math.round(Number(s.startingStack));
    const smallBlind = Math.round(Number(s.smallBlind));
    const levelMinutes = Math.round(Number(s.levelMinutes));
    if (Number.isFinite(startingStack)) room.settings.startingStack = Math.max(50, Math.min(1000000, startingStack));
    if (Number.isFinite(smallBlind)) room.settings.smallBlind = Math.max(1, Math.min(100000, smallBlind));
    if (Number.isFinite(levelMinutes)) room.settings.levelMinutes = Math.max(1, Math.min(120, levelMinutes));
    if (s.blindMode === 'fixed' || s.blindMode === 'levels') room.settings.blindMode = s.blindMode;
    broadcastState(room);
  });

  socket.on('startGame', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'lobby') return;
    if (socket.data.playerId !== room.hostId) return;
    if (room.players.length < MIN_PLAYERS || room.players.length > MAX_PLAYERS) return;
    startGame(room);
    broadcastState(room);
  });

  socket.on('action', ({ type, amount }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    applyAction(room, socket.data.playerId, type, amount);
  });

  socket.on('resetGame', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.data.playerId !== room.hostId) return;
    if (room.handEndTimer) clearTimeout(room.handEndTimer);
    if (room.runoutTimer) clearTimeout(room.runoutTimer);
    if (room.levelTimer) clearInterval(room.levelTimer);
    room.phase = 'lobby';
    room.stacks = {};
    room.eliminated = [];
    room.winnerId = null;
    room.placements = null;
    room.level = 0;
    room.levelTimer = null;
    room.handNumber = 0;
    room.sbId = null;
    room.bbId = null;
    room.deck = [];
    room.board = [];
    room.hole = {};
    room.street = 'preflop';
    room.committed = {};
    room.totalCommitted = {};
    room.folded = new Set();
    room.allIn = new Set();
    room.hasActed = {};
    room.currentBet = 0;
    room.minRaise = 0;
    room.handResult = null;
    room.lastAction = null;
    room.logs = [];
    log(room, 'Zurück zur Lobby. Bereit für eine neue Partie.');
    touchRoom(room);
    broadcastState(room);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const player = findPlayer(room, socket.data.playerId);
    if (!player) return;
    // Bei einem Reconnect übernimmt ein neuer Socket bereits player.socketId,
    // bevor das 'disconnect'-Event des alten Sockets eintrifft (Reihenfolge
    // nicht garantiert). Ohne diese Prüfung würde das verspätete Event die
    // Person fälschlich als getrennt markieren, obwohl sie längst wieder
    // verbunden ist - Folge: der Server würde ihre Züge automatisch
    // wegklicken (Check/Fold), als wäre niemand da.
    if (player.socketId !== socket.id) return;
    player.connected = false;
    log(room, `${player.name} hat die Verbindung verloren.`);
    touchRoom(room);
    broadcastState(room);
  });
});

server.listen(PORT, () => {
  console.log(`Poker läuft auf Port ${PORT}`);
  console.log(`Lokal öffnen unter: http://localhost:${PORT}`);
});

module.exports = {
  buildDeck, shuffle, evaluateSeven, compareRank, buildPots, SUITS,
};
