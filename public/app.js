'use strict';
const COLS = [['offen', 'Offen'], ['arbeit', 'In Arbeit'], ['review', 'In Prüfung'], ['fertig', 'Erledigt']];
const SL = Object.fromEntries(COLS);
const TL = { bug: 'Fehler', feature: 'Neue Funktion', aufgabe: 'Aufgabe' };
const ROLES = { owner: 'Besitzer', team: 'Team', guest: 'Gast' };
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let me = null, tickets = [], cur = null, dragId = null, registering = false, timer = null;
const isTeam = () => me && (me.role === 'owner' || me.role === 'team');

async function api(method, url, body) {
  const opt = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(url, opt);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && me) { me = null; showAuth(); }
    throw new Error(data.error || 'Etwas ist schiefgelaufen.');
  }
  return data;
}

// ---------- Anmeldung ----------
async function showAuth() {
  clearInterval(timer);
  $('app').hidden = true; $('auth').hidden = false;
  try { $('inviteRow').hidden = !(await api('GET', '/api/config')).inviteRequired || !registering; } catch {}
  $('a-pw').value = '';
}
function setMode(reg) {
  registering = reg;
  $('authSubmit').textContent = reg ? 'Konto erstellen' : 'Anmelden';
  $('authToggle').textContent = reg ? 'Schon ein Konto? Anmelden' : 'Noch kein Konto? Registrieren';
  $('a-pw').autocomplete = reg ? 'new-password' : 'current-password';
  $('authErr').textContent = '';
  showAuth();
}
$('authToggle').onclick = () => setMode(!registering);
$('authForm').onsubmit = async e => {
  e.preventDefault();
  $('authErr').textContent = ''; $('authSubmit').disabled = true;
  try {
    await api('POST', registering ? '/api/register' : '/api/login',
      { username: $('a-user').value, password: $('a-pw').value, invite: $('a-inv').value });
    await boot();
  } catch (x) { $('authErr').textContent = x.message; }
  $('authSubmit').disabled = false;
};
$('logout').onclick = async () => { try { await api('POST', '/api/logout'); } catch {} me = null; tickets = []; showAuth(); };

// ---------- Tickets anzeigen ----------
async function boot() {
  try { me = await api('GET', '/api/me'); } catch { me = null; return showAuth(); }
  $('auth').hidden = true; $('app').hidden = false;
  $('role').textContent = `${me.username} (${ROLES[me.role]})`;
  for (const id of ['q', 'fp']) $(id).hidden = !isTeam();
  $('usersBtn').hidden = me.role !== 'owner';
  await load();
  clearInterval(timer);
  timer = setInterval(() => { if (!$('dlg').open && !$('udlg').open && !dragId) load(); }, 20000);
}
async function load() {
  try { tickets = await api('GET', '/api/tickets'); render(); } catch {}
}
function cardHtml(t) {
  const d = new Date(t.created).toLocaleDateString('de-DE');
  const right = isTeam()
    ? `<span class="who">${esc(t.author.name)}${t.assignee ? ' → ' + esc(t.assignee) : ''}</span>`
    : `<span class="who chip">${SL[t.status]}</span>`;
  return `<div class="card ${t.prio}" ${isTeam() ? 'draggable="true"' : ''} tabindex="0" data-id="${t.id}">` +
    `<b>${esc(t.title)}</b><div class="meta"><span>TCK-${t.id}</span><span class="type ${t.type}">${TL[t.type]}</span><span>${d}</span>${right}</div></div>`;
}
function render() {
  const main = $('main');
  if (isTeam()) {
    const q = $('q').value.toLowerCase(), fp = $('fp').value;
    const ts = tickets.filter(t => (!fp || t.prio === fp) &&
      (!q || `${t.title} ${t.desc} ${t.author.name}`.toLowerCase().includes(q)));
    main.className = 'board';
    main.innerHTML = COLS.map(([k, l]) => {
      const c = ts.filter(t => t.status === k);
      return `<section class="col" data-s="${k}"><h2>${l}<span>${c.length}</span></h2>` +
        (c.length ? c.map(cardHtml).join('') : '<div class="empty">Keine Tickets. Ziehe eines hierher.</div>') + '</section>';
    }).join('');
  } else {
    main.className = 'mine';
    main.innerHTML = '<h2>Meine Tickets</h2>' + (tickets.length ? tickets.map(cardHtml).join('')
      : '<div class="empty">Du hast noch kein Ticket erstellt. Nur du und das Team können deine Tickets sehen.</div>');
  }
}
$('q').oninput = render; $('fp').oninput = render;

// ---------- Ticket-Dialog ----------
function openDlg(t) {
  cur = t;
  const own = !t || t.author.id === me.id;
  const editable = isTeam() || (own && (!t || t.status === 'offen'));
  $('dt').textContent = t ? 'Ticket' : 'Neues Ticket';
  $('sub').textContent = t ? `TCK-${t.id} · Von ${t.author.name} am ${new Date(t.created).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}` : '';
  $('f-title').value = t ? t.title : ''; $('f-desc').value = t ? t.desc : ''; $('f-type').value = t ? t.type : 'aufgabe';
  for (const id of ['f-title', 'f-desc', 'f-type']) $(id).disabled = !editable;
  $('f-stat').innerHTML = COLS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
  $('f-stat').value = t ? t.status : 'offen'; $('f-prio').value = t ? t.prio : 'mittel'; $('f-ass').value = t ? t.assignee : '';
  $('tri').hidden = !(isTeam() && t);
  $('save').hidden = !editable;
  $('del').hidden = !t || !editable;
  $('err').textContent = '';
  $('cbox').hidden = !t; $('intRow').hidden = !isTeam(); $('f-cm').value = ''; $('f-int').checked = false;
  if (t) loadComments();
  $('dlg').showModal();
}
async function loadComments() {
  const id = cur.id;
  try {
    const cs = await api('GET', `/api/tickets/${id}/comments`);
    if (!cur || cur.id !== id) return;
    $('clist').innerHTML = cs.length ? cs.map(c => `<div class="cm${c.internal ? ' internal' : ''}"><small>${esc(c.author)}${c.team ? ' (Team)' : ''}` +
      `${c.internal ? ' · intern' : ''} · ${new Date(c.created).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}</small>${esc(c.body)}</div>`).join('')
      : '<div class="empty">Noch keine Nachrichten.</div>';
  } catch (x) { $('err').textContent = x.message; }
}
$('cadd').onclick = async () => {
  const body = $('f-cm').value.trim();
  if (!body || !cur) return;
  $('cadd').disabled = true;
  try { await api('POST', `/api/tickets/${cur.id}/comments`, { body, internal: $('f-int').checked }); $('f-cm').value = ''; await loadComments(); }
  catch (x) { $('err').textContent = x.message; }
  $('cadd').disabled = false;
};
$('new').onclick = () => openDlg(null);
$('cancel').onclick = () => { cur = null; $('dlg').close(); };
$('save').onclick = async () => {
  const title = $('f-title').value.trim();
  if (!title) { $('err').textContent = 'Bitte gib einen Titel ein.'; return; }
  const body = { title, desc: $('f-desc').value, type: $('f-type').value };
  if (isTeam() && cur) Object.assign(body, { status: $('f-stat').value, prio: $('f-prio').value, assignee: $('f-ass').value });
  $('save').disabled = true;
  try {
    if (cur) await api('PATCH', `/api/tickets/${cur.id}`, body); else await api('POST', '/api/tickets', body);
    $('dlg').close(); await load();
  } catch (x) { $('err').textContent = x.message; }
  $('save').disabled = false;
};
$('del').onclick = async () => {
  if (!confirm('Ticket wirklich löschen?')) return;
  try { await api('DELETE', `/api/tickets/${cur.id}`); $('dlg').close(); await load(); }
  catch (x) { $('err').textContent = x.message; }
};

// ---------- Board: Klicken und Ziehen ----------
const M = $('main'), byId = id => tickets.find(t => t.id === Number(id));
M.addEventListener('click', e => { const c = e.target.closest('.card'); if (c) openDlg(byId(c.dataset.id)); });
M.addEventListener('keydown', e => { if (e.key === 'Enter') { const c = e.target.closest('.card'); if (c) openDlg(byId(c.dataset.id)); } });
M.addEventListener('dragstart', e => { const c = e.target.closest('.card'); if (c) { dragId = c.dataset.id; e.dataTransfer.setData('text/plain', dragId); } });
M.addEventListener('dragover', e => {
  const c = e.target.closest('.col');
  if (c) { e.preventDefault(); document.querySelectorAll('.col.over').forEach(x => x.classList.remove('over')); c.classList.add('over'); }
});
M.addEventListener('dragend', () => { dragId = null; render(); });
M.addEventListener('drop', async e => {
  e.preventDefault();
  const c = e.target.closest('.col'), t = dragId && byId(dragId);
  dragId = null;
  if (c && t && t.status !== c.dataset.s) {
    const old = t.status; t.status = c.dataset.s; render();
    try { await api('PATCH', `/api/tickets/${t.id}`, { status: c.dataset.s }); }
    catch { t.status = old; }
  }
  render();
});

// ---------- Benutzerverwaltung (Besitzer) ----------
async function openUsers() {
  $('uerr').textContent = ''; $('utemp').innerHTML = '';
  try {
    const us = await api('GET', '/api/users');
    $('ulist').innerHTML = us.map(u => u.role === 'owner'
      ? `<div class="urow"><span>${esc(u.username)}</span><span class="badge">Besitzer</span></div>`
      : `<div class="urow" data-id="${u.id}"><span>${esc(u.username)}</span>` +
        `<select aria-label="Rolle von ${esc(u.username)}"><option value="guest"${u.role === 'guest' ? ' selected' : ''}>Gast</option>` +
        `<option value="team"${u.role === 'team' ? ' selected' : ''}>Team</option></select>` +
        `<button data-reset="1">Passwort zurücksetzen</button><button class="danger" data-del="1">Löschen</button></div>`).join('');
    if (!$('udlg').open) $('udlg').showModal();
  } catch (x) { $('uerr').textContent = x.message; }
}
$('usersBtn').onclick = openUsers;
$('uclose').onclick = () => { $('udlg').close(); load(); };
$('ulist').addEventListener('change', async e => {
  const row = e.target.closest('.urow');
  try { await api('PATCH', `/api/users/${row.dataset.id}`, { role: e.target.value }); } catch (x) { $('uerr').textContent = x.message; }
});
$('ulist').addEventListener('click', async e => {
  const row = e.target.closest('.urow');
  if (e.target.dataset.reset) {
    if (!confirm('Passwort wirklich zurücksetzen? Der Benutzer wird überall abgemeldet.')) return;
    try {
      const r = await api('POST', `/api/users/${row.dataset.id}`, {});
      $('uerr').innerHTML = '';
      $('utemp').innerHTML = `<div class="temp">Neues Einmal-Passwort für ${esc(row.querySelector('span').textContent)}: <code>${esc(r.password)}</code><br>` +
        'Gib es dem Benutzer weiter. Er sollte es danach unter "Passwort" ändern. Es wird nur jetzt angezeigt.</div>';
    } catch (x) { $('uerr').textContent = x.message; }
    return;
  }
  if (!e.target.dataset.del) return;
  if (!confirm('Benutzer samt allen seinen Tickets löschen?')) return;
  try { await api('DELETE', `/api/users/${row.dataset.id}`); await openUsers(); } catch (x) { $('uerr').textContent = x.message; }
});

// ---------- Eigenes Passwort ----------
$('pwBtn').onclick = () => { $('p-old').value = ''; $('p-new').value = ''; $('perr').textContent = ''; $('pdlg').showModal(); };
$('pclose').onclick = () => $('pdlg').close();
$('psave').onclick = async () => {
  $('perr').textContent = '';
  try { await api('POST', '/api/password', { old: $('p-old').value, new: $('p-new').value }); $('pdlg').close(); alert('Dein Passwort wurde geändert.'); }
  catch (x) { $('perr').textContent = x.message; }
};

boot();
