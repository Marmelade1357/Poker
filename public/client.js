(function () {
  // Ermittelt automatisch, unter welchem Pfad-Präfix diese Seite gerade läuft
  // (z.B. "" bei direktem Zugriff, "/poker" hinter einem gemeinsamen Hub).
  const MOUNT_PREFIX = window.location.pathname.replace(/\/[^/]*$/, '');
  const socket = io({ path: MOUNT_PREFIX + '/socket.io/' });

  if (MOUNT_PREFIX) {
    const backHub = document.getElementById('btn-back-hub-home');
    if (backHub) {
      backHub.href = '/';
      backHub.classList.remove('hidden');
    }
  }

  const SESSION_KEY = 'poker_session';
  const SOUND_KEY = 'poker_sound';
  const SUIT_SYMBOL = { s: '♠', h: '♥', d: '♦', c: '♣' };
  const RANK_LABEL = { T: '10' };

  let session = null; // { code, playerId, token, name }
  let latestState = null;
  let myHole = null;
  let myLegal = null;
  let raiseAmount = 0;
  let preAction = null; // 'checkfold' | 'callany' | null - vorab gewählte Aktion für den nächsten eigenen Zug
  let handHistory = []; // strukturierter Verlauf abgeschlossener Hände (session-lokal)
  let prevBoardLen = 0;
  let soundOn = localStorage.getItem(SOUND_KEY) !== 'off';

  // ---------------------------------------------------------------------
  // Sound - kurze synthetisierte Töne statt Audio-Dateien (kein Asset nötig).
  // ---------------------------------------------------------------------

  let audioCtx = null;
  function playTone(freq, duration, delay, volume) {
    if (!soundOn) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const t0 = audioCtx.currentTime + (delay || 0);
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(volume || 0.15, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t0);
      osc.stop(t0 + duration + 0.02);
    } catch (e) { /* Web Audio nicht verfügbar - Sound einfach überspringen */ }
  }
  function playDealSound() { playTone(520, 0.06, 0, 0.12); }
  function playTurnSound() { playTone(660, 0.1, 0, 0.14); playTone(880, 0.12, 0.1, 0.14); }
  function playWinSound() { [523, 659, 784].forEach((f, i) => playTone(f, 0.18, i * 0.1, 0.16)); }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  function $(id) { return document.getElementById(id); }
  function show(elm) { elm.classList.remove('hidden'); }
  function hide(elm) { elm.classList.add('hidden'); }

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => hide(s));
    show($(id));
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    show(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => hide(t), 3200);
  }

  function saveSession() { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); }
  function clearSession() { localStorage.removeItem(SESSION_KEY); session = null; }
  function loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function myId() { return session ? session.playerId : null; }

  function el(tag, opts, children) {
    const e = document.createElement(tag);
    if (opts) {
      Object.entries(opts).forEach(([k, v]) => {
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k === 'html') e.innerHTML = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v);
      });
    }
    (children || []).forEach((c) => e.appendChild(c));
    return e;
  }

  function playerName(state, id) {
    const p = (state.players || []).find((pl) => pl.id === id);
    return p ? p.name : '?';
  }

  function renderCardEl(card, extraClass) {
    if (!card) {
      return el('div', { class: ['pcard', 'pcard-back', extraClass].filter(Boolean).join(' ') });
    }
    const classes = ['pcard'];
    if (extraClass) classes.push(extraClass);
    const rankChar = card.id.slice(0, -1);
    const div = el('div', { class: classes.join(' '), 'data-suit': card.suit }, [
      el('span', { class: 'pcard-rank', text: RANK_LABEL[rankChar] || rankChar }),
      el('span', { class: 'pcard-suit', text: SUIT_SYMBOL[card.suit] || '?' }),
    ]);
    return div;
  }

  // Baut eine Reihe von Chip-Stapeln für die gegebene Chip-Anzahl - ab
  // chipsPerStack kommt statt eines höheren Turms ein neuer Stapel dazu, bis
  // maxStacks erreicht ist; danach wachsen die vorhandenen Stapel weiter in
  // die Höhe, statt einen weiteren Stapel anzufügen.
  function buildChipStacksRow(chipCount, chipsPerStack, extraChipClass, maxStacks) {
    const stacksRow = el('div', { class: 'chip-stacks-row' });
    const rawStackCount = Math.ceil(chipCount / chipsPerStack);
    const stackCount = maxStacks ? Math.min(maxStacks, rawStackCount) : rawStackCount;
    const base = Math.floor(chipCount / stackCount);
    const extra = chipCount % stackCount;
    for (let s = 0; s < stackCount; s++) {
      const inThisStack = base + (s < extra ? 1 : 0);
      const icons = [];
      for (let c = 0; c < inThisStack; c++) {
        icons.push(el('span', { class: ['chip-icon', extraChipClass].filter(Boolean).join(' ') }));
      }
      stacksRow.appendChild(el('div', { class: 'chip-stack' }, icons));
    }
    return stacksRow;
  }

  // ---------------------------------------------------------------------
  // Start screen
  // ---------------------------------------------------------------------

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach((p) => hide(p));
      show($('tab-' + btn.dataset.tab));
    });
  });

  $('btn-create').addEventListener('click', () => {
    const name = $('create-name').value.trim();
    if (!name) return toast('Bitte gib deinen Namen ein.');
    socket.emit('createRoom', { name }, (res) => {
      if (!res.ok) return toast(res.error || 'Fehler beim Erstellen.');
      session = { code: res.code, playerId: res.playerId, token: res.token, name };
      saveSession();
    });
  });

  $('btn-join').addEventListener('click', () => {
    const name = $('join-name').value.trim();
    const code = $('join-code').value.trim().toUpperCase();
    if (!name) return toast('Bitte gib deinen Namen ein.');
    if (!code) return toast('Bitte gib den Raum-Code ein.');
    socket.emit('joinRoom', { code, name }, (res) => {
      if (!res.ok) return toast(res.error || 'Beitritt fehlgeschlagen.');
      session = { code: res.code, playerId: res.playerId, token: res.token, name };
      saveSession();
    });
  });

  $('btn-leave-lobby').addEventListener('click', () => {
    socket.emit('leaveRoom');
    clearSession();
    latestState = null;
    handHistory = [];
    showScreen('screen-home');
  });

  $('btn-leave-game').addEventListener('click', () => {
    socket.emit('leaveRoom');
    clearSession();
    latestState = null;
    handHistory = [];
    showScreen('screen-home');
  });

  function updateSoundButton() { $('btn-toggle-sound').textContent = soundOn ? '🔊' : '🔇'; }
  updateSoundButton();
  $('btn-toggle-sound').addEventListener('click', () => {
    soundOn = !soundOn;
    localStorage.setItem(SOUND_KEY, soundOn ? 'on' : 'off');
    updateSoundButton();
  });

  $('btn-add-bot').addEventListener('click', () => socket.emit('addBot'));
  $('btn-fill-bots').addEventListener('click', () => socket.emit('fillBots'));
  $('btn-start').addEventListener('click', () => socket.emit('startGame'));

  function emitSettings() {
    const blindMode = document.querySelector('input[name="blind-mode"]:checked').value;
    socket.emit('setSettings', {
      startingStack: $('input-stack').value,
      blindMode,
      smallBlind: $('input-smallblind').value,
      levelMinutes: $('input-levelminutes').value,
    });
  }
  $('input-stack').addEventListener('change', emitSettings);
  $('input-smallblind').addEventListener('change', emitSettings);
  $('input-levelminutes').addEventListener('change', emitSettings);
  document.querySelectorAll('input[name="blind-mode"]').forEach((r) => {
    r.addEventListener('change', () => {
      const mode = document.querySelector('input[name="blind-mode"]:checked').value;
      $('lobby-level-minutes-wrap').classList.toggle('hidden', mode !== 'levels');
      emitSettings();
    });
  });

  $('btn-show-log').addEventListener('click', () => {
    renderHistoryModal();
    show($('log-modal'));
  });
  $('btn-close-log-modal').addEventListener('click', () => hide($('log-modal')));

  // ---------------------------------------------------------------------
  // Socket events
  // ---------------------------------------------------------------------

  socket.on('connect', () => {
    const saved = loadSession();
    if (saved && saved.code && saved.token) {
      session = saved;
      socket.emit('joinRoom', { code: saved.code, name: saved.name, token: saved.token }, (res) => {
        if (!res.ok) {
          clearSession();
          showScreen('screen-home');
        } else {
          session.playerId = res.playerId;
          session.token = res.token;
          saveSession();
        }
      });
    }
  });

  socket.on('handHistoryEntry', (entry) => {
    handHistory.unshift(entry);
    if (handHistory.length > 50) handHistory.length = 50;
    if (!$('log-modal').classList.contains('hidden')) renderHistoryModal();
  });

  // Vorab gewählte Aktion (Check/Fold oder Call) sofort auslösen, sobald man
  // tatsächlich am Zug ist - 'yourCards' und 'gameState' treffen als zwei
  // getrennte Events ein, daher nach beiden prüfen (Reihenfolge nicht garantiert).
  function maybeFirePreAction() {
    const state = latestState;
    if (!state || state.phase !== 'hand' || state.currentTurnId !== myId() || !myLegal || !preAction) return;
    const legal = myLegal;
    const action = preAction;
    preAction = null;
    myLegal = null;
    if (action === 'checkfold') socket.emit('action', { type: legal.canCheck ? 'check' : 'fold' });
    else if (action === 'callany') socket.emit('action', { type: legal.canCall ? 'call' : 'check' });
  }

  let notifiedTurnKey = null;
  function maybeNotifyMyTurn(state) {
    if (state.phase !== 'hand' || state.currentTurnId !== myId()) return;
    const key = `${state.handNumber}:${state.street}:${state.currentTurnId}`;
    if (key === notifiedTurnKey) return;
    notifiedTurnKey = key;
    if (!preAction) playTurnSound();
  }

  socket.on('yourCards', (data) => {
    myHole = data.hole || null;
    myLegal = data.legal || null;
    if (myLegal) raiseAmount = myLegal.raiseMin;
    maybeFirePreAction();
    if (latestState) render(latestState);
  });

  socket.on('gameState', (state) => {
    latestState = state;
    maybeFirePreAction();
    maybeNotifyMyTurn(state);
    render(state);
  });

  // ---------------------------------------------------------------------
  // Render-Dispatcher
  // ---------------------------------------------------------------------

  let notifiedHandEndKey = null;
  function render(state) {
    if (state.phase === 'lobby') {
      showScreen('screen-lobby');
      renderLobby(state);
      return;
    }
    if (state.phase !== 'hand') preAction = null;
    if (state.phase === 'handend' && state.handResult) {
      const key = `${state.handNumber}:${state.phase}`;
      if (key !== notifiedHandEndKey) {
        notifiedHandEndKey = key;
        const r = state.handResult;
        const won = r.type === 'fold' ? r.winnerId === myId() : r.pots.some((p) => p.winners.includes(myId()));
        if (won) playWinSound();
      }
    }
    showScreen('screen-game');
    renderGame(state);
  }

  // ---------------------------------------------------------------------
  // Lobby
  // ---------------------------------------------------------------------

  function makeRemovePlayerButton(p) {
    const label = p.isBot ? 'Bot' : 'Spieler';
    const btn = el('button', { class: 'remove-bot-btn', text: '✕', title: `${label} entfernen` });
    let confirmTimer = null;
    const reset = () => { clearTimeout(confirmTimer); btn.classList.remove('confirm'); btn.textContent = '✕'; };
    btn.addEventListener('click', () => {
      if (!btn.classList.contains('confirm')) {
        btn.classList.add('confirm');
        btn.textContent = 'Sicher?';
        confirmTimer = setTimeout(reset, 3000);
        return;
      }
      reset();
      if (p.isBot) socket.emit('removeBot', { botId: p.id });
      else socket.emit('kickPlayer', { playerId: p.id });
    });
    return btn;
  }

  function renderLobby(state) {
    $('lobby-code').textContent = state.code;
    $('lobby-count').textContent = state.players.length;

    const list = $('lobby-players');
    list.innerHTML = '';
    state.players.forEach((p) => {
      const tags = [];
      if (p.isHost) tags.push(el('span', { class: 'tag host', text: 'Host' }));
      if (p.isBot) tags.push(el('span', { class: 'tag', text: '🤖 Bot' }));
      if (!p.connected && !p.isBot) tags.push(el('span', { class: 'tag', text: 'getrennt' }));
      const li = el('li', { class: !p.connected && !p.isBot ? 'disconnected' : '' }, [
        el('span', { class: 'player-name' }, [el('span', { text: p.name }), ...tags]),
      ]);
      const isHost = state.hostId === myId();
      if (isHost && p.id !== state.hostId) li.appendChild(makeRemovePlayerButton(p));
      list.appendChild(li);
    });

    const isHost = state.hostId === myId();
    const botControls = $('lobby-bot-controls');
    const fillBtn = $('btn-fill-bots');
    if (isHost) {
      show(botControls);
      if (state.players.length < state.minPlayers) show(fillBtn); else hide(fillBtn);
    } else {
      hide(botControls);
    }

    const settingsBox = $('lobby-settings');
    const settingsDisplay = $('lobby-settings-display');
    const stackInput = $('input-stack');
    const sbInput = $('input-smallblind');
    const levelInput = $('input-levelminutes');
    const levelWrap = $('lobby-level-minutes-wrap');
    if (isHost) {
      show(settingsBox);
      hide(settingsDisplay);
      if (document.activeElement !== stackInput) stackInput.value = state.settings.startingStack;
      if (document.activeElement !== sbInput) sbInput.value = state.settings.smallBlind;
      if (document.activeElement !== levelInput) levelInput.value = state.settings.levelMinutes;
      document.querySelectorAll('input[name="blind-mode"]').forEach((r) => { r.checked = r.value === state.settings.blindMode; });
      levelWrap.classList.toggle('hidden', state.settings.blindMode !== 'levels');
    } else {
      hide(settingsBox);
      show(settingsDisplay);
      const blindText = state.settings.blindMode === 'levels'
        ? `steigend, alle ${state.settings.levelMinutes} Min.`
        : 'fest';
      settingsDisplay.textContent = `Startstack: ${state.settings.startingStack} · Small Blind: ${state.settings.smallBlind} (${blindText})`;
    }

    const startBtn = $('btn-start');
    const statusEl = $('lobby-status');
    if (isHost) {
      const canStart = state.players.length >= state.minPlayers && state.players.length <= state.maxPlayers;
      if (canStart) {
        show(startBtn);
        statusEl.textContent = '';
      } else {
        hide(startBtn);
        statusEl.textContent = `Mindestens ${state.minPlayers} Spieler nötig (max. ${state.maxPlayers}).`;
      }
    } else {
      hide(startBtn);
      statusEl.textContent = 'Warte, bis der Host das Spiel startet …';
    }
  }

  // ---------------------------------------------------------------------
  // Spiel
  // ---------------------------------------------------------------------

  function renderGame(state) {
    $('game-code').textContent = state.code;
    $('blind-badge').textContent = state.settings.blindMode === 'levels'
      ? `Level ${state.level + 1}: ${state.smallBlind}/${state.bigBlind}`
      : `Blinds ${state.smallBlind}/${state.bigBlind}`;

    renderSeats(state);
    renderTable(state);
    renderActionBar(state);
  }

  // Setzt die Spieler-Sitze auf einer Ellipse rund um den Tisch - die eigene
  // Position landet dabei immer unten (wie an einem echten Tisch, bei dem man
  // sich selbst gegenübersitzt).
  function renderSeats(state) {
    const wrap = $('seats');
    wrap.innerHTML = '';
    const players = state.players;
    const n = players.length;
    if (!n) return;

    const meIdx = players.findIndex((p) => p.id === myId());
    const startIdx = meIdx >= 0 ? meIdx : 0;
    const order = [];
    for (let i = 0; i < n; i++) order.push(players[(startIdx + i) % n]);

    const winnerIds = new Set();
    if (state.phase === 'handend' && state.handResult) {
      const r = state.handResult;
      if (r.type === 'fold') winnerIds.add(r.winnerId);
      else if (r.type === 'showdown') r.pots.forEach((p) => p.winners.forEach((id) => winnerIds.add(id)));
    }

    const RX = 46;
    const RY = 42;
    order.forEach((p, i) => {
      const angle = (90 + (i * 360) / n) * (Math.PI / 180);
      const left = 50 + RX * Math.cos(angle);
      const top = 50 + RY * Math.sin(angle);

      const tags = [];
      if (p.isHost) tags.push(el('span', { class: 'tag host', text: 'Host' }));
      if (p.isBot) tags.push(el('span', { class: 'tag', text: '🤖' }));
      if (state.buttonId === p.id) tags.push(el('span', { class: 'tag button', text: 'D' }));
      if (state.sbId === p.id) tags.push(el('span', { class: 'tag sb', text: 'SB' }));
      if (state.bbId === p.id) tags.push(el('span', { class: 'tag bb', text: 'BB' }));
      if (p.allIn) tags.push(el('span', { class: 'tag allin', text: 'All-in' }));
      if (winnerIds.has(p.id)) tags.push(el('span', { class: 'tag winner', text: '🏆' }));

      let betLine = '';
      if (p.eliminated) betLine = 'schaut zu';
      else if (p.folded) betLine = 'gefoldet';

      const cardsRow = el('div', { class: 'seat-cards' });
      const reveal = state.phase === 'handend' && state.handResult && state.handResult.type === 'showdown'
        ? state.handResult.reveal[p.id]
        : null;
      if (reveal) {
        reveal.cards.forEach((c) => cardsRow.appendChild(renderCardEl(c, winnerIds.has(p.id) ? 'pcard-winner' : null)));
      } else if (p.id === myId() && myHole && p.inHand) {
        myHole.forEach((c) => cardsRow.appendChild(renderCardEl(c)));
      } else if (p.inHand && !p.folded) {
        cardsRow.appendChild(renderCardEl(null));
        cardsRow.appendChild(renderCardEl(null));
      }

      const classes = ['seat'];
      if (p.id === myId()) classes.push('me');
      if (!p.connected && !p.isBot) classes.push('disconnected');
      if (p.eliminated) classes.push('eliminated');
      if (state.currentTurnId === p.id) classes.push('active-turn');
      if (p.folded && !p.eliminated) classes.push('folded');
      if (winnerIds.has(p.id)) classes.push('winner');

      const seatEl = el('div', { class: classes.join(' ') }, [
        cardsRow,
        el('div', { class: 'seat-name-row' }, [el('span', { class: 'seat-name-text', text: p.name }), ...tags]),
      ]);
      if (p.stack > 0) {
        // Chip-Berg für den aktuellen Gesamtstack - wächst in Höhe (mehr
        // Chips pro Stapel) UND Breite (mehr Stapel), je mehr jemand hat.
        const holdingsUnit = Math.max(1, Math.round((state.settings.startingStack || 1000) / 16));
        const holdingsCount = Math.min(48, Math.max(2, Math.round(p.stack / holdingsUnit)));
        seatEl.appendChild(buildChipStacksRow(holdingsCount, 5, 'stack-chip', 4));
      }
      seatEl.appendChild(el('div', { class: 'seat-stack', text: String(p.stack) }));
      if (betLine) seatEl.appendChild(el('div', { class: 'seat-bet', text: betLine }));
      if (state.lastAction && state.lastAction.playerId === p.id) {
        seatEl.appendChild(el('div', { class: `seat-action seat-action-${state.lastAction.type}`, text: state.lastAction.text }));
      }
      const justFolded = p.folded && state.lastAction
        && state.lastAction.playerId === p.id && state.lastAction.type === 'fold';
      if (justFolded) {
        // Karten werden verdeckt Richtung Tischmitte "gemuckt" - kein Inhalt
        // preisgegeben, nur eine kurze Wurf-Animation.
        const dx = 50 - left;
        const dy = 50 - top;
        const mag = Math.sqrt(dx * dx + dy * dy) || 1;
        const tossX = Math.round((dx / mag) * 34);
        const tossY = Math.round((dy / mag) * 34);
        seatEl.appendChild(el('div', {
          class: 'fold-toss',
          style: `--toss-x:${tossX}px; --toss-y:${tossY}px;`,
        }, [renderCardEl(null, 'fold-card'), renderCardEl(null, 'fold-card')]));
      }
      seatEl.style.left = `${left}%`;
      seatEl.style.top = `${top}%`;
      wrap.appendChild(seatEl);

      if ((state.phase === 'hand' || state.phase === 'handend') && p.totalBet > 0) {
        // Chips liegen zwischen Sitz und Tischmitte, wie beim echten Einsatz.
        // Zeigt den Gesamteinsatz DIESER Hand (über alle Straßen hinweg), nicht
        // nur die aktuelle Setzrunde - bleibt also über Flop/Turn/River liegen
        // und wird erst zur nächsten Hand wieder geleert.
        // Je größer der Einsatz, desto mehr Chips - ab 4 pro Stapel kommt ein
        // neuer Stapel dazu, statt einen einzelnen Turm immer höher zu türmen.
        const unit = state.bigBlind || 1;
        const chipCount = Math.min(16, Math.max(1, Math.round(p.totalBet / unit)));

        const betLeft = left + (50 - left) * 0.6;
        const betTop = top + (50 - top) * 0.6;
        const isHandEnd = state.phase === 'handend';
        const chipEl = el('div', { class: 'bet-chips' + (isHandEnd ? ' bet-chips-sweep' : '') }, [
          buildChipStacksRow(chipCount, 4),
          el('span', { class: 'chip-amount', text: String(p.totalBet) }),
        ]);
        if (isHandEnd) {
          // Am Handende werden die Chips endgültig Richtung Pot "eingesammelt"
          // und blenden dabei aus - handend wird pro Hand nur einmal gerendert,
          // die Animation läuft also genau einmal statt bei jedem Update.
          const dx = 50 - betLeft;
          const dy = 50 - betTop;
          const mag = Math.sqrt(dx * dx + dy * dy) || 1;
          chipEl.style.setProperty('--sweep-x', `${Math.round((dx / mag) * 40)}px`);
          chipEl.style.setProperty('--sweep-y', `${Math.round((dy / mag) * 40)}px`);
        }
        chipEl.style.left = `${betLeft}%`;
        chipEl.style.top = `${betTop}%`;
        wrap.appendChild(chipEl);
      }
    });
  }

  function renderTable(state) {
    $('pot-display').textContent = `Pot: ${state.pot}`;
    const boardEl = $('board-cards');
    boardEl.innerHTML = '';
    const board = state.board || [];
    // Nur neu aufgedeckte Karten animieren/vertonen (nicht bei jedem
    // gameState-Event den kompletten Board neu "dealen").
    if (board.length > prevBoardLen) playDealSound();
    board.forEach((card, i) => {
      boardEl.appendChild(renderCardEl(card, i >= prevBoardLen ? 'pcard-deal' : null));
    });
    prevBoardLen = board.length;

    const note = $('table-note');
    note.innerHTML = '';

    if (state.phase === 'hand') {
      note.appendChild(el('p', {
        class: 'waiting-note',
        text: state.currentTurnId === myId() ? 'Du bist am Zug.' : `${playerName(state, state.currentTurnId)} ist am Zug …`,
      }));
    } else if (state.phase === 'handend' && state.handResult) {
      renderHandEnd(state, note);
    } else if (state.phase === 'gameover') {
      renderGameOver(state, note);
    }
  }

  function renderHandEnd(state, note) {
    const r = state.handResult;
    const banner = el('div', { class: 'winner-banner' });
    if (r.type === 'fold') {
      banner.appendChild(el('h2', { text: `${playerName(state, r.winnerId)} gewinnt ${r.amount} Chips (alle anderen gefoldet)` }));
    } else {
      // Bei mehreren All-ins mit unterschiedlicher Tiefe entstehen Haupt- und
      // Nebenpots unterschiedlicher Größe - das ist korrekt, auch wenn die
      // Beträge sehr ungleich wirken. Klar beschriften, statt wie ein einziger,
      // seltsam aufgeteilter Pot auszusehen.
      const multiplePots = r.pots.length > 1;
      r.pots.forEach((p, i) => {
        const names = p.winners.map((id) => playerName(state, id)).join(' + ');
        const label = multiplePots ? (i === 0 ? 'Hauptpot: ' : `Nebenpot ${i}: `) : '';
        banner.appendChild(el('h2', { text: `${label}${names} gewinnt ${p.amount} mit ${p.description}` }));
      });
    }
    note.appendChild(banner);
  }

  function renderGameOver(state, note) {
    const winnerName = playerName(state, state.winnerId);
    note.appendChild(el('div', { class: 'winner-banner' }, [
      el('div', { class: 'crown', text: '🏆' }),
      el('h2', { text: `${winnerName} gewinnt die Partie!` }),
    ]));
    if (state.placements && state.placements.length) {
      const ol = el('ol', { class: 'placements-list' }, state.placements.map((id, i) => el('li', {
        text: `${i + 1}. ${playerName(state, id)}`,
      })));
      note.appendChild(ol);
    }
    if (state.hostId === myId()) {
      const btn = el('button', { class: 'btn primary', text: 'Neue Partie (zurück zur Lobby)' });
      btn.addEventListener('click', () => socket.emit('resetGame'));
      note.appendChild(btn);
    } else {
      note.appendChild(el('p', { class: 'waiting-note', text: `Warte auf ${playerName(state, state.hostId)} für eine neue Partie …` }));
    }
  }

  function renderActionBar(state) {
    const bar = $('action-bar');
    const showBar = (state.phase === 'hand' || state.phase === 'handend') && myHole;
    if (!showBar) { hide(bar); return; }
    show(bar);

    const handCards = $('hand-cards');
    handCards.innerHTML = '';
    myHole.forEach((c) => handCards.appendChild(renderCardEl(c)));

    const buttons = $('action-buttons');
    buttons.innerHTML = '';
    const canAct = state.phase === 'hand' && state.currentTurnId === myId() && myLegal;
    if (!canAct) {
      const me = state.players.find((p) => p.id === myId());
      const waitingInHand = state.phase === 'hand' && me && !me.folded && !me.allIn && state.currentTurnId !== myId();
      if (waitingInHand) renderPreActionButtons(buttons);
      else preAction = null;
      return;
    }
    preAction = null;

    const send = (type, amount) => {
      myLegal = null;
      socket.emit('action', { type, amount });
    };

    if (myLegal.canFold) {
      const b = el('button', { class: 'btn fold', text: 'Fold' });
      b.addEventListener('click', () => send('fold'));
      buttons.appendChild(b);
    }
    if (myLegal.canCheck) {
      const b = el('button', { class: 'btn check', text: 'Check' });
      b.addEventListener('click', () => send('check'));
      buttons.appendChild(b);
    }
    if (myLegal.canCall) {
      const b = el('button', { class: 'btn call', text: `Call ${myLegal.callAmount}` });
      b.addEventListener('click', () => send('call'));
      buttons.appendChild(b);
    }
    if (myLegal.canRaise) {
      const label = state.currentBet > 0 ? 'Raise auf' : 'Bet';
      const min = myLegal.raiseMin;
      const max = myLegal.raiseMax;
      if (raiseAmount < min || raiseAmount > max) raiseAmount = min;
      const numberInput = el('input', { type: 'number', min: String(min), max: String(max), value: String(raiseAmount) });
      const rangeInput = el('input', { type: 'range', min: String(min), max: String(max), value: String(raiseAmount) });
      const sync = (val) => {
        raiseAmount = Math.max(min, Math.min(max, Math.round(Number(val)) || min));
        numberInput.value = raiseAmount;
        rangeInput.value = raiseAmount;
      };
      numberInput.addEventListener('input', (e) => sync(e.target.value));
      rangeInput.addEventListener('input', (e) => sync(e.target.value));

      const pot = state.pot;
      const quick = (label2, val) => {
        const b = el('button', { class: 'btn ghost small', text: label2 });
        b.addEventListener('click', () => sync(val));
        return b;
      };

      const raiseBtn = el('button', { class: 'btn primary', text: label });
      raiseBtn.style.marginTop = '0';
      raiseBtn.addEventListener('click', () => send('raise', raiseAmount));

      buttons.appendChild(el('div', { class: 'raise-controls' }, [
        rangeInput, numberInput,
        quick('½ Pot', Math.round(pot / 2)),
        quick('Pot', pot),
        quick('All-in', max),
        raiseBtn,
      ]));
    }
  }

  // Buttons, um die eigene Aktion schon VOR dem eigenen Zug festzulegen -
  // wird ausgelöst, sobald man tatsächlich an der Reihe ist (siehe
  // maybeFirePreAction). Nützlich, weil es hier bewusst keinen Zug-Timer gibt.
  function renderPreActionButtons(buttons) {
    const makeToggle = (key, label) => {
      const b = el('button', { class: 'btn ghost small pre-action-btn' + (preAction === key ? ' active' : ''), text: label });
      b.addEventListener('click', () => {
        preAction = preAction === key ? null : key;
        if (latestState) renderActionBar(latestState);
      });
      return b;
    };
    buttons.appendChild(el('div', { class: 'pre-action-row' }, [
      el('span', { class: 'pre-action-label', text: 'Vorab wählen:' }),
      makeToggle('checkfold', 'Check/Fold'),
      makeToggle('callany', 'Call'),
    ]));
  }

  function renderHistoryEntry(entry) {
    const lines = [];
    if (entry.type === 'fold') {
      lines.push(el('div', { class: 'history-line', text: `${playerName(latestState, entry.winnerId)} gewinnt ${entry.amount} (alle gefoldet)` }));
    } else {
      const multiplePots = entry.pots.length > 1;
      entry.pots.forEach((p, i) => {
        const names = p.winners.map((id) => playerName(latestState, id)).join(' + ');
        const label = multiplePots ? (i === 0 ? 'Hauptpot: ' : `Nebenpot ${i}: `) : '';
        lines.push(el('div', { class: 'history-line', text: `${label}${names} gewinnt ${p.amount} mit ${p.description}` }));
      });
    }
    const children = [
      el('div', { class: 'history-hand-header', text: `Hand ${entry.handNumber}` }),
      el('div', { class: 'seat-cards' }, (entry.board || []).map((c) => renderCardEl(c))),
      ...lines,
    ];
    if (entry.reveal) {
      children.push(el('div', { class: 'history-reveal' }, Object.entries(entry.reveal).map(([id, r]) => el('div', { class: 'history-reveal-hand' }, [
        el('div', { class: 'seat-cards' }, r.cards.map((c) => renderCardEl(c))),
        el('span', { class: 'played-by', text: playerName(latestState, id) }),
      ]))));
    }
    return el('li', { class: 'history-entry' }, children);
  }

  function renderHistoryModal() {
    const list = $('log-list');
    list.innerHTML = '';
    if (!handHistory.length) {
      list.appendChild(el('li', { class: 'waiting-note', text: 'Noch keine Hand beendet.' }));
      return;
    }
    handHistory.forEach((entry) => list.appendChild(renderHistoryEntry(entry)));
  }
})();
