'use strict';
// Ticketsystem: Node.js >= 22.13, keine externen Pakete nötig.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');
const scrypt = promisify(crypto.scrypt);

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1'; // 1, sobald die Seite per HTTPS läuft
const TRUST_PROXY = process.env.TRUST_PROXY === '1';     // 1 hinter nginx/Caddy
const INVITE_CODE = process.env.INVITE_CODE || '';       // optional: Registrierung nur mit Code
const SESSION_DAYS = 30;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'tickets.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pw TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'guest',
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  internal INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  descr TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'aufgabe',
  status TEXT NOT NULL DEFAULT 'offen',
  prio TEXT NOT NULL DEFAULT 'mittel',
  assignee TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
`);

const TYPES = ['aufgabe', 'bug', 'feature'];
const STATUS = ['offen', 'arbeit', 'review', 'fertig'];
const PRIOS = ['hoch', 'mittel', 'niedrig'];
const isTeam = u => u.role === 'owner' || u.role === 'team';

// ---------- Hilfsfunktionen ----------
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
async function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
async function checkPw(pw, stored) {
  const [, salt, hash] = stored.split('$');
  const key = await scrypt(pw, Buffer.from(salt, 'hex'), 64);
  const want = Buffer.from(hash, 'hex');
  return key.length === want.length && crypto.timingSafeEqual(key, want);
}
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

function send(res, code, body, headers = {}) {
  const isObj = typeof body === 'object';
  res.writeHead(code, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!(req.headers['content-type'] || '').startsWith('application/json'))
      return reject(new HttpError(415, 'Nur JSON erlaubt.'));
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 100_000) { reject(new HttpError(413, 'Anfrage zu groß.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject(new HttpError(400, 'Ungültiges JSON.')); } });
    req.on('error', reject);
  });
}
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}
const buckets = new Map(); // einfache Bremse gegen Passwort-Raten und Massen-Registrierung
function blocked(key, limit) {
  const b = buckets.get(key);
  if (b && b.reset > Date.now() && b.n >= limit) throw new HttpError(429, 'Zu viele Versuche. Bitte warte etwas und probiere es dann erneut.');
}
function hit(key, windowMs) {
  const now = Date.now(), b = buckets.get(key);
  if (!b || b.reset < now) buckets.set(key, { n: 1, reset: now + windowMs }); else b.n++;
}
function sessionCookie(token, maxAge) {
  return `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${COOKIE_SECURE ? '; Secure' : ''}`;
}
function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)')
    .run(sha(token), userId, Date.now() + SESSION_DAYS * 86400_000);
  return { 'Set-Cookie': sessionCookie(token, SESSION_DAYS * 86400) };
}
function currentUser(req) {
  const t = cookies(req).sid;
  if (!t) return null;
  return db.prepare(`SELECT u.id, u.username, u.role FROM sessions s JOIN users u ON u.id = s.user_id
                     WHERE s.token = ? AND s.expires > ?`).get(sha(t), Date.now()) || null;
}
function requireUser(req) {
  const u = currentUser(req);
  if (!u) throw new HttpError(401, 'Bitte anmelden.');
  return u;
}
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function ticketOut(r) {
  return { id: r.id, title: r.title, desc: r.descr, type: r.type, status: r.status, prio: r.prio,
           assignee: r.assignee, created: r.created, updated: r.updated,
           author: { id: r.user_id, name: r.username } };
}
const TICKET_SELECT = 'SELECT t.*, u.username FROM tickets t JOIN users u ON u.id = t.user_id';

// ---------- API ----------
async function api(req, res, url) {
  const m = req.method, p = url.pathname;
  let mt;

  if (m === 'GET' && p === '/api/config') return send(res, 200, { inviteRequired: !!INVITE_CODE });

  if (m === 'POST' && p === '/api/register') {
    const rk = 'reg:' + clientIp(req);
    blocked(rk, 20); hit(rk, 3600_000);
    const b = await readJson(req);
    const name = str(b.username, 30), pw = typeof b.password === 'string' ? b.password : '';
    if (!/^[\p{L}\p{N}_. -]{3,30}$/u.test(name)) throw new HttpError(400, 'Benutzername: 3 bis 30 Zeichen (Buchstaben, Zahlen, _ . -).');
    if (pw.length < 8 || pw.length > 200) throw new HttpError(400, 'Das Passwort braucht mindestens 8 Zeichen.');
    if (INVITE_CODE && b.invite !== INVITE_CODE) throw new HttpError(403, 'Einladungscode ist falsch.');
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(name)) throw new HttpError(409, 'Dieser Benutzername ist schon vergeben.');
    const first = db.prepare('SELECT COUNT(*) c FROM users').get().c === 0;
    const r = db.prepare('INSERT INTO users(username,pw,role,created) VALUES(?,?,?,?)')
      .run(name, await hashPw(pw), first ? 'owner' : 'guest', Date.now());
    return send(res, 201, { ok: true }, startSession(res, Number(r.lastInsertRowid)));
  }

  if (m === 'POST' && p === '/api/login') {
    const lk = 'login:' + clientIp(req);
    blocked(lk, 10);
    const b = await readJson(req);
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(str(b.username, 30));
    const ok = u && typeof b.password === 'string' && await checkPw(b.password, u.pw);
    if (!ok) { hit(lk, 15 * 60_000); throw new HttpError(401, 'Benutzername oder Passwort ist falsch.'); }
    buckets.delete(lk);
    return send(res, 200, { ok: true }, startSession(res, u.id));
  }

  if (m === 'POST' && p === '/api/logout') {
    const t = cookies(req).sid;
    if (t) db.prepare('DELETE FROM sessions WHERE token = ?').run(sha(t));
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }

  if (m === 'GET' && p === '/api/me') {
    const u = currentUser(req);
    return send(res, u ? 200 : 401, u || { error: 'Bitte anmelden.' });
  }

  const me = requireUser(req);

  if (m === 'POST' && p === '/api/password') {
    const b = await readJson(req);
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(me.id);
    if (typeof b.old !== 'string' || !(await checkPw(b.old, row.pw))) throw new HttpError(403, 'Das alte Passwort ist falsch.');
    if (typeof b.new !== 'string' || b.new.length < 8 || b.new.length > 200) throw new HttpError(400, 'Das neue Passwort braucht mindestens 8 Zeichen.');
    db.prepare('UPDATE users SET pw = ? WHERE id = ?').run(await hashPw(b.new), me.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(me.id, sha(cookies(req).sid)); // andere Geräte abmelden
    return send(res, 200, { ok: true });
  }

  if (m === 'GET' && p === '/api/tickets') {
    const rows = isTeam(me)
      ? db.prepare(TICKET_SELECT + ' ORDER BY t.created DESC').all()
      : db.prepare(TICKET_SELECT + ' WHERE t.user_id = ? ORDER BY t.created DESC').all(me.id);
    return send(res, 200, rows.map(ticketOut));
  }

  if (m === 'POST' && p === '/api/tickets') {
    const b = await readJson(req);
    const title = str(b.title, 140);
    if (!title) throw new HttpError(400, 'Bitte gib einen Titel ein.');
    const type = TYPES.includes(b.type) ? b.type : 'aufgabe', now = Date.now();
    const r = db.prepare('INSERT INTO tickets(user_id,title,descr,type,created,updated) VALUES(?,?,?,?,?,?)')
      .run(me.id, title, str(b.desc, 5000), type, now, now);
    return send(res, 201, ticketOut(db.prepare(TICKET_SELECT + ' WHERE t.id = ?').get(Number(r.lastInsertRowid))));
  }

  if ((mt = p.match(/^\/api\/tickets\/(\d+)$/))) {
    const id = Number(mt[1]);
    const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
    if (!t || (!isTeam(me) && t.user_id !== me.id)) throw new HttpError(404, 'Ticket nicht gefunden.');

    if (m === 'PATCH') {
      const b = await readJson(req);
      const team = isTeam(me);
      if (!team && t.status !== 'offen') throw new HttpError(403, 'Dieses Ticket wird bereits bearbeitet und ist gesperrt.');
      const n = { title: t.title, descr: t.descr, type: t.type, status: t.status, prio: t.prio, assignee: t.assignee };
      if ('title' in b) { n.title = str(b.title, 140); if (!n.title) throw new HttpError(400, 'Bitte gib einen Titel ein.'); }
      if ('desc' in b) n.descr = str(b.desc, 5000);
      if ('type' in b && TYPES.includes(b.type)) n.type = b.type;
      if (team) {
        if ('status' in b && STATUS.includes(b.status)) n.status = b.status;
        if ('prio' in b && PRIOS.includes(b.prio)) n.prio = b.prio;
        if ('assignee' in b) n.assignee = str(b.assignee, 60);
      }
      db.prepare('UPDATE tickets SET title=?,descr=?,type=?,status=?,prio=?,assignee=?,updated=? WHERE id=?')
        .run(n.title, n.descr, n.type, n.status, n.prio, n.assignee, Date.now(), id);
      return send(res, 200, ticketOut(db.prepare(TICKET_SELECT + ' WHERE t.id = ?').get(id)));
    }
    if (m === 'DELETE') {
      if (!isTeam(me) && t.status !== 'offen') throw new HttpError(403, 'Dieses Ticket kann nicht mehr gelöscht werden.');
      db.prepare('DELETE FROM tickets WHERE id = ?').run(id);
      return send(res, 200, { ok: true });
    }
  }

  if ((mt = p.match(/^\/api\/tickets\/(\d+)\/comments$/))) {
    const id = Number(mt[1]), team = isTeam(me);
    const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
    if (!t || (!team && t.user_id !== me.id)) throw new HttpError(404, 'Ticket nicht gefunden.');
    if (m === 'GET') {
      const rows = db.prepare(`SELECT c.id, c.body, c.internal, c.created, u.username, u.role FROM comments c
        JOIN users u ON u.id = c.user_id WHERE c.ticket_id = ? ${team ? '' : 'AND c.internal = 0'} ORDER BY c.created`).all(id);
      return send(res, 200, rows.map(r => ({ id: r.id, body: r.body, internal: !!r.internal, created: r.created, author: r.username, team: r.role !== 'guest' })));
    }
    if (m === 'POST') {
      const b = await readJson(req), body = str(b.body, 2000);
      if (!body) throw new HttpError(400, 'Bitte schreibe etwas.');
      db.prepare('INSERT INTO comments(ticket_id,user_id,body,internal,created) VALUES(?,?,?,?,?)')
        .run(id, me.id, body, team && b.internal ? 1 : 0, Date.now());
      return send(res, 201, { ok: true });
    }
  }

  // Benutzerverwaltung: nur Besitzer
  if (p === '/api/users' || p.startsWith('/api/users/')) {
    if (me.role !== 'owner') throw new HttpError(403, 'Nur der Besitzer darf Benutzer verwalten.');
    if (m === 'GET' && p === '/api/users')
      return send(res, 200, db.prepare('SELECT id, username, role, created FROM users ORDER BY created').all());
    if ((mt = p.match(/^\/api\/users\/(\d+)$/))) {
      const id = Number(mt[1]);
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      if (!u) throw new HttpError(404, 'Benutzer nicht gefunden.');
      if (u.role === 'owner') throw new HttpError(400, 'Der Besitzer kann nicht geändert oder gelöscht werden.');
      if (m === 'POST') { // Passwort zurücksetzen: Einmal-Passwort wird einmalig angezeigt
        const temp = crypto.randomBytes(9).toString('base64url');
        db.prepare('UPDATE users SET pw = ? WHERE id = ?').run(await hashPw(temp), id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
        return send(res, 200, { password: temp });
      }
      if (m === 'PATCH') {
        const b = await readJson(req);
        if (!['team', 'guest'].includes(b.role)) throw new HttpError(400, 'Ungültige Rolle.');
        db.prepare('UPDATE users SET role = ? WHERE id = ?').run(b.role, id);
        return send(res, 200, { ok: true });
      }
      if (m === 'DELETE') {
        db.prepare('DELETE FROM users WHERE id = ?').run(id);
        return send(res, 200, { ok: true });
      }
    }
  }

  throw new HttpError(404, 'Nicht gefunden.');
}

// ---------- Statische Dateien ----------
const PUBLIC = path.join(__dirname, 'public');
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const SEC_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const f = FILES[url.pathname];
    if (!f || req.method !== 'GET') throw new HttpError(404, 'Nicht gefunden.');
    res.writeHead(200, { 'Content-Type': f[1], 'Cache-Control': 'no-cache' });
    fs.createReadStream(path.join(PUBLIC, f[0])).pipe(res);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.code, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Interner Fehler.' });
  }
});

// Tägliche Sicherung (VACUUM INTO), die letzten 14 bleiben erhalten
function backup() {
  try {
    const dir = path.join(DATA_DIR, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `tickets-${new Date().toISOString().slice(0, 10)}.db`);
    if (!fs.existsSync(file)) db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    fs.readdirSync(dir).filter(f => /^tickets-.*\.db$/.test(f)).sort().slice(0, -14)
      .forEach(f => fs.unlinkSync(path.join(dir, f)));
  } catch (e) { console.error('Sicherung fehlgeschlagen:', e.message); }
}
backup();
setInterval(() => {
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  for (const [k, b] of buckets) if (b.reset < Date.now()) buckets.delete(k);
  backup();
}, 3600_000).unref();
server.listen(PORT, () => console.log(`Ticketsystem läuft auf Port ${PORT}`));
