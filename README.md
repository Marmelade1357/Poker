# Poker – Online

Eine browserbasierte Online-Version von **Texas Hold'em** zum Spielen mit Freunden – jede:r auf dem eigenen Handy/Tablet/PC, ein gemeinsamer Server übernimmt Kartenverteilung, Setzrunden und Pot-Verteilung.

Standardregeln: No-Limit Hold'em, 2–8 Spieler, Elimination bei 0 Chips (Ausgeschiedene schauen als Zuschauer:innen weiter zu), die Partie endet, sobald nur noch eine Person Chips hat.

## Funktionen

- **Automatisches Austeilen** – Karten werden gemischt, Blinds gepostet, Board (Flop/Turn/River) gedealt, kein Kartenmischen nötig.
- **Vollständige Setzrunden-Logik** – Fold/Check/Call/Raise mit serverseitiger Validierung (Big-Blind-Option, Mindest-Raise, All-in für weniger).
- **Side Pots** – bei mehreren All-ins werden Haupt- und Nebentöpfe korrekt aus den Einsatzhöhen gebildet und beim Showdown getrennt ausgezahlt.
- **Elimination-Turnier** – ein vom Host festgelegter Startstack für alle; wer auf 0 Chips fällt, scheidet aus und schaut als Zuschauer:in weiter zu. Die Partie endet mit genau einem Sieger/einer Siegerin.
- **Blinds fest oder steigend** – der Host wählt in der Lobby zwischen festen Blinds oder einem Level-Timer mit automatisch steigenden Blinds.
- **Test-Bots** – der Tisch lässt sich in der Lobby per Klick mit Bots auf die Mindestspielerzahl (2) auffüllen. Bots bewerten ihre Hand (Preflop-Heuristik, Postflop anhand der besten 5-aus-7-Karten) und entscheiden anhand von Pot-Odds über Call/Fold/Raise.
- Wiederverbindung nach Verbindungsabbruch/Neuladen der Seite (Sitzplatz, Karten und Stack bleiben erhalten).
- Läuft komplett im Speicher – keine Datenbank nötig, ideal für einen Raspberry Pi.

## Entwicklung

```bash
npm install
npm start          # http://localhost:3000
npm test           # Handbewertung, Side Pots, kompletter Spielablauf
```

## Deployment (Raspberry Pi, analog zu "Wizard" / "Der Widerstand")

```bash
./deploy.sh
```

Der Container lauscht intern auf Port 3000 und wird laut `docker-compose.yml` nur auf `127.0.0.1:8097` veröffentlicht – ein bereits laufender Reverse Proxy auf dem Pi kann eine eigene Subdomain (z. B. `poker.oualid.de`) dorthin routen, genau wie bei `wizard.oualid.de` → 8093.

Sobald der Container läuft, ist Poker außerdem automatisch über den **Spielehub** unter `games.oualid.de/poker/` erreichbar (siehe `../Spielehub`) – dafür ist nichts weiter zu konfigurieren, `public/client.js` erkennt das `/poker`-Präfix bereits selbstständig.
