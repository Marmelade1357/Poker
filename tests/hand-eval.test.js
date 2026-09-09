// Unit-Tests für die Handbewertung (evaluateSeven/compareRank) und die
// Side-Pot-Berechnung (buildPots) - beides pures, deterministisches Rechnen,
// daher direkt über require getestet statt über einen laufenden Server.

process.env.PORT = '0'; // require-seitiges listen() soll keinen festen Port belegen

const { evaluateSeven, compareRank, buildPots } = require('../server.js');
const { assert } = require('./helpers');

function c(rank, suit) { return { id: `${rank}${suit}`, rank, suit }; }
function gt(a, b, label) { assert(compareRank(evaluateSeven(a), evaluateSeven(b)) > 0, `${label}: sollte gewinnen`); }
function eq(a, b, label) { assert(compareRank(evaluateSeven(a), evaluateSeven(b)) === 0, `${label}: sollte unentschieden sein`); }

function main() {
  // Kategorie-Rangfolge
  gt(
    [c(10, 's'), c(11, 's'), c(12, 's'), c(13, 's'), c(14, 's'), c(2, 'h'), c(3, 'h')],
    [c(9, 'h'), c(9, 'd'), c(9, 'c'), c(9, 's'), c(2, 'h'), c(5, 'd'), c(7, 'c')],
    'Straight Flush schlägt Vierling',
  );
  gt(
    [c(5, 'h'), c(5, 'd'), c(5, 'c'), c(9, 's'), c(9, 'h'), c(2, 'c'), c(3, 'd')],
    [c(2, 'h'), c(5, 'h'), c(9, 'h'), c(11, 'h'), c(13, 'h'), c(3, 'd'), c(4, 'c')],
    'Full House schlägt Flush',
  );
  gt(
    [c(4, 'h'), c(5, 'd'), c(6, 'c'), c(7, 's'), c(8, 'h'), c(2, 'd'), c(2, 'c')],
    [c(3, 'h'), c(3, 'd'), c(3, 'c'), c(9, 's'), c(11, 'h'), c(2, 'd'), c(5, 'c')],
    'Straße schlägt Drilling',
  );
  gt(
    [c(6, 'h'), c(6, 'd'), c(9, 's'), c(9, 'c'), c(2, 'h'), c(3, 'd'), c(4, 'c')],
    [c(6, 'h'), c(6, 'd'), c(9, 's'), c(11, 'c'), c(2, 'h'), c(3, 'd'), c(4, 'c')],
    'Zwei Paare schlagen ein Paar',
  );
  gt(
    [c(6, 'h'), c(6, 'd'), c(9, 's'), c(11, 'c'), c(2, 'h'), c(3, 'd'), c(4, 'c')],
    [c(2, 'h'), c(5, 'd'), c(9, 's'), c(11, 'c'), c(13, 'h'), c(3, 'd'), c(4, 'c')],
    'Ein Paar schlägt High Card',
  );

  // Ass-Straße (Wheel) ist die niedrigste Straße
  gt(
    [c(2, 'h'), c(3, 'd'), c(4, 's'), c(5, 'c'), c(6, 'h'), c(9, 'd'), c(11, 'c')],
    [c(14, 'h'), c(2, 'd'), c(3, 's'), c(4, 'c'), c(5, 'h'), c(9, 'd'), c(11, 'c')],
    '6-hohe Straße schlägt Ass-Straße (Wheel)',
  );

  // Kicker entscheidet bei gleichem Paar
  gt(
    [c(13, 'h'), c(13, 'd'), c(14, 's'), c(5, 'c'), c(2, 'h'), c(3, 'd'), c(4, 'c')],
    [c(13, 'h'), c(13, 'd'), c(12, 's'), c(5, 'c'), c(2, 'h'), c(3, 'd'), c(4, 'c')],
    'Besserer Kicker gewinnt bei gleichem Paar',
  );

  // Board spielt für beide Spieler - Split Pot
  const board = [c(10, 'h'), c(11, 'd'), c(12, 's'), c(13, 'c'), c(14, 'h')];
  eq(
    [c(2, 'h'), c(3, 'd')].concat(board),
    [c(4, 'h'), c(5, 'd')].concat(board),
    'Board-Straße spielt für beide gleich (Split Pot)',
  );

  console.log('OK: Handbewertung');

  // --- buildPots ---
  const noFolds = buildPots([
    { id: 'a', amount: 100, folded: false },
    { id: 'b', amount: 100, folded: false },
    { id: 'c', amount: 100, folded: false },
  ]);
  assert(noFolds.length === 1, 'Ohne Folds sollte es genau einen Pot geben');
  assert(noFolds[0].amount === 300, `Pot sollte 300 sein, war ${noFolds[0].amount}`);
  assert(['a', 'b', 'c'].every((id) => noFolds[0].eligible.includes(id)), 'Alle drei sollten berechtigt sein');

  const sidePot = buildPots([
    { id: 'a', amount: 50, folded: false },
    { id: 'b', amount: 100, folded: false },
    { id: 'c', amount: 100, folded: false },
  ]);
  assert(sidePot.length === 2, `Bei einem Short-All-in sollten 2 Pots entstehen, waren ${sidePot.length}`);
  assert(sidePot[0].amount === 150 && sidePot[0].eligible.length === 3, 'Hauptpot sollte 150 mit 3 Berechtigten sein');
  assert(sidePot[1].amount === 100 && sidePot[1].eligible.length === 2
    && sidePot[1].eligible.includes('b') && sidePot[1].eligible.includes('c'), 'Seitenpot sollte 100 mit b+c sein');
  const totalSide = sidePot.reduce((s, p) => s + p.amount, 0);
  assert(totalSide === 250, `Summe der Pots (${totalSide}) sollte den Gesamteinsätzen (250) entsprechen`);

  const withFold = buildPots([
    { id: 'a', amount: 50, folded: true },
    { id: 'b', amount: 100, folded: false },
    { id: 'c', amount: 100, folded: false },
  ]);
  assert(withFold.length === 1, 'Totes Geld eines Folders sollte in einen einzigen Pot fließen');
  assert(withFold[0].amount === 250, `Pot sollte 250 sein, war ${withFold[0].amount}`);
  assert(withFold[0].eligible.length === 2 && !withFold[0].eligible.includes('a'), 'Der Folder darf nicht berechtigt sein');

  // Drei unterschiedlich tiefe All-ins: sehr ungleiche Pot-Größen sind hier
  // KEIN Bug - wer am meisten eingesetzt hat, holt sich den (großen) obersten
  // Pot automatisch zurück, wenn niemand sonst so viel decken konnte.
  const threeTier = buildPots([
    { id: 'a', amount: 50, folded: false },
    { id: 'b', amount: 100, folded: false },
    { id: 'c', amount: 500, folded: false },
  ]);
  assert(threeTier.length === 3, `Drei unterschiedliche Einsatzhöhen sollten 3 Pots ergeben, waren ${threeTier.length}`);
  assert(threeTier[0].amount === 150 && threeTier[0].eligible.length === 3, 'Hauptpot sollte 150 mit a+b+c sein');
  assert(threeTier[1].amount === 100 && threeTier[1].eligible.length === 2
    && threeTier[1].eligible.includes('b') && threeTier[1].eligible.includes('c'), 'Nebenpot 1 sollte 100 mit b+c sein');
  assert(threeTier[2].amount === 400 && threeTier[2].eligible.length === 1 && threeTier[2].eligible[0] === 'c',
    'Nebenpot 2 sollte 400 sein und nur c berechtigen (niemand sonst konnte so viel callen)');
  const totalThreeTier = threeTier.reduce((s, p) => s + p.amount, 0);
  assert(totalThreeTier === 650, `Summe der Pots (${totalThreeTier}) sollte 650 entsprechen`);

  console.log('OK: Side Pots');
}

try {
  main();
  console.log('OK: hand-eval.test.js');
} catch (err) {
  console.error('FEHLER in hand-eval.test.js:', err);
  process.exitCode = 1;
} finally {
  // require('../server.js') startet einen lauschenden Server (PORT=0) - ohne
  // process.exit() würde der Prozess wegen des offenen Handles nie beenden.
  process.exit(process.exitCode || 0);
}
