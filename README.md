# mailmeteor

Serienmails an viele Empfänger – **jede Mail einzeln versendet, kein BCC**. Jeder
Empfänger sieht nur die eigene Adresse und kann persönlich angesprochen werden.

```
✓ [1/240] anna.beispiel@example.com
✓ [2/240] bernd.muster@example.com
✗ [3/240] tippfehler@exampl.com – 550 Adresse existiert nicht
```

## Wie aufwändig ist der Nachbau?

Kurze Antwort: **der Teil, den du brauchst, ist an einem Nachmittag gebaut** – er
liegt hier fertig. Der Rest von Mailmeteor ist das, was Geld kostet.

| Funktion | Aufwand |
| --- | --- |
| Mails einzeln nacheinander versenden | **einfach** – hier umgesetzt, ~600 Zeilen |
| Platzhalter aus einer CSV (`{{vorname}}`) | **einfach** – hier umgesetzt |
| Pausen, Wiederholversuche, Fortsetzen nach Abbruch | **einfach** – hier umgesetzt |
| Öffnungs- und Klick-Tracking | mittel (Zählpixel + Redirect-Server nötig) |
| Abmelde-Verwaltung, Bounce-Auswertung | mittel bis aufwändig (Postfach auslesen, Adressen sperren) |
| Zustellbarkeit (SPF, DKIM, DMARC, Reputation) | **das eigentliche Problem** – reine Konfigurations- und Geduldsarbeit |
| Oberfläche in Gmail / Google Sheets | aufwändig (Google-Add-on, Review-Prozess) |

Der harte Teil ist nie das Versenden, sondern **im Postfach zu landen**. Dabei
hilft keine Software, sondern eine korrekt eingerichtete Absenderdomain und eine
Liste, die dich erwartet.

## Einrichtung

```bash
npm install
cp .env.example .env    # dann .env ausfüllen
```

Für Gmail brauchst du ein **App-Passwort** (Google-Konto → Sicherheit →
2-Faktor-Authentifizierung → App-Passwörter). Das normale Kontopasswort wird von
Google für SMTP abgelehnt.

Für `gmail.com`, `outlook.com`, `web.de` und `gmx.de` werden Server und Port
automatisch gesetzt – in der `.env` genügen dann `SMTP_USER` und `SMTP_PASS`.

## Verwendung

**1. Empfängerliste** als CSV. Nötig ist nur eine Spalte `email`; jede weitere
Spalte lässt sich im Text als Platzhalter verwenden:

```csv
email,vorname,firma
anna@example.com,Anna,Beispiel GmbH
bernd@example.com,Bernd,Muster KG
```

Komma und Semikolon werden beide erkannt (deutsches Excel exportiert Semikolon).

**2. Template** – `.html` wird als HTML verschickt, alles andere als reiner Text.
Der Betreff kann im Kopfblock der Datei stehen:

```html
---
subject: Kurze Frage zu {{firma|deinem Projekt}}, {{vorname}}
---
<p>Hallo {{vorname}},</p>
<p>ich habe gesehen, dass {{firma|dein Team}} …</p>
```

`{{firma|dein Team}}` heißt: Standardwert einsetzen, wenn die Spalte leer ist.
Fehlt ein Platzhalter ganz, wird er **nicht** ersetzt und im Probelauf gemeldet –
so kommt kein „Hallo {{vorname}}" bei echten Empfängern an.

**3. Probelauf** – der Standard. Zeigt die erste Mail und versendet nichts:

```bash
npm run send -- --to kunden.csv --template templates/example.html
```

**4. Testmail an dich selbst:**

```bash
npm run send -- --to kunden.csv --template templates/example.html \
  --only deine@adresse.de --send
```

**5. Echter Versand:**

```bash
npm run send -- --to kunden.csv --template templates/example.html --send
```

Alle Optionen: `npm run send -- --help`

## Was dich vor Fehlern schützt

- **Probelauf ist der Standard.** Ohne `--send` passiert nichts.
- **Rückfrage vor dem Versand**, überspringbar mit `--yes`.
- **Protokoll pro Kampagne** unter `.mailmeteor/<name>.jsonl`, nach jeder Mail
  sofort geschrieben. Bricht der Lauf ab (Strg-C, Rechner aus, Sendelimit), setzt
  derselbe Befehl beim nächsten Start **nur die offenen Adressen** fort – niemand
  bekommt die Mail doppelt. Mit `--resend` schreibst du bewusst alle erneut an.
- **Doppelte und offensichtlich fehlerhafte Adressen** werden vor dem Versand
  aussortiert und einzeln gemeldet.
- **Pause zwischen den Mails** (Standard 3–5 s, zufällig schwankend). Nicht aus
  Höflichkeit: gleichmäßig getaktete Massenmails fallen Spamfiltern auf.
- **Wiederholversuche** nur bei vorübergehenden Fehlern (4xx, Netzwerkabbruch).
  Bei „Adresse existiert nicht" (5xx) wird nicht weiterprobiert.
- **Sendelimit erkannt:** Meldet der Anbieter das Tageslimit, bricht der Lauf ab,
  statt gegen die Wand zu laufen. Am nächsten Tag derselbe Befehl, es geht weiter.
- **Jede Mail hat einen Text-Teil**, auch bei HTML – reine HTML-Mails werden
  häufiger als Spam eingestuft.

## Grenzen, die du kennen solltest

**Sendelimits.** Gmail lässt privat rund **500 Empfänger pro Tag** zu, Google
Workspace etwa **2.000**. Wer mehr braucht, nimmt einen Versanddienst
(Amazon SES, Postmark, Brevo …) – am Code ändert das nur `SMTP_HOST`, `SMTP_USER`
und `SMTP_PASS` in der `.env`.

**Zustellbarkeit.** Für Mails an Fremde brauchst du eine eigene Domain mit
korrektem SPF-, DKIM- und DMARC-Eintrag. Über eine private Gmail-Adresse an
Hunderte Unbekannte zu schreiben, endet im Spam-Ordner und riskiert dein Konto.

**Rechtlich (EU/DSGVO).** Werbliche Mails an Personen ohne deren Einwilligung
sind unzulässig. Pflicht sind außerdem ein Impressum und ein funktionierender
Abmeldeweg (`--unsubscribe`). Das ist keine Rechtsberatung – aber der Punkt, an
dem Serienmails typischerweise teuer werden, nicht die Technik.

## Aufbau

| Datei | Aufgabe |
| --- | --- |
| `src/cli.js` | Kommandozeile, Vorschau, Ausgabe |
| `src/recipients.js` | CSV einlesen, Adressen prüfen, Duplikate aussortieren |
| `src/template.js` | Platzhalter, Kopfblock, HTML→Text |
| `src/transport.js` | SMTP-Verbindung, Anbieter-Voreinstellungen |
| `src/sender.js` | Versandschleife, Pausen, Wiederholversuche |
| `src/log.js` | Protokoll, Fortsetzen nach Abbruch |

```bash
npm test    # 45 Tests, ohne Netzwerkzugriff
```
