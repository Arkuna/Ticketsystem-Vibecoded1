# Schritt für Schritt: Ticketsystem kostenlos online stellen

Diese Anleitung nutzt den **Always-Free-Server von Oracle Cloud** (ein kleiner Linux-Server, der dauerhaft kostenlos ist), eine **kostenlose Adresse von DuckDNS** und **Caddy** für HTTPS. Du brauchst dafür keine Vorkenntnisse, nur Geduld und Copy & Paste.

Warum kein "normales" kostenloses Hosting? Kostenlose Web-Dienste wie Render oder Koyeb schlafen nach kurzer Zeit ein, und ihr Speicher ist oft nicht dauerhaft. Dein Ticketsystem speichert alles in einer Datei. Ohne dauerhaften Speicher wären Konten und Tickets nach einem Neustart weg. Ein eigener kleiner Server hat dieses Problem nicht.

Was du brauchst: eine E-Mail-Adresse, ein Handy für die Bestätigung und in der Regel eine Karte zur Identitätsprüfung bei Oracle. Bei "Always Free" wird nichts abgebucht, solange du keine kostenpflichtigen Dinge anlegst.

---

## Teil 1: Server bei Oracle anlegen

1. Gehe auf https://www.oracle.com/cloud/free/ und erstelle einen kostenlosen Account.
2. Wähle als **Home Region** Frankfurt (Germany Central). Die Region kann später nicht mehr geändert werden.
3. Melde dich in der Oracle Cloud Console an. Öffne das Menü, dann **Compute → Instances → Create instance**.
4. Gib einen Namen ein, z. B. `tickets`.
5. Bei **Image and shape** klicke auf **Edit**:
   - Image: **Ubuntu 24.04** (Canonical Ubuntu).
   - Shape: **VM.Standard.E2.1.Micro** (AMD, 1 GB RAM, trägt das Label "Always Free-eligible"). Für dein Ticketsystem reicht das völlig.
   - Wenn du stattdessen einen Ampere-Server (VM.Standard.A1.Flex) nimmst: Dort gilt für kostenlose Accounts inzwischen höchstens 2 OCPU und 12 GB RAM, und oft heißt es "Out of capacity". Dann nimm einfach den AMD-Micro.
6. Bei **Add SSH keys**: Wähle **Generate a key pair for me** und klicke **Save private key**. Speichere die Datei gut (z. B. `tickets.key`). Ohne sie kommst du nicht auf den Server.
7. Klicke **Create**. Nach etwa einer Minute steht der Status auf **Running**. Notiere dir die **Public IP address**.

## Teil 2: Ports für die Webseite öffnen

Oracle blockiert standardmäßig fast alles. Du musst Port 80 und 443 freigeben.

1. In der Instanz-Detailseite klicke auf das **Subnet** (Link neben "Primary VNIC"), dann auf die **Security List** (z. B. "Default Security List for ...").
2. **Add Ingress Rules**. Lege zwei Regeln an:
   - Source CIDR `0.0.0.0/0`, IP Protocol **TCP**, Destination Port Range `80`
   - Source CIDR `0.0.0.0/0`, IP Protocol **TCP**, Destination Port Range `443`

## Teil 3: Mit dem Server verbinden

Öffne auf deinem Computer ein Terminal (Windows: PowerShell, Mac/Linux: Terminal).

    ssh -i PFAD/ZU/tickets.key ubuntu@DEINE-IP

Unter Mac/Linux musst du vorher einmal `chmod 600 PFAD/ZU/tickets.key` ausführen. Auf die Frage "Are you sure ...?" antwortest du mit `yes`.

Ab jetzt laufen die Befehle **auf dem Server**.

## Teil 4: Firewall auf dem Server öffnen

    sudo iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT
    sudo iptables -I INPUT 1 -p tcp --dport 443 -j ACCEPT
    sudo apt update && sudo apt install -y iptables-persistent unzip
    sudo netfilter-persistent save

(Bei der Frage zum Speichern der Regeln einfach mit Enter bestätigen.)

## Teil 5: Node.js installieren

    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt install -y nodejs
    node --version

Die Ausgabe sollte mit `v22` beginnen.

## Teil 6: Das Ticketsystem hochladen

Öffne ein **zweites Terminal auf deinem Computer** (nicht auf dem Server) und gehe in den Ordner, in dem `ticketsystem.zip` liegt:

    scp -i PFAD/ZU/tickets.key ticketsystem.zip ubuntu@DEINE-IP:~

Zurück im Server-Terminal:

    sudo unzip ~/ticketsystem.zip -d /opt
    sudo chown -R www-data:www-data /opt/ticketsystem

## Teil 7: Kostenlose Adresse bei DuckDNS

1. Gehe auf https://www.duckdns.org und melde dich an (z. B. mit GitHub oder Google).
2. Lege einen Namen an, z. B. `meine-tickets`. Deine Adresse ist dann `meine-tickets.duckdns.org`.
3. Trage bei **current ip** die Public IP deines Servers ein und klicke **update ip**.

## Teil 8: Ticketsystem als Dienst einrichten

Lege auf dem Server die Dienst-Datei an:

    sudo nano /etc/systemd/system/ticketsystem.service

Füge das ein (ändere `INVITE_CODE` in ein eigenes Geheimwort, das du Freunden gibst):

    [Unit]
    Description=Ticketsystem
    After=network.target

    [Service]
    WorkingDirectory=/opt/ticketsystem
    Environment=PORT=3000
    Environment=COOKIE_SECURE=1
    Environment=TRUST_PROXY=1
    Environment=NODE_NO_WARNINGS=1
    Environment=INVITE_CODE=hier-dein-geheimwort
    ExecStart=/usr/bin/node server.js
    Restart=always
    User=www-data

    [Install]
    WantedBy=multi-user.target

Speichern in nano: `Strg+O`, Enter, dann `Strg+X`. Dann starten:

    sudo systemctl enable --now ticketsystem
    sudo systemctl status ticketsystem

Es sollte **active (running)** stehen. Beenden mit `q`.

## Teil 9: HTTPS mit Caddy

    sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
    sudo apt update && sudo apt install -y caddy

Caddy-Einstellung öffnen:

    sudo nano /etc/caddy/Caddyfile

Alles darin ersetzen durch (mit deiner Adresse):

    meine-tickets.duckdns.org {
        reverse_proxy localhost:3000
    }

Speichern, dann:

    sudo systemctl reload caddy

## Teil 10: Ausprobieren

1. Öffne `https://meine-tickets.duckdns.org` im Browser.
2. Klicke auf "Registrieren" und lege **als Erstes deinen eigenen Account** an. Du wirst automatisch der Besitzer. Falls du einen Einladungscode gesetzt hast, gib ihn dort ein.
3. Gib Freunden Link und Code. Sie registrieren sich und können Tickets erstellen. Unter **Benutzer** kannst du Vertrauten die Rolle **Team** geben.

---

## Später: Updates, Sicherung, Probleme

**Neue Version einspielen:** Neue ZIP per `scp` hochladen und so entpacken, dass der Ordner `data` erhalten bleibt:

    sudo unzip -o ~/ticketsystem.zip -d /opt
    sudo chown -R www-data:www-data /opt/ticketsystem
    sudo systemctl restart ticketsystem

**Sicherung:** Das System legt täglich automatisch Kopien in `/opt/ticketsystem/data/backups` an (die letzten 14). Lade sie regelmäßig auf deinen Computer, falls der Server mal verloren geht. Zuerst auf dem Server:

    sudo cp -r /opt/ticketsystem/data/backups ~/ && sudo chown -R ubuntu ~/backups

Dann auf deinem Computer:

    scp -i PFAD/ZU/tickets.key -r ubuntu@DEINE-IP:~/backups .

**Wiederherstellen:** Dienst stoppen (`sudo systemctl stop ticketsystem`), die Sicherung nach `/opt/ticketsystem/data/tickets.db` kopieren, Besitzer wieder auf `www-data` setzen und den Dienst starten.

**Passwort vergessen (Freunde):** Du als Besitzer klickst unter "Benutzer" auf "Passwort zurücksetzen". Dein eigenes Passwort kannst du ändern, solange du angemeldet bist.

**Fehlersuche:**
- Seite lädt nicht: `sudo systemctl status ticketsystem` und `sudo systemctl status caddy` prüfen.
- Logs ansehen: `sudo journalctl -u ticketsystem -n 50` bzw. `sudo journalctl -u caddy -n 50`.
- Zertifikatsfehler: Prüfe, ob die DuckDNS-Adresse auf die richtige IP zeigt und Port 80 und 443 in beiden Firewalls offen sind (Teil 2 und 4).
- Login klappt nicht, obwohl das Passwort stimmt: Läuft die Seite über `https://`? Mit `COOKIE_SECURE=1` geht der Login nur über HTTPS.

## Gut zu wissen

- Oracle kann Always-Free-Server stoppen oder löschen, die über längere Zeit kaum genutzt werden. Mach deshalb regelmäßig Sicherungen.
- Wenn Oracle bei dir nicht klappt (keine Kapazität, Verifizierung scheitert): Google Cloud bietet eine kostenlose `e2-micro`-Maschine, aber nur in bestimmten US-Regionen. Der Ablauf ab Teil 3 ist dann derselbe.
- Alternative ohne Cloud: ein Raspberry Pi oder ein alter Rechner zu Hause mit demselben Ablauf (Teil 5 bis 9) und Portfreigabe im Router.
