// Regressionstest für einen Bug, bei dem ein kurzer Verbindungsabbruch genau
// im eigenen Zug (z.B. ein Reverse-Proxy-Hiccup) dazu führte, dass der Server
// den Zug trotz sofortigem Reconnect nach ein paar hundert Millisekunden
// automatisch für die Person weggeklickt hat (Check/Fold) - der Verbindungs-
// status wurde beim Planen des Fallback-Timers erfasst, aber beim Auslösen
// nicht erneut geprüft.

const { startServer, stopServer, connectClient, emitAsync, waitForState, assert } = require('./helpers');

const PORT = 3904;
const FALLBACK_DELAY_MS = 400;

async function main() {
  const proc = await startServer(PORT, {
    BOT_DELAY_MIN_MS: String(FALLBACK_DELAY_MS),
    BOT_DELAY_MAX_MS: String(FALLBACK_DELAY_MS),
    HAND_RESULT_DELAY_MS: '50',
    RUNOUT_DELAY_MS: '20',
  });
  try {
    const url = `http://localhost:${PORT}`;
    let hostSocket = await connectClient(url);
    const created = await emitAsync(hostSocket, 'createRoom', { name: 'Host' });
    assert(created.ok, `createRoom sollte klappen, war aber: ${JSON.stringify(created)}`);
    const { playerId: hostId, token, code } = created;

    hostSocket.emit('addBot');
    await new Promise((r) => setTimeout(r, 100));
    hostSocket.emit('startGame');

    // Warten, bis der Host tatsächlich am Zug ist (kann eine Hand dauern,
    // falls der Bot laut Button zuerst handelt).
    const stateAtMyTurn = await waitForState(
      hostSocket,
      (s) => s.phase === 'hand' && s.currentTurnId === hostId,
      20000,
    );
    const handNumberAtTurn = stateAtMyTurn.handNumber;
    const streetAtTurn = stateAtMyTurn.street;

    // Verbindungsabbruch mitten im eigenen Zug simulieren.
    hostSocket.disconnect();
    await new Promise((r) => setTimeout(r, 50));

    // Sofortiger Reconnect, wie es ein echter Client bei einem kurzen Blip tut.
    hostSocket = await connectClient(url);
    const rejoined = await emitAsync(hostSocket, 'joinRoom', { code, name: 'Host', token });
    assert(rejoined.ok && rejoined.rejoined, `Reconnect mit Token sollte klappen, war aber: ${JSON.stringify(rejoined)}`);

    let lastState = null;
    hostSocket.on('gameState', (s) => { lastState = s; });

    // Länger warten als das beim Abbruch geplante Fallback-Delay - der Zug
    // darf NICHT automatisch weggeklickt werden, der Host ist ja wieder da.
    await new Promise((r) => setTimeout(r, FALLBACK_DELAY_MS + 500));

    assert(lastState, 'sollte nach dem Reconnect mindestens einen gameState erhalten haben');
    assert(
      lastState.handNumber === handNumberAtTurn && lastState.street === streetAtTurn,
      `Zug sollte nicht automatisch weggeklickt worden sein (Hand ${handNumberAtTurn}/${streetAtTurn} erwartet, war ${lastState.handNumber}/${lastState.street})`,
    );
    assert(lastState.currentTurnId === hostId, 'Host sollte nach dem Reconnect weiterhin selbst am Zug sein');

    console.log('OK: reconnect-blip.test.js');
  } finally {
    await stopServer(proc);
  }
}

main().catch((err) => {
  console.error('FEHLER in reconnect-blip.test.js:', err);
  process.exitCode = 1;
});
