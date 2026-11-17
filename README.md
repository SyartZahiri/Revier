# Revier

Ein Alle-gegen-alle-Shooter, der direkt im Browser läuft. Seite öffnen, Namen eingeben,
Charakter wählen, spielen. Bis zu 10 Spieler in einem zerschossenen Dorf. Wer allein ist,
bekommt einen Bot als Gegner, auch ganz ohne Server.

![Schulterkamera: Panzerwrack, brennende Fässer, Sandsäcke](docs/screenshot-ruinen.jpg)
![Der Friedhof mit seinen Inschriften](docs/screenshot-friedhof.jpg)

"Revier" ist ein Arbeitstitel.

## Was das Spiel kann

- **Sofort spielbar.** Keine Anmeldung, kein Download. Der Name wird im Startmenü eingegeben.
- **Alle gegen alle.** Wer zuerst 20 Kills hat, gewinnt die Runde. Dann geht es von vorn los.
- **Zehn Charaktere.** Wolf, Sahara, Tundra, Dschungel, Marine, Rost, Geist, Sani, Funker, Veteran.
  Im Menü dreht sich eine 3D-Vorschau. In einem Raum trägt jeder Spieler einen anderen.
- **Räume mit 10 Plätzen.** Der elfte Spieler eröffnet einen neuen Raum.
- **Nie allein.** Ist nur ein Spieler im Raum, springt ein Bot ein. Kommt ein zweiter Mensch, geht der Bot.
- **Solo-Modus ohne Server.** Ist kein Server erreichbar, laufen dieselben Spielregeln im Browser, mit einem Bot.
- **Rangliste der Woche.** Die zehn Namen mit den meisten Kills, jeden Montag neu.
- **Eine Karte: Ruinen.** Ein Panzerwrack in der Mitte, vier zerschossene Häuser (eines mit Obergeschoss),
  ein Friedhof, Sandsäcke, Trümmer, Krater, brennende Fässer.
- **Vier Waffen.** Messer, Pistole, Maschinenpistole, Sturmgewehr. Mit dem Messer in der Hand läuft man etwas schneller.
- **Schiessen mit Gewicht.** Zielen über Kimme und Korn, Rückstoss, Magazine, weniger Schaden auf Distanz, Kopftreffer.
- **Bewegung.** Bunny Hop, Rutschen, Wandsprung. Trümmer und Treppen läuft man einfach hoch.
- **Schutzwesten** zum Einsammeln, **Minimap**, **Schulterkamera** und **Chat**.
- **Easter Eggs.** Lies die Grabsteine. Und irgendwo sitzt noch eine Ente.

## Steuerung

| Taste | Wirkung |
|---|---|
| W A S D | laufen |
| Leertaste | springen. Halten für Bunny Hop, in der Luft an einer Wand für den Wandsprung |
| Shift | ducken. Im Laufen gedrückt: rutschen |
| Linksklick | schiessen, mit dem Messer zustechen |
| Rechtsklick | zielen |
| R | nachladen |
| 1 2 3 4 | Messer, Pistole, Maschinenpistole, Sturmgewehr |
| Mausrad | Waffe wechseln |
| V | Schulterkamera ein und aus |
| Enter | Chat (nur im Mehrspieler) |
| Tab | Punktestand |
| Esc | Menü |

## Schnellstart

Voraussetzung: [Node.js](https://nodejs.org) ab Version 20.

```bash
npm install
```

```bash
npm start
```

Danach läuft das Spiel auf http://localhost:3000. Wer im selben Netz ist, kann über die
Adresse deines Rechners mitspielen.

## Auf GitHub Pages veröffentlichen

GitHub Pages liefert nur Dateien aus und kann keinen Spielserver betreiben. Das Spiel ist
darauf vorbereitet: Auf GitHub Pages startet es im Solo-Modus gegen Bots.

1. Auf GitHub ein neues, leeres Repository anlegen.
2. Das Projekt hochladen (das lokale Repository mit dem ersten Commit gibt es schon):

   ```bash
   git remote add origin https://github.com/DEIN-NAME/DEIN-REPO.git
   git push -u origin main
   ```

3. Im Repository unter **Settings > Pages** bei **Source** den Eintrag **GitHub Actions** wählen.
4. Fertig. Bei jedem Push auf `main` läuft der Workflow in `.github/workflows/pages.yml`:
   Er installiert die Abhängigkeiten, lässt die Tests laufen und veröffentlicht den Ordner `public/`.

Das Spiel ist danach unter `https://DEIN-NAME.github.io/DEIN-REPO/` erreichbar.

### Mehrspieler trotz GitHub Pages

Für echten Mehrspieler muss `server.js` irgendwo laufen, wo Node.js und WebSockets erlaubt sind
(ein eigener Server oder ein Hosting-Dienst für Node-Apps). Dann in `public/config.js` die
Adresse eintragen:

```js
export const SERVER = 'https://mein-server.example';
```

Die Seite auf GitHub Pages verbindet sich dann mit diesem Server und zeigt seine Rangliste.
Antwortet der Server nicht, fällt das Spiel von selbst in den Solo-Modus zurück.

## Wie es gebaut ist

Der Kern ist eine einzige Datei mit den Spielregeln, die an zwei Orten läuft: im Node-Server
für den Mehrspieler und im Browser für den Solo-Modus. So gibt es nur eine Wahrheit darüber,
wie Räume, Bots, Schaden und Runden funktionieren.

| Datei | Aufgabe |
|---|---|
| `public/shared.js` | Die Karte, Waffen, Bewegungsphysik, Strahl-Tests. Von Browser und Server benutzt |
| `public/sim.js` | Spielregeln: Räume, Charaktere, Bots mit Wegfindung, Schaden, Westen, Runden. Ohne Netzwerk und ohne Dateizugriff |
| `server.js` | Liefert die Dateien aus, verbindet Spieler per WebSocket mit `sim.js`, speichert die Rangliste |
| `public/game.js` | Alles im Browser: 3D mit three.js, Steuerung, Schiessen, Effekte, Anzeige, Menü |
| `public/config.js` | Adresse des Mehrspieler-Servers |
| `public/index.html` | Startmenü und Anzeige |
| `test.js` | Automatischer Test |
| `tools/vendor.mjs` | Kopiert die benötigten three.js-Dateien nach `public/vendor` (läuft bei `npm install`) |

Ein paar Entscheide, die man beim Lesen wissen sollte:

- **Die Karte entsteht aus Code.** Jede Ruine ist eine Mauer in Stücken: ganz, Fenster, Stumpf oder Tür.
  Der Zufall dafür hat einen festen Startwert, damit Browser und Server genau dieselben Ruinen bauen.
- **Bewegung nach altem Shooter-Vorbild.** Die Luftbeschleunigung ist gedeckelt. Daraus entstehen Bunny Hop und Kurvenflug von selbst.
- **Der Bot sucht seinen Weg** über ein Raster aus 1-Meter-Feldern und eine Breitensuche vom Ziel aus.
- **Beide Hände am Gewehr.** Das Modell bringt nur einhändige Posen mit. Beine und Körper kommen darum aus
  seinen Animationen, die Arme werden jedes Bild neu ausgerichtet, bis die Hände am Gewehr liegen.
- **Texturen und Modell laden nach.** Zuerst erscheinen im Code gezeichnete Texturen und Figuren aus Blöcken.
  Sie werden ersetzt, sobald Fotos und Modell geladen sind, und bleiben als Reserve.
- **Der Browser meldet, der Server prüft.** Der Browser des Spielers rechnet seine Bewegung und meldet Schüsse und Treffer.
  Die Spielregeln glauben einen Treffer nur, wenn er möglich war: Der Schuss kam von dort, wo der Spieler steht, er ging
  in Richtung des Ziels, es lag nichts Festes dazwischen, die Feuerrate stimmt, und ein Messer reicht nur aus der Nähe.
  Die Bewegung selbst wird nicht nachgerechnet. Siehe Grenzen.

## Tests

```bash
npm test
```

Der Test startet den echten Server auf einem freien Port und prüft unter anderem:
Namen werden gesäubert, zehn Spieler bekommen zehn verschiedene Charaktere, der Bot ist nur bei
einem Spieler da, Räume fassen 10 Spieler. Treffer zählen nur nach einem Schuss vom eigenen Standort
in Richtung des Ziels, nicht durch den Panzer hindurch, und das Messer nur aus der Nähe. Die Rangliste
zählt und speichert, der Solo-Modus läuft ohne Netzwerk, Westen fangen Schaden ab, alle Spawn-Punkte
und Westen liegen frei, Grabhügel und Treppen lassen sich hochlaufen.

## Grenzen

- **Schummeln ist erschwert, nicht ausgeschlossen.** Treffer werden auf Plausibilität geprüft, die Bewegung wird dem
  Browser geglaubt. Wer sein Spiel umbaut, kann sich also schneller bewegen als erlaubt oder perfekt zielen.
- **Namen sind keine Konten.** Jeder kann jeden Namen eintippen, also auch in der Rangliste.
- **Der Chat ist ungefiltert.** Er ist auf 80 Zeichen begrenzt und wird nur als Text angezeigt, mehr nicht.
- **Ein Körper für alle.** Die zehn Charaktere unterscheiden sich in Farben und Ausrüstung, nicht in der Figur.
- **Kein Ton aus Dateien.** Alle Geräusche werden im Browser erzeugt und klingen entsprechend schlicht.
- **Maus und Tastatur.** Für Handys und Gamepads gibt es keine Steuerung.

## Ideen für später

- Echte Aufnahmen für Schüsse, Schritte und Umgebung.
- Der Server rechnet auch die Bewegung selbst nach, damit Schummeln noch schwerer wird.
- Eigene Figuren pro Charakter statt eines gemeinsamen Körpers.
- Mehr Easter Eggs.
- Konten, damit die Rangliste verlässlich ist.

## Quellen und Lizenzen

- Texturen und Himmel: [Poly Haven](https://polyhaven.com), Lizenz CC0.
- Figur "SWAT": [Quaternius](https://quaternius.com) über [Poly Pizza](https://poly.pizza/m/Btfn3G5Xv4), Lizenz CC0.
- 3D-Bibliothek: [three.js](https://threejs.org), MIT-Lizenz.
- WebSocket-Bibliothek: [ws](https://github.com/websockets/ws), MIT-Lizenz.

Die genauen Dateien stehen in `public/assets/QUELLEN.txt`.
Für den eigenen Code ist noch keine Lizenz gewählt.
