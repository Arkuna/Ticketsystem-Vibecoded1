# Ticketsystem

Kleines Ticketsystem mit Login, Rollen und Kanban-Board. Keine externen Pakete, nur Node.js (ab Version 22.13). Die Daten liegen in einer SQLite-Datei.

## Rollen

| Rolle | Darf |
|---|---|
| Besitzer | Alles. Das ist automatisch der erste Account, der sich registriert. Verwaltet Benutzer. |
| Team | Sieht alle Tickets, verschiebt sie, setzt Priorität und Zuweisung, schreibt Antworten und interne Notizen. |
| Gast | Erstellt Tickets und sieht nur seine eigenen. Bearbeiten und Löschen nur, solange das Ticket "Offen" ist. |

Neue Registrierungen sind immer Gäste. Der Besitzer stuft sie über "Benutzer" auf Team hoch.

**Wichtig:** Registriere dich als Erstes selbst, direkt nach dem Start. Dein Account wird dadurch zum Besitzer.

## Lokal starten

    node server.js

Dann http://localhost:3000 öffnen.

## Einstellungen (Umgebungsvariablen)

| Variable | Bedeutung |
|---|---|
| PORT | Port, Standard 3000 |
| DATA_DIR | Ordner für die Datenbank, Standard ./data |
| COOKIE_SECURE=1 | Setzen, sobald die Seite über HTTPS läuft |
| TRUST_PROXY=1 | Setzen hinter nginx/Caddy, damit die echte IP für die Login-Bremse genutzt wird |
| INVITE_CODE | Optional. Dann können sich nur Leute mit diesem Code registrieren |

## Online stellen

Siehe **ANLEITUNG.md** (kostenloser Server, Schritt für Schritt, mit HTTPS).

## Mit Docker

    docker build -t ticketsystem .
    docker run -d --name tickets -p 3000:3000 -v tickets-data:/data \
      -e COOKIE_SECURE=1 -e TRUST_PROXY=1 -e INVITE_CODE=dein-code ticketsystem

Ohne HTTPS-Proxy davor bitte COOKIE_SECURE weglassen, sonst klappt der Login nicht.

## Sicherung

Sichere regelmäßig den Ordner `data/` (bzw. das Docker-Volume). Dort liegen alle Konten und Tickets.

## Funktionen

- Kanban-Board mit Drag & Drop, Suche und Prioritätsfilter
- Ticketnummern (TCK-1, TCK-2, ...)
- Verlauf pro Ticket: Antworten für alle Beteiligten, **interne Notizen** nur fürs Team
- Passwort ändern, Passwort-Reset durch den Besitzer
- Tägliche automatische Sicherung nach `data/backups` (die letzten 14)

## Sicherheit in Kürze

- Passwörter werden mit scrypt gehasht, Sitzungen liegen als Hash in der Datenbank.
- Das Session-Cookie ist HttpOnly und SameSite=Lax.
- Falsche Logins sind pro IP auf 10 in 15 Minuten begrenzt, Registrierungen auf 20 pro Stunde.
- Strenge Content-Security-Policy, keine externen Schriften oder Skripte (gut für die DSGVO).
- Die Rechte werden im Server geprüft, nicht nur in der Oberfläche.
