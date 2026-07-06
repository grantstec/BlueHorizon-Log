/* =========================================================================
   BlueHorizon Log v2.0 — minimal documentation app for BlueHorizon Rocketry
   Backend: a GitHub repo. Layout inside the repo:
     data/projects.json          -> [{id, name}]
     data/roster.json            -> [{id, name}]           (no emails here!)
     data/team.json              -> {goals:[...], tasks:[...]}
     data/pos.json               -> purchase orders (see importPO)
     data/index.json             -> [entry meta, newest first]
     data/entries/<id>.md        -> full markdown entry (durable archive)
     data/photos/<id>/<n>.jpg    -> compressed photos
     data/files/<id>/<name>      -> attachments (xlsx, pdf, ...)
   Reads are public (raw.githubusercontent.com) or token-authed.
   Writes use the GitHub Contents API and need a token with Contents R/W.
   ========================================================================= */

'use strict';

/* ---------- config / state ---------- */

const DEFAULT_PROJECTS = [
  { id: 'engine',          name: 'Engine' },
  { id: 'flight-computer', name: 'Flight Computer' },
  { id: 'gse',             name: 'GSE' },
  { id: 'sim-controls',    name: 'Simulation & Controls' },
  { id: 'solids',          name: 'Solids' },
  { id: 'structures',      name: 'Structures' },
  { id: 'team',            name: 'Team / General' },
];

const cfg = {
  get name()   { return localStorage.getItem('bh_name')   || ''; },
  get rid()    { return localStorage.getItem('bh_rid')    || ''; },
  get repo()   { return localStorage.getItem('bh_repo')   || ''; },
  get branch() { return localStorage.getItem('bh_branch') || 'main'; },
  get token()  { return localStorage.getItem('bh_token')  || ''; },
  set(k, v)    { localStorage.setItem('bh_' + k, String(v).trim()); },
};

const state = {
  entries: [],
  projects: [],
  roster: [],
  team: { goals: [], tasks: [] },
  pos: [],
  filter: 'all',
  photoFilter: 'all',
  composePhotos: [],   // [{blob, dataUrl}]  (new photos this session)
  composeFiles: [],    // [{file, name, size}] (new attachments)
  keepPhotos: [],      // existing photo paths kept while editing
  keepFiles: [],       // existing file objects kept while editing
  composeType: 'log',
  editingId: null,     // entry id being edited, or null
  editingTaskId: null,
  showDone: false,
  view: 'home',
  openProject: null,
  openPo: null,
  openEntry: null,
  blobCache: new Map(),
};

const $ = (id) => document.getElementById(id);

/* ---------- GitHub API ---------- */

const api = {
  base() { return `https://api.github.com/repos/${cfg.repo}`; },

  headers(extra = {}) {
    const h = { Accept: 'application/vnd.github+json', ...extra };
    if (cfg.token) h.Authorization = `Bearer ${cfg.token}`;
    return h;
  },

  async read(path) {
    const r = await fetch(`${this.base()}/contents/${path}?ref=${cfg.branch}&t=${Date.now()}`,
      { headers: this.headers({ Accept: 'application/vnd.github.raw' }) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub read failed (${r.status})`);
    return { text: await r.text() };
  },

  async readBlob(path) {
    const r = await fetch(`${this.base()}/contents/${path}?ref=${cfg.branch}`,
      { headers: this.headers({ Accept: 'application/vnd.github.raw' }) });
    if (!r.ok) throw new Error(`GitHub read failed (${r.status})`);
    return r.blob();
  },

  async sha(path) {
    const r = await fetch(`${this.base()}/contents/${path}?ref=${cfg.branch}&t=${Date.now()}`,
      { headers: this.headers() });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub stat failed (${r.status})`);
    return (await r.json()).sha;
  },

  async write(path, content, message, sha = null) {
    const b64 = await toBase64(content);
    const body = { message, content: b64, branch: cfg.branch };
    if (sha) body.sha = sha;
    const r = await fetch(`${this.base()}/contents/${path}`, {
      method: 'PUT', headers: this.headers(), body: JSON.stringify(body),
    });
    if (!r.ok) {
      const detail = (await r.json().catch(() => ({}))).message || r.status;
      throw new Error(`GitHub write failed: ${detail}`);
    }
    return r.json();
  },

  async remove(path, message) {
    const sha = await this.sha(path);
    if (!sha) return;
    const r = await fetch(`${this.base()}/contents/${path}`, {
      method: 'DELETE', headers: this.headers(),
      body: JSON.stringify({ message, sha, branch: cfg.branch }),
    });
    if (!r.ok) throw new Error(`GitHub delete failed (${r.status})`);
  },

  async readJson(path, fallback) {
    const f = await this.read(path);
    if (!f) return fallback;
    try { return JSON.parse(f.text); } catch { return fallback; }
  },

  async updateJson(path, mutate, message) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const sha = await this.sha(path);
      const current = sha ? await this.readJson(path, null) : null;
      const next = mutate(current);
      try {
        return await this.write(path, JSON.stringify(next, null, 2), message, sha);
      } catch (e) {
        if (attempt === 2 || !/409|does not match/.test(String(e))) throw e;
      }
    }
  },
};

async function toBase64(content) {
  let blob;
  if (content instanceof Blob) blob = content;
  else if (content instanceof Uint8Array) blob = new Blob([content]);
  else blob = new Blob([String(content)]);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function rawUrl(path) {
  return `https://raw.githubusercontent.com/${cfg.repo}/${cfg.branch}/${path}`;
}

function photoUrl(path) {
  if (!cfg.token) return rawUrl(path);
  if (state.blobCache.has(path)) return state.blobCache.get(path);
  api.readBlob(path).then((b) => {
    const url = URL.createObjectURL(b);
    state.blobCache.set(path, url);
    document.querySelectorAll(`img[data-path="${CSS.escape(path)}"]`)
      .forEach((el) => { el.src = url; });
  }).catch(() => {});
  return '';
}

/* Lazy-load SheetJS for xlsx/csv parsing + viewing */
let _xlsxPromise = null;
function loadXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (!_xlsxPromise) {
    _xlsxPromise = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      s.onload = () => res(window.XLSX);
      s.onerror = () => rej(new Error('Couldn’t load spreadsheet library (offline?)'));
      document.head.appendChild(s);
    });
  }
  return _xlsxPromise;
}

/* ---------- data load ---------- */

async function loadAll(showSpinner = true) {
  if (!cfg.repo) { openSettings(true); return; }
  const btn = $('btnSync');
  if (showSpinner) btn.classList.add('spin');
  try {
    const [projects, entries, roster, team, pos] = await Promise.all([
      api.readJson('data/projects.json', DEFAULT_PROJECTS),
      api.readJson('data/index.json', []),
      api.readJson('data/roster.json', []),
      api.readJson('data/team.json', { goals: [], tasks: [] }),
      api.readJson('data/pos.json', []),
    ]);
    state.projects = projects;
    state.entries = entries;
    state.roster = roster;
    state.team = { goals: team.goals || [], tasks: team.tasks || [] };
    state.pos = pos;
    render();
    maybeAskWho();
  } catch (e) {
    toast(`Couldn’t load: ${e.message}`, true);
  } finally {
    btn.classList.remove('spin');
  }
}

function maybeAskWho() {
  if (state.roster.length && !cfg.rid && !localStorage.getItem('bh_who_skipped')) {
    const list = $('whoList');
    list.innerHTML = '';
    state.roster.forEach((m) => {
      const b = document.createElement('button');
      b.className = 'more-item';
      b.textContent = m.name;
      b.onclick = () => {
        cfg.set('rid', m.id);
        cfg.set('name', m.name);
        $('whoSheet').classList.add('hidden');
        render();
      };
      list.appendChild(b);
    });
    $('whoSheet').classList.remove('hidden');
  }
}

/* ---------- rendering ---------- */

function render() {
  renderHome();
  renderFilters($('feedFilters'), state.filter, (id) => { state.filter = id; render(); });
  renderFilters($('photoFilters'), state.photoFilter, (id) => { state.photoFilter = id; render(); });
  renderFeed();
  renderPhotos();
  renderProjects();
  renderMeetings();
  renderPos();
  renderRoster();
  if (state.openProject) renderProjectDetail();
  if (state.openPo) renderPoDetail();
}

function projName(id) {
  return (state.projects.find((p) => p.id === id) || {}).name || id;
}
function memberName(id) {
  return (state.roster.find((m) => m.id === id) || {}).name || id;
}

function renderFilters(el, active, onPick) {
  el.innerHTML = '';
  const mk = (id, label) => {
    const b = document.createElement('button');
    b.className = 'chip' + (active === id ? ' active' : '');
    b.textContent = label;
    b.onclick = () => onPick(id);
    el.appendChild(b);
  };
  mk('all', 'All');
  mk('journal', 'Journals');
  mk('meeting', 'Meetings');
  state.projects.forEach((p) => mk(p.id, p.name));
}

function matchesFilter(e, f) {
  if (f === 'all') return true;
  if (f === 'journal') return e.type === 'journal';
  if (f === 'meeting') return e.type === 'meeting';
  return e.project === f;
}

/* ----- home ----- */

function renderHome() {
  const hello = cfg.name ? `Welcome back, ${esc(cfg.name.split(' ')[0])} 🚀` : 'BlueHorizon Rocketry';
  const open = state.team.tasks.filter((t) => t.status !== 'done');
  const overdue = open.filter((t) => t.due && t.due < today()).length;
  $('homeWelcome').innerHTML = `${hello}<span class="sub">${open.length} open task${open.length === 1 ? '' : 's'}${overdue ? ` · <b style="color:var(--danger)">${overdue} overdue</b>` : ''} · ${state.entries.length} entries documented</span>`;

  // goals
  const gl = $('goalList');
  gl.innerHTML = '';
  if (!state.team.goals.length) gl.innerHTML = '<p class="settings-note">No goals yet — add season goals so everyone sees the mission.</p>';
  state.team.goals.forEach((g) => {
    const div = document.createElement('div');
    div.className = 'goal-item' + (g.done ? ' done' : '');
    div.innerHTML = `<div class="check ${g.done ? 'on' : ''}">✓</div>
      <div class="g-text">${esc(g.text)}${g.due ? ` <span class="t-meta t-due ${dueClass(g.due)}">${fmtDue(g.due)}</span>` : ''}</div>`;
    div.querySelector('.check').onclick = () => toggleGoal(g.id);
    div.querySelector('.g-text').onclick = () => editGoal(g.id);
    gl.appendChild(div);
  });

  // my tasks
  $('myTasksTitle').textContent = cfg.name ? `My Tasks` : 'Tasks (pick your name in the roster)';
  const mine = open.filter((t) => (t.assignees || []).includes(cfg.rid)).sort(byDue);
  const ml = $('myTaskList');
  ml.innerHTML = '';
  if (!mine.length) ml.innerHTML = `<p class="settings-note">${cfg.rid ? 'Nothing assigned to you. Enjoy it while it lasts.' : ''}</p>`;
  mine.forEach((t) => ml.appendChild(taskRow(t)));

  // all tasks
  const al = $('allTaskList');
  al.innerHTML = '';
  const shown = (state.showDone ? state.team.tasks : open).slice().sort(byDue);
  if (!shown.length) al.innerHTML = '<p class="settings-note">No tasks yet — tap “+ Task” to assign work with deadlines.</p>';
  shown.forEach((t) => al.appendChild(taskRow(t)));
  $('btnToggleDone').textContent = state.showDone ? 'hide done' : 'show done';

  // recent activity
  const rl = $('homeRecent');
  rl.innerHTML = '';
  state.entries.slice(0, 3).forEach((e) => rl.appendChild(entryCard(e)));
}

function byDue(a, b) { return (a.due || '9999') < (b.due || '9999') ? -1 : 1; }
function today() { return new Date().toISOString().slice(0, 10); }
function dueClass(due) {
  if (!due) return '';
  if (due < today()) return 'overdue';
  const soon = new Date(); soon.setDate(soon.getDate() + 3);
  return due <= soon.toISOString().slice(0, 10) ? 'soon' : '';
}
function fmtDue(due) {
  if (!due) return '';
  const d = new Date(due + 'T00:00');
  const label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return due < today() ? `⚠ ${label}` : label;
}

function taskRow(t) {
  const div = document.createElement('div');
  div.className = 'task-item' + (t.status === 'done' ? ' done' : '');
  const who = (t.assignees || []).map(memberName).join(', ');
  div.innerHTML = `<div class="check ${t.status === 'done' ? 'on' : ''}">✓</div>
    <div class="t-main">
      <div class="t-title">${esc(t.title)}</div>
      <div class="t-meta">
        ${t.due ? `<span class="t-due ${dueClass(t.due)}">${fmtDue(t.due)}</span>` : ''}
        ${t.project ? `<span class="badge">${esc(projName(t.project))}</span>` : ''}
        ${who ? `<span>${esc(who)}</span>` : '<span>unassigned</span>'}
      </div>
    </div>`;
  div.querySelector('.check').onclick = () => toggleTask(t.id);
  div.querySelector('.t-main').onclick = () => openTaskSheet(t.id);
  return div;
}

/* ----- feed / photos / projects (same as v1, + meetings) ----- */

function entryCard(e, clamp = true) {
  const card = document.createElement('div');
  card.className = 'card';
  card.onclick = () => openEntry(e);

  const when = new Date(e.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const badge = e.type === 'journal' ? '<span class="badge journal">Journal</span>'
    : e.type === 'meeting' ? '<span class="badge" style="background:rgba(251,191,36,0.12);color:#fbbf24">Meeting</span>'
    : `<span class="badge">${esc(projName(e.project))}</span>`;

  const nFiles = (e.files || []).length;
  card.innerHTML = `
    <div class="card-meta">${badge}<span>${esc(e.author || 'Unknown')}</span><span>·</span><span>${when}</span>${nFiles ? `<span>· 📎 ${nFiles}</span>` : ''}</div>
    ${e.title ? `<div class="card-title">${esc(e.title)}</div>` : ''}
    ${e.body ? `<div class="card-body${clamp ? ' clamp' : ''}">${esc(e.body)}</div>` : ''}
  `;

  if (e.photos && e.photos.length) {
    const row = document.createElement('div');
    row.className = 'card-photos';
    e.photos.slice(0, 6).forEach((p) => {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.dataset.path = p;
      img.src = photoUrl(p);
      img.alt = e.title || 'photo';
      row.appendChild(img);
    });
    card.appendChild(row);
  }
  return card;
}

function renderFeed() {
  const list = $('feedList');
  list.innerHTML = '';
  const items = state.entries.filter((e) => matchesFilter(e, state.filter));
  $('feedEmpty').classList.toggle('hidden', items.length > 0);
  items.forEach((e) => list.appendChild(entryCard(e)));
}

function renderPhotos() {
  const grid = $('photoGrid');
  grid.innerHTML = '';
  const photos = [];
  state.entries
    .filter((e) => matchesFilter(e, state.photoFilter))
    .forEach((e) => (e.photos || []).forEach((p) => photos.push({ path: p, entry: e })));
  $('photosEmpty').classList.toggle('hidden', photos.length > 0);
  photos.forEach(({ path, entry }) => {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.dataset.path = path;
    img.src = photoUrl(path);
    img.alt = entry.title || projName(entry.project);
    img.onclick = () => openLightbox(path, entry);
    grid.appendChild(img);
  });
}

function renderProjects() {
  const list = $('projectList');
  list.innerHTML = '';
  state.projects.forEach((p) => {
    const n = state.entries.filter((e) => e.project === p.id).length;
    const card = document.createElement('div');
    card.className = 'project-card';
    card.innerHTML = `<span class="project-name">${esc(p.name)}</span>
                      <span class="project-count">${n} entr${n === 1 ? 'y' : 'ies'} ›</span>`;
    card.onclick = () => { state.openProject = p.id; switchView('project'); renderProjectDetail(); };
    list.appendChild(card);
  });
}

function renderProjectDetail() {
  $('projectTitle').textContent = projName(state.openProject);
  const list = $('projectEntries');
  list.innerHTML = '';
  const items = state.entries.filter((e) => e.project === state.openProject);
  if (!items.length) { list.innerHTML = '<div class="empty"><p>No entries for this project yet.</p></div>'; return; }
  items.forEach((e) => list.appendChild(entryCard(e)));
}

function renderMeetings() {
  const list = $('meetingList');
  list.innerHTML = '';
  const items = state.entries.filter((e) => e.type === 'meeting');
  $('meetingsEmpty').classList.toggle('hidden', items.length > 0);
  items.forEach((e) => list.appendChild(entryCard(e)));
}

/* ----- roster ----- */

function renderRoster() {
  const list = $('rosterList');
  list.innerHTML = '';
  state.roster.forEach((m) => {
    const n = state.team.tasks.filter((t) => t.status !== 'done' && (t.assignees || []).includes(m.id)).length;
    const div = document.createElement('div');
    div.className = 'project-card';
    div.innerHTML = `<span class="project-name">${esc(m.name)}${m.id === cfg.rid ? ' <span class="badge">you</span>' : ''}</span>
      <span class="project-count">${n} open task${n === 1 ? '' : 's'}</span>`;
    div.onclick = () => {
      const action = confirm(`Remove ${m.name} from the roster?\n(OK = remove, Cancel = keep)`);
      if (action) removeMember(m.id);
    };
    list.appendChild(div);
  });
  if (!state.roster.length) list.innerHTML = '<p class="settings-note">No members yet. Add the team so tasks can be assigned and everyone can pick their name.</p>';
}

async function addMember() {
  const name = prompt('Member name:');
  if (!name || !name.trim()) return;
  if (!requireToken()) return;
  const id = slug(name);
  try {
    await api.updateJson('data/roster.json',
      (cur) => {
        const list = Array.isArray(cur) ? cur : [];
        if (list.some((m) => m.id === id)) return list;
        return [...list, { id, name: name.trim() }].sort((a, b) => a.name.localeCompare(b.name));
      }, `roster: add ${name.trim()}`);
    await loadAll(false);
    toast('Member added ✓');
  } catch (e) { toast(e.message, true); }
}

async function removeMember(id) {
  if (!requireToken()) return;
  try {
    await api.updateJson('data/roster.json',
      (cur) => (Array.isArray(cur) ? cur : []).filter((m) => m.id !== id),
      `roster: remove ${id}`);
    await loadAll(false);
  } catch (e) { toast(e.message, true); }
}

/* ----- goals & tasks ----- */

function saveTeam(message) {
  return api.updateJson('data/team.json',
    (cur) => {
      // merge: keep server copy but apply our current state for simplicity;
      // conflicts are rare at club scale and git history preserves everything
      return state.team;
    }, message);
}

async function addGoal() {
  const text = prompt('Team goal (e.g. "Hot-fire the engine by March"):');
  if (!text || !text.trim()) return;
  if (!requireToken()) return;
  state.team.goals.push({ id: uid(), text: text.trim(), done: false });
  render();
  try { await saveTeam(`goal: ${text.trim().slice(0, 50)}`); } catch (e) { toast(e.message, true); }
}

async function editGoal(id) {
  const g = state.team.goals.find((x) => x.id === id);
  if (!g) return;
  const text = prompt('Edit goal (clear the text to delete it):', g.text);
  if (text === null) return;
  if (!requireToken()) return;
  if (!text.trim()) state.team.goals = state.team.goals.filter((x) => x.id !== id);
  else g.text = text.trim();
  render();
  try { await saveTeam('goal: edit'); } catch (e) { toast(e.message, true); }
}

async function toggleGoal(id) {
  if (!requireToken()) return;
  const g = state.team.goals.find((x) => x.id === id);
  if (!g) return;
  g.done = !g.done;
  render();
  try { await saveTeam(`goal: ${g.done ? 'complete' : 'reopen'} ${g.text.slice(0, 40)}`); } catch (e) { toast(e.message, true); }
}

async function toggleTask(id) {
  if (!requireToken()) return;
  const t = state.team.tasks.find((x) => x.id === id);
  if (!t) return;
  t.status = t.status === 'done' ? 'open' : 'done';
  t.completedAt = t.status === 'done' ? new Date().toISOString() : undefined;
  render();
  try { await saveTeam(`task: ${t.status} — ${t.title.slice(0, 40)}`); } catch (e) { toast(e.message, true); }
}

function openTaskSheet(id = null) {
  state.editingTaskId = id;
  const t = id ? state.team.tasks.find((x) => x.id === id) : null;
  $('taskSheetTitle').textContent = t ? 'Edit Task' : 'New Task';
  $('taskTitle').value = t ? t.title : '';
  $('taskNotes').value = t ? (t.notes || '') : '';
  $('taskDue').value = t ? (t.due || '') : '';
  $('taskProject').innerHTML = '<option value="">— none —</option>' +
    state.projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  $('taskProject').value = t ? (t.project || '') : '';
  const ag = $('taskAssignees');
  ag.innerHTML = '';
  if (!state.roster.length) ag.innerHTML = '<p class="settings-note">Add members in the Roster first to assign tasks.</p>';
  state.roster.forEach((m) => {
    const chip = document.createElement('button');
    chip.className = 'assignee-chip' + ((t && (t.assignees || []).includes(m.id)) ? ' on' : '');
    chip.textContent = m.name;
    chip.dataset.rid = m.id;
    chip.onclick = () => chip.classList.toggle('on');
    ag.appendChild(chip);
  });
  $('taskDelete').classList.toggle('hidden', !t);
  $('taskSheet').classList.remove('hidden');
}

async function saveTask() {
  const title = $('taskTitle').value.trim();
  if (!title) { toast('Task needs a title', true); return; }
  if (!requireToken()) return;
  const assignees = [...document.querySelectorAll('#taskAssignees .assignee-chip.on')].map((c) => c.dataset.rid);
  const data = {
    title,
    notes: $('taskNotes').value.trim(),
    project: $('taskProject').value || undefined,
    due: $('taskDue').value || undefined,
    assignees,
  };
  if (state.editingTaskId) {
    Object.assign(state.team.tasks.find((x) => x.id === state.editingTaskId), data);
  } else {
    state.team.tasks.push({ id: uid(), status: 'open', created: new Date().toISOString(), createdBy: cfg.name || 'Unknown', ...data });
  }
  $('taskSheet').classList.add('hidden');
  render();
  try { await saveTeam(`task: ${title.slice(0, 50)}`); toast('Task saved ✓'); } catch (e) { toast(e.message, true); }
}

async function deleteTask() {
  if (!state.editingTaskId || !requireToken()) return;
  state.team.tasks = state.team.tasks.filter((x) => x.id !== state.editingTaskId);
  $('taskSheet').classList.add('hidden');
  render();
  try { await saveTeam('task: delete'); } catch (e) { toast(e.message, true); }
}

/* ----- purchase orders ----- */

function renderPos() {
  const list = $('poList');
  list.innerHTML = '';
  $('posEmpty').classList.toggle('hidden', state.pos.length > 0);
  state.pos.forEach((po) => {
    const arrived = po.rows.filter((r) => r.arrived).length;
    const div = document.createElement('div');
    div.className = 'project-card';
    div.innerHTML = `<div><div class="project-name">${esc(po.name)}</div>
        <div class="project-count">${new Date(po.uploaded).toLocaleDateString()} · ${esc(po.by || '')}</div></div>
      <span class="project-count">${arrived}/${po.rows.length} arrived ›</span>`;
    div.onclick = () => { state.openPo = po.id; switchView('po'); renderPoDetail(); };
    list.appendChild(div);
  });
}

async function importPoFile(file) {
  if (!requireToken()) return;
  toast('Reading spreadsheet…');
  try {
    const XLSX = await loadXLSX();
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rowsRaw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    // first non-empty row = headers
    const hIdx = rowsRaw.findIndex((r) => r.some((c) => String(c).trim() !== ''));
    if (hIdx === -1) { toast('Spreadsheet looks empty', true); return; }
    const headers = rowsRaw[hIdx].map((h, i) => String(h).trim() || `Col ${i + 1}`);
    const rows = rowsRaw.slice(hIdx + 1)
      .filter((r) => r.some((c) => String(c).trim() !== ''))
      .map((r) => ({ cells: headers.map((_, i) => String(r[i] ?? '')), arrived: false }));
    if (!rows.length) { toast('No line items found', true); return; }

    const name = prompt('Name this purchase order:', file.name.replace(/\.(xlsx|xls|csv)$/i, '')) || file.name;
    const id = uid();
    const filePath = `data/files/po-${id}/${sanitizeName(file.name)}`;

    toast('Uploading…');
    await api.write(filePath, file, `po: original file for ${name}`);
    const po = { id, name: name.trim(), uploaded: new Date().toISOString(), by: cfg.name || 'Unknown', file: filePath, headers, rows };
    await api.updateJson('data/pos.json', (cur) => [po, ...(Array.isArray(cur) ? cur : [])], `po: import ${name}`);
    state.pos.unshift(po);
    render();
    state.openPo = id;
    switchView('po');
    renderPoDetail();
    toast(`Imported ${rows.length} line items ✓`);
  } catch (e) { toast(e.message, true); }
}

function renderPoDetail() {
  const po = state.pos.find((p) => p.id === state.openPo);
  if (!po) return;
  $('poTitle').textContent = po.name;
  const arrived = po.rows.filter((r) => r.arrived).length;
  $('poMeta').innerHTML = `${new Date(po.uploaded).toLocaleDateString()} · imported by ${esc(po.by || '?')} · <a style="color:var(--accent)" href="#" id="poDownload">download original</a>`;
  $('poProgressBar').style.width = po.rows.length ? `${(arrived / po.rows.length) * 100}%` : '0';
  const dl = $('poDownload');
  if (dl) dl.onclick = (ev) => { ev.preventDefault(); downloadFile(po.file, po.file.split('/').pop()); };

  const wrap = $('poTableWrap');
  const table = document.createElement('table');
  table.className = 'data-table';
  table.innerHTML = `<thead><tr><th>✓</th>${po.headers.map((h) => `<th>${esc(h)}</th>`).join('')}<th>Note</th></tr></thead>`;
  const tbody = document.createElement('tbody');
  po.rows.forEach((row, i) => {
    const tr = document.createElement('tr');
    tr.className = row.arrived ? 'arrived' : '';
    tr.innerHTML = `<td><div class="check ${row.arrived ? 'on' : ''}">✓</div></td>` +
      row.cells.map((c) => `<td>${esc(c)}</td>`).join('') +
      `<td>${esc(row.note || '')}</td>`;
    tr.querySelector('.check').onclick = () => togglePoRow(po.id, i);
    tr.lastElementChild.onclick = () => notePoRow(po.id, i);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.innerHTML = '';
  wrap.appendChild(table);
}

async function togglePoRow(poId, rowIdx) {
  if (!requireToken()) return;
  const po = state.pos.find((p) => p.id === poId);
  const row = po.rows[rowIdx];
  row.arrived = !row.arrived;
  row.arrivedBy = row.arrived ? (cfg.name || 'Unknown') : undefined;
  row.arrivedAt = row.arrived ? new Date().toISOString() : undefined;
  renderPoDetail();
  renderPos();
  try { await savePos(`po: ${po.name} row ${rowIdx + 1} ${row.arrived ? 'arrived' : 'not arrived'}`); }
  catch (e) { toast(e.message, true); }
}

async function notePoRow(poId, rowIdx) {
  const po = state.pos.find((p) => p.id === poId);
  const row = po.rows[rowIdx];
  const note = prompt('Note for this line item (backorder, wrong part, etc.):', row.note || '');
  if (note === null) return;
  if (!requireToken()) return;
  row.note = note.trim() || undefined;
  renderPoDetail();
  try { await savePos(`po: note on ${po.name} row ${rowIdx + 1}`); } catch (e) { toast(e.message, true); }
}

function savePos(message) {
  return api.updateJson('data/pos.json', () => state.pos, message);
}

/* ----- entry detail / edit / delete ----- */

function fileIcon(name) {
  if (/\.(xlsx|xls|csv)$/i.test(name)) return '📊';
  if (/\.pdf$/i.test(name)) return '📄';
  if (/\.(docx|doc|txt|md)$/i.test(name)) return '📝';
  if (/\.(pptx|ppt)$/i.test(name)) return '📽';
  if (/\.(step|stl|dxf)$/i.test(name)) return '⚙️';
  return '📎';
}

function openEntry(e) {
  state.openEntry = e;
  $('entrySheetTitle').textContent = e.type === 'meeting' ? 'Meeting Notes' : projName(e.project);
  const el = $('entryDetail');
  const when = new Date(e.date).toLocaleDateString(undefined, { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' });
  el.innerHTML = `
    ${e.title ? `<h2 style="font-size:20px">${esc(e.title)}</h2>` : ''}
    <div class="detail-meta">${esc(e.author || 'Unknown')} · ${when}${e.type === 'journal' ? ' · Weekly journal' : ''}${e.edited ? ' · edited' : ''}</div>
    ${e.body ? `<div class="detail-body">${esc(e.body)}</div>` : ''}
  `;
  if (e.files && e.files.length) {
    const fl = document.createElement('div');
    fl.className = 'file-list';
    e.files.forEach((f) => {
      const chip = document.createElement('div');
      chip.className = 'file-chip';
      chip.innerHTML = `<span>${fileIcon(f.name)}</span><span class="f-name">${esc(f.name)}</span><span class="f-size">${fmtSize(f.size)}</span>`;
      chip.onclick = () => openAttachment(f);
      fl.appendChild(chip);
    });
    el.appendChild(fl);
  }
  if (e.photos && e.photos.length) {
    const grid = document.createElement('div');
    grid.className = 'detail-photos';
    e.photos.forEach((p) => {
      const img = document.createElement('img');
      img.dataset.path = p;
      img.src = photoUrl(p);
      img.onclick = () => openLightbox(p, e);
      grid.appendChild(img);
    });
    el.appendChild(grid);
  }
  $('entrySheet').classList.remove('hidden');
}

async function openAttachment(f) {
  if (/\.(xlsx|xls|csv)$/i.test(f.name)) {
    // inline spreadsheet viewer
    try {
      toast('Opening spreadsheet…');
      const [XLSX, blob] = await Promise.all([loadXLSX(),
        cfg.token ? api.readBlob(f.path) : fetch(rawUrl(f.path)).then((r) => r.blob())]);
      const wb = XLSX.read(await blob.arrayBuffer(), { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      const table = document.createElement('table');
      table.className = 'data-table';
      table.innerHTML = rows.slice(0, 500).map((r, i) =>
        `<tr>${r.map((c) => i === 0 ? `<th>${esc(String(c))}</th>` : `<td>${esc(String(c))}</td>`).join('')}</tr>`).join('');
      $('sheetViewerTitle').textContent = f.name;
      $('sheetViewerBody').innerHTML = '';
      $('sheetViewerBody').appendChild(table);
      const dl = $('sheetViewerDownload');
      dl.href = URL.createObjectURL(blob);
      dl.download = f.name;
      $('sheetViewer').classList.remove('hidden');
    } catch (e) { toast(e.message, true); }
  } else {
    downloadFile(f.path, f.name);
  }
}

async function downloadFile(path, name) {
  try {
    const blob = cfg.token ? await api.readBlob(path) : await fetch(rawUrl(path)).then((r) => r.blob());
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) { toast('Download failed: ' + e.message, true); }
}

function startEditEntry() {
  const e = state.openEntry;
  if (!e || !requireToken()) return;
  state.editingId = e.id;
  state.composeType = e.type || 'log';
  state.composePhotos = [];
  state.composeFiles = [];
  state.keepPhotos = [...(e.photos || [])];
  state.keepFiles = [...(e.files || [])];
  $('entrySheet').classList.add('hidden');
  openCompose(true);
  $('composeTitle').value = e.title || '';
  $('composeBody').value = e.body || '';
  $('composeProject').value = e.project;
  renderComposePhotos();
  renderComposeFiles();
}

async function deleteEntry() {
  const e = state.openEntry;
  if (!e || !requireToken()) return;
  if (!confirm(`Delete “${e.title || 'this entry'}”? Photos and files go too.\n(Everything stays in git history if you ever need it back.)`)) return;
  $('entrySheet').classList.add('hidden');
  toast('Deleting…');
  try {
    await api.updateJson('data/index.json',
      (cur) => (Array.isArray(cur) ? cur : []).filter((x) => x.id !== e.id),
      `delete: ${e.title || e.id}`);
    // best-effort cleanup of files (index is already updated)
    const paths = [`data/entries/${e.id}.md`, ...(e.photos || []), ...(e.files || []).map((f) => f.path)];
    for (const p of paths) { try { await api.remove(p, `delete: ${e.id}`); } catch {} }
    state.entries = state.entries.filter((x) => x.id !== e.id);
    render();
    toast('Deleted ✓');
  } catch (err) { toast(err.message, true); }
}

function openLightbox(path, entry) {
  const img = $('lightboxImg');
  img.dataset.path = path;
  img.src = photoUrl(path);
  $('lightboxCaption').textContent =
    `${entry.title || projName(entry.project)} — ${entry.author || ''}, ${new Date(entry.date).toLocaleDateString()}`;
  $('lightbox').classList.remove('hidden');
}

/* ----- compose ----- */

function openCompose(isEdit = false) {
  if (!cfg.repo) { openSettings(true); return; }
  if (!cfg.token) { toast('Add a GitHub token in Settings to post', true); openSettings(); return; }
  if (!isEdit) {
    state.editingId = null;
    state.keepPhotos = [];
    state.keepFiles = [];
    resetCompose();
  }
  const sel = $('composeProject');
  sel.innerHTML = state.projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  const last = localStorage.getItem('bh_last_project');
  if (!isEdit && last && state.projects.some((p) => p.id === last)) sel.value = last;
  $('composeAuthor').textContent = cfg.name ? `Posting as ${cfg.name}` : 'Set your name in Settings';
  $('composeStatus').textContent = '';
  $('composePost').textContent = state.editingId ? 'Save' : 'Post';
  $('compose').classList.remove('hidden');
  setComposeType(state.composeType);
}

function setComposeType(type) {
  state.composeType = type;
  document.querySelectorAll('#entryTypeSeg .seg-btn')
    .forEach((b) => b.classList.toggle('active', b.dataset.type === type));
  $('composeBody').placeholder =
    type === 'journal' ? 'What did you work on this week? Wins, blockers, what the next person should know…'
    : type === 'meeting' ? 'Attendees, decisions made, action items…'
    : 'What did you do? What worked, what didn’t, what’s next?\n\nTwo sentences beats zero.';
  $('composeTitle').placeholder =
    type === 'meeting' ? `Meeting ${today()}` : 'Title (optional — e.g. ‘Igniter test #3’)';
}

function resetCompose() {
  $('composeTitle').value = '';
  $('composeBody').value = '';
  $('photoInput').value = '';
  $('fileInput').value = '';
  state.composePhotos = [];
  state.composeFiles = [];
  renderComposePhotos();
  renderComposeFiles();
}

function renderComposePhotos() {
  const row = $('composePhotos');
  row.querySelectorAll('.photo-thumb').forEach((n) => n.remove());
  // existing photos (edit mode)
  state.keepPhotos.forEach((path, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'photo-thumb';
    const img = document.createElement('img');
    img.dataset.path = path;
    img.src = photoUrl(path);
    wrap.appendChild(img);
    const x = document.createElement('button');
    x.innerHTML = '&times;';
    x.onclick = () => { state.keepPhotos.splice(i, 1); renderComposePhotos(); };
    wrap.appendChild(x);
    row.appendChild(wrap);
  });
  // new photos
  state.composePhotos.forEach((p, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'photo-thumb';
    wrap.innerHTML = `<img src="${p.dataUrl}" alt=""><button aria-label="Remove">&times;</button>`;
    wrap.querySelector('button').onclick = () => { state.composePhotos.splice(i, 1); renderComposePhotos(); };
    row.appendChild(wrap);
  });
}

function renderComposeFiles() {
  const list = $('composeFiles');
  list.innerHTML = '';
  state.keepFiles.forEach((f, i) => {
    const chip = document.createElement('div');
    chip.className = 'file-chip';
    chip.innerHTML = `<span>${fileIcon(f.name)}</span><span class="f-name">${esc(f.name)}</span><span class="f-size">${fmtSize(f.size)}</span><button>&times;</button>`;
    chip.querySelector('button').onclick = () => { state.keepFiles.splice(i, 1); renderComposeFiles(); };
    list.appendChild(chip);
  });
  state.composeFiles.forEach((f, i) => {
    const chip = document.createElement('div');
    chip.className = 'file-chip';
    chip.innerHTML = `<span>${fileIcon(f.name)}</span><span class="f-name">${esc(f.name)}</span><span class="f-size">${fmtSize(f.size)}</span><button>&times;</button>`;
    chip.querySelector('button').onclick = () => { state.composeFiles.splice(i, 1); renderComposeFiles(); };
    list.appendChild(chip);
  });
}

async function compressImage(file) {
  const dataUrl = await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = dataUrl;
  });
  const MAX = 1600;
  const scale = Math.min(1, MAX / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.8));
  return { blob, dataUrl: canvas.toDataURL('image/jpeg', 0.5) };
}

async function post() {
  const body = $('composeBody').value.trim();
  const title = $('composeTitle').value.trim();
  if (!body && !state.composePhotos.length && !state.keepPhotos.length && !state.composeFiles.length) {
    toast('Add a note, photo, or file first', true); return;
  }

  const btn = $('composePost');
  btn.disabled = true;
  const status = $('composeStatus');
  const project = $('composeProject').value;
  localStorage.setItem('bh_last_project', project);

  const isEdit = !!state.editingId;
  const now = new Date();
  const id = isEdit ? state.editingId : `${now.toISOString().slice(0, 10)}-${now.getTime().toString(36)}`;
  const existing = isEdit ? state.entries.find((x) => x.id === id) : null;

  const entry = {
    id,
    type: state.composeType,
    project,
    title: title || (state.composeType === 'meeting' ? `Meeting ${now.toISOString().slice(0, 10)}` : ''),
    body,
    author: existing ? existing.author : (cfg.name || 'Unknown'),
    date: existing ? existing.date : now.toISOString(),
    photos: [...state.keepPhotos],
    files: [...state.keepFiles],
  };
  if (isEdit) { entry.edited = now.toISOString(); entry.editedBy = cfg.name || 'Unknown'; }

  try {
    let n = (entry.photos.length || 0);
    for (let i = 0; i < state.composePhotos.length; i++) {
      status.textContent = `Uploading photo ${i + 1}/${state.composePhotos.length}…`;
      const path = `data/photos/${id}/${++n}-${now.getTime().toString(36)}.jpg`;
      await api.write(path, state.composePhotos[i].blob, `photo: ${entry.title || id}`);
      entry.photos.push(path);
    }
    for (let i = 0; i < state.composeFiles.length; i++) {
      const f = state.composeFiles[i];
      status.textContent = `Uploading ${f.name}…`;
      const path = `data/files/${id}/${sanitizeName(f.name)}`;
      await api.write(path, f.file, `file: ${f.name}`);
      entry.files.push({ path, name: f.name, size: f.size });
    }

    status.textContent = 'Saving entry…';
    const md = [
      '---',
      `title: ${JSON.stringify(entry.title || id)}`,
      `project: ${project}`,
      `author: ${JSON.stringify(entry.author)}`,
      `date: ${entry.date}`,
      `type: ${entry.type}`,
      '---',
      '',
      body,
      '',
      ...entry.photos.map((p) => `![photo](/${p})`),
      ...entry.files.map((f) => `[${f.name}](/${f.path})`),
    ].join('\n');
    const mdSha = isEdit ? await api.sha(`data/entries/${id}.md`) : null;
    await api.write(`data/entries/${id}.md`, md, `${isEdit ? 'edit' : 'entry'}: ${entry.title || id} (${cfg.name || '?'})`, mdSha);

    status.textContent = 'Updating index…';
    await api.updateJson('data/index.json',
      (cur) => {
        const list = Array.isArray(cur) ? cur : [];
        if (isEdit) return list.map((x) => (x.id === id ? entry : x));
        return [entry, ...list];
      }, `index: ${entry.title || id}`);

    if (isEdit) state.entries = state.entries.map((x) => (x.id === id ? entry : x));
    else state.entries.unshift(entry);
    state.editingId = null;
    $('compose').classList.add('hidden');
    resetCompose();
    render();
    toast(isEdit ? 'Saved ✓' : 'Posted ✓');
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    status.textContent = '';
  }
}

/* ----- search ----- */

function runSearch(q) {
  const el = $('searchResults');
  el.innerHTML = '';
  q = q.trim().toLowerCase();
  if (q.length < 2) { el.innerHTML = '<p class="settings-note">Type at least 2 characters…</p>'; return; }

  const hit = (s) => s && s.toLowerCase().includes(q);
  const group = (label) => {
    const h = document.createElement('div');
    h.className = 'result-group';
    h.textContent = label;
    el.appendChild(h);
  };
  const item = (title, sub, onclick) => {
    const d = document.createElement('div');
    d.className = 'result-item';
    d.innerHTML = `<div>${title}</div>${sub ? `<div class="r-sub">${sub}</div>` : ''}`;
    d.onclick = () => { $('searchOverlay').classList.add('hidden'); onclick(); };
    el.appendChild(d);
  };
  const mark = (s) => esc(s).replace(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'), '<mark>$1</mark>');
  let total = 0;

  const entries = state.entries.filter((e) => hit(e.title) || hit(e.body) || hit(e.author) || hit(projName(e.project)));
  if (entries.length) {
    group(`Entries (${entries.length})`);
    entries.slice(0, 15).forEach((e) => {
      total++;
      const snippet = e.body && hit(e.body)
        ? '…' + e.body.substring(Math.max(0, e.body.toLowerCase().indexOf(q) - 30), e.body.toLowerCase().indexOf(q) + 50) + '…' : '';
      item(mark(e.title || '(untitled)'), `${esc(e.author || '')} · ${projName(e.project)} · ${new Date(e.date).toLocaleDateString()}${snippet ? ' — ' + mark(snippet) : ''}`, () => openEntry(e));
    });
  }

  const tasks = state.team.tasks.filter((t) => hit(t.title) || hit(t.notes) || (t.assignees || []).some((a) => hit(memberName(a))));
  if (tasks.length) {
    group(`Tasks (${tasks.length})`);
    tasks.slice(0, 10).forEach((t) => {
      total++;
      item(mark(t.title), `${(t.assignees || []).map(memberName).join(', ') || 'unassigned'}${t.due ? ' · due ' + t.due : ''}`, () => { switchView('home'); openTaskSheet(t.id); });
    });
  }

  const pos = state.pos.filter((p) => hit(p.name) || p.rows.some((r) => r.cells.some((c) => hit(c))));
  if (pos.length) {
    group(`Purchase Orders (${pos.length})`);
    pos.slice(0, 10).forEach((p) => {
      total++;
      item(mark(p.name), `${p.rows.filter((r) => r.arrived).length}/${p.rows.length} arrived`, () => { state.openPo = p.id; switchView('po'); renderPoDetail(); });
    });
  }

  const projs = state.projects.filter((p) => hit(p.name));
  if (projs.length) {
    group('Projects');
    projs.forEach((p) => {
      total++;
      item(mark(p.name), null, () => { state.openProject = p.id; switchView('project'); renderProjectDetail(); });
    });
  }

  if (!total) el.innerHTML = '<div class="empty"><p>No results.</p></div>';
}

/* ----- projects admin ----- */

async function addProject() {
  const name = prompt('Project name (e.g. "Avionics Bay"):');
  if (!name || !name.trim()) return;
  if (!requireToken()) return;
  const id = slug(name);
  try {
    await api.updateJson('data/projects.json',
      (cur) => {
        const list = Array.isArray(cur) && cur.length ? cur : state.projects;
        if (list.some((p) => p.id === id)) return list;
        return [...list, { id, name: name.trim() }];
      }, `project: add ${name.trim()}`);
    await loadAll(false);
    toast('Project added ✓');
  } catch (e) { toast(e.message, true); }
}

/* ----- settings ----- */

function openSettings(firstRun = false) {
  $('setName').value = cfg.name;
  $('setRepo').value = cfg.repo;
  $('setBranch').value = cfg.branch;
  $('setToken').value = cfg.token;
  $('connTest').textContent = firstRun ? 'Welcome! Point the app at your club’s GitHub repo to get started.' : '';
  $('settings').classList.remove('hidden');
}

async function saveSettings() {
  cfg.set('name', $('setName').value);
  cfg.set('repo', $('setRepo').value.replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, ''));
  cfg.set('branch', $('setBranch').value || 'main');
  cfg.set('token', $('setToken').value);
  $('settings').classList.add('hidden');
  state.blobCache.clear();
  loadAll();
}

async function testConnection() {
  const el = $('connTest');
  el.textContent = 'Testing…';
  const repo = $('setRepo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '');
  const token = $('setToken').value.trim();
  try {
    const h = { Accept: 'application/vnd.github+json' };
    if (token) h.Authorization = `Bearer ${token}`;
    const r = await fetch(`https://api.github.com/repos/${repo}`, { headers: h });
    if (!r.ok) throw new Error(r.status === 404 ? 'Repo not found (check name / token scope)' : `HTTP ${r.status}`);
    const info = await r.json();
    el.textContent = `✓ Connected to ${info.full_name}${info.permissions && info.permissions.push ? ' (can post)' : token ? ' (token can’t write!)' : ' (read-only, add token to post)'}`;
  } catch (e) {
    el.textContent = `✗ ${e.message}`;
  }
}

/* ----- navigation & helpers ----- */

const VIEWS = ['home', 'feed', 'photos', 'projects', 'project', 'meetings', 'pos', 'po', 'roster'];

function switchView(v) {
  state.view = v;
  VIEWS.forEach((name) => $('view-' + name).classList.toggle('hidden', name !== v));
  document.querySelectorAll('.tabbar .tab[data-view]').forEach((t) => {
    t.classList.toggle('active', t.dataset.view === v);
  });
  $('tabMore').classList.toggle('active', ['projects', 'project', 'meetings', 'pos', 'po', 'roster'].includes(v));
  window.scrollTo(0, 0);
}

function requireToken() {
  if (!cfg.token) { toast('Add a GitHub token in Settings first', true); openSettings(); return false; }
  return true;
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function slug(s) { return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function sanitizeName(s) { return s.replace(/[^a-zA-Z0-9._-]+/g, '_'); }
function fmtSize(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function toast(msg, isErr = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add('hidden'), 3200);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ----- wiring ----- */

function wire() {
  document.querySelectorAll('.tabbar .tab[data-view]').forEach((t) => {
    t.onclick = () => switchView(t.dataset.view);
  });
  $('tabMore').onclick = () => $('moreSheet').classList.remove('hidden');
  $('moreClose').onclick = () => $('moreSheet').classList.add('hidden');
  document.querySelectorAll('.more-item[data-goto]').forEach((b) => {
    b.onclick = () => { $('moreSheet').classList.add('hidden'); switchView(b.dataset.goto); };
  });
  $('moreJournal').onclick = () => { $('moreSheet').classList.add('hidden'); state.composeType = 'journal'; openCompose(); };
  $('brandHome').onclick = () => switchView('home');
  $('btnNew').onclick = () => { state.composeType = 'log'; openCompose(); };
  $('btnNewMeeting').onclick = () => { state.composeType = 'meeting'; openCompose(); };
  $('btnSync').onclick = () => loadAll();
  $('btnSettings').onclick = () => openSettings();
  $('btnAddProject').onclick = addProject;
  $('btnAddMember').onclick = addMember;
  $('btnAddGoal').onclick = addGoal;
  $('btnAddTask').onclick = () => openTaskSheet(null);
  $('btnToggleDone').onclick = () => { state.showDone = !state.showDone; renderHome(); };

  document.querySelectorAll('.back-btn').forEach((b) => {
    b.onclick = () => switchView(b.dataset.back);
  });

  // compose
  $('composeCancel').onclick = () => { state.editingId = null; $('compose').classList.add('hidden'); };
  $('composePost').onclick = post;
  document.querySelectorAll('#entryTypeSeg .seg-btn').forEach((b) => {
    b.onclick = () => setComposeType(b.dataset.type);
  });
  $('photoInput').onchange = async (ev) => {
    for (const f of [...ev.target.files]) {
      try { state.composePhotos.push(await compressImage(f)); }
      catch { toast('Couldn’t read a photo', true); }
    }
    renderComposePhotos();
    ev.target.value = '';
  };
  $('fileInput').onchange = (ev) => {
    for (const f of [...ev.target.files]) {
      if (f.size > 8 * 1048576) { toast(`${f.name} is over 8 MB — too big for the repo`, true); continue; }
      state.composeFiles.push({ file: f, name: f.name, size: f.size });
    }
    renderComposeFiles();
    ev.target.value = '';
  };

  // entry detail
  $('entryClose').onclick = () => $('entrySheet').classList.add('hidden');
  $('entryEdit').onclick = startEditEntry;
  $('entryDelete').onclick = deleteEntry;

  // tasks
  $('taskCancel').onclick = () => $('taskSheet').classList.add('hidden');
  $('taskSave').onclick = saveTask;
  $('taskDelete').onclick = deleteTask;

  // PO import
  $('poFileInput').onchange = (ev) => {
    if (ev.target.files[0]) importPoFile(ev.target.files[0]);
    ev.target.value = '';
  };

  // search
  $('btnSearch').onclick = () => {
    $('searchOverlay').classList.remove('hidden');
    $('searchInput').value = '';
    $('searchResults').innerHTML = '';
    setTimeout(() => $('searchInput').focus(), 50);
  };
  $('searchClose').onclick = () => $('searchOverlay').classList.add('hidden');
  $('searchInput').oninput = (ev) => runSearch(ev.target.value);

  // misc sheets
  $('settingsCancel').onclick = () => $('settings').classList.add('hidden');
  $('settingsSave').onclick = saveSettings;
  $('btnTestConn').onclick = testConnection;
  $('lightboxClose').onclick = () => $('lightbox').classList.add('hidden');
  $('lightbox').onclick = (e) => { if (e.target === $('lightbox')) $('lightbox').classList.add('hidden'); };
  $('sheetViewerClose').onclick = () => $('sheetViewer').classList.add('hidden');
  $('whoSkip').onclick = () => { localStorage.setItem('bh_who_skipped', '1'); $('whoSheet').classList.add('hidden'); };

  ['compose', 'entrySheet', 'settings', 'moreSheet', 'taskSheet', 'searchOverlay', 'sheetViewer'].forEach((id) => {
    $(id).addEventListener('click', (e) => { if (e.target === $(id)) $(id).classList.add('hidden'); });
  });
}

/* ----- boot ----- */

window.addEventListener('load', () => {
  wire();
  state.projects = DEFAULT_PROJECTS;
  render();
  loadAll();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
});
