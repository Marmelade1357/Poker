// Regressionstest für den kompletten Spielablauf: Raum erstellen, mit Bots
// auffüllen, kleinen Startstack einstellen, Partie starten und bis zu einem
// Gewinner durchspielen. Prüft vor allem, dass der Server dabei nicht
// abstürzt oder hängen bleibt, und dass die Chip-Summe über die ganze
// Partie hinweg konstant bleibt (keine Chips verschwinden/entstehen).

const { startServer, stopServer, connectClient, emitAsync, waitForState, attachAutopilot, assert } = require('./helpers');

const PORT = 3903;
const STARTING_STACK = 200;

async function main() {
  const proc = await startServer(PORT, {
    BOT_DELAY_MIN_MS: '5',
    BOT_DELAY_MAX_MS: '15',
    HAND_RESULT_DELAY_MS: '20',
    RUNOUT_DELAY_MS: '10',
  });
  try {
    const url = `http://localhost:${PORT}`;
    const host = await connectClient(url);
    let myId = null;
    attachAutopilot(host, () => myId);

    const created = await emitAsync(host, 'createRoom', { name: 'TestHost' });
    assert(created.ok, `createRoom sollte erfolgreich sein, war aber: ${JSON.stringify(created)}`);
    myId = created.playerId;

    host.emit('fillBots');
    const lobbyState = await waitForState(host, (s) => s.players.length === 2);
    assert(lobbyState.players.length === 2, 'Raum sollte nach fillBots 2 Spieler haben (Minimum)');
    assert(lobbyState.maxPlayers === 8, 'maxPlayers sollte 8 sein');

    host.emit('setSettings', { startingStack: STARTING_STACK, blindMode: 'fixed', smallBlind: 5, levelMinutes: 10 });
    await waitForState(host, (s) => s.settings.startingStack === STARTING_STACK);

    // Ein dritter Spieler (Bot) für eine "echte" Mehrspieler-Partie mit Side-Pot-Potenzial.
    host.emit('addBot');
    const filledState = await waitForState(host, (s) => s.players.length === 3);
    assert(filledState.players.length === 3, 'Raum sollte 3 Spieler haben');

    host.emit('startGame');
    await waitForState(host, (s) => s.phase !== 'lobby');

    const playerCount = filledState.players.length;
    const expectedTotalChips = playerCount * STARTING_STACK;

    const finalState = await waitForState(host, (s) => s.phase === 'gameover', 60000);

    assert(finalState.winnerId, 'Es sollte einen Gewinner geben');
    const winner = finalState.players.find((p) => p.id === finalState.winnerId);
    assert(winner && winner.stack === expectedTotalChips,
      `Gewinner sollte alle ${expectedTotalChips} Chips haben, hatte aber ${winner ? winner.stack : '???'}`);

    const totalChips = finalState.players.reduce((sum, p) => sum + p.stack, 0);
    assert(totalChips === expectedTotalChips,
      `Chip-Summe (${totalChips}) sollte über die ganze Partie ${expectedTotalChips} bleiben`);

    assert(finalState.placements && finalState.placements.length === playerCount,
      `Platzierungsliste sollte ${playerCount} Einträge haben, hatte ${finalState.placements ? finalState.placements.length : 0}`);
    assert(finalState.placements[0] === finalState.winnerId, 'Erster Platz sollte der Gewinner sein');

    const eliminatedPlayers = finalState.players.filter((p) => p.id !== finalState.winnerId);
    eliminatedPlayers.forEach((p) => {
      assert(p.eliminated, `${p.name} sollte als ausgeschieden markiert sein`);
      assert(p.stack === 0, `${p.name} sollte 0 Chips haben, hatte ${p.stack}`);
    });

    console.log('OK: holdem-flow.test.js');
  } finally {
    await stopServer(proc);
  }
}

main().catch((err) => {
  console.error('FEHLER in holdem-flow.test.js:', err);
  process.exitCode = 1;
});
