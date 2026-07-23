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

/* Club defaults — new devices work out of the box; Settings can still override. */
const DEFAULT_REPO = 'USAFA-Blue-Horizon/BlueHorizon-Log';
const DEFAULT_PORTAL = 'https://bluehorizon-portal.stecgrant89.workers.dev';

const cfg = {
  get name()    { return localStorage.getItem('bh_name')    || ''; },
  get rid()     { return localStorage.getItem('bh_rid')     || ''; },
  get repo()    { return localStorage.getItem('bh_repo')    || DEFAULT_REPO; },
  get branch()  { return localStorage.getItem('bh_branch')  || 'main'; },
  get token()   { return localStorage.getItem('bh_token')   || ''; },
  get portal()  { return (localStorage.getItem('bh_portal') ?? DEFAULT_PORTAL).replace(/\/+$/, ''); },
  get session() { return localStorage.getItem('bh_session') || ''; },
  get role()    { return localStorage.getItem('bh_role')    || ''; },
  set(k, v)     { localStorage.setItem('bh_' + k, String(v).trim()); },
  del(k)        { localStorage.removeItem('bh_' + k); },
  get portalMode() { return !!this.portal; },
  get signedIn()   { return this.portalMode && !!this.session; },
  get canWrite()   { return this.portalMode ? (this.signedIn && this.role !== 'pending') : !!this.token; },
};

const state = {
  entries: [],
  projects: [],
  roster: [],
  team: { goals: [], tasks: [] },
  pos: [],
  resources: [],
  obStep: 0,
  invited: false,
  pendingResource: null,
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
  base() {
    return cfg.portalMode ? `${cfg.portal}/api/gh` : `https://api.github.com/repos/${cfg.repo}`;
  },

  headers(extra = {}) {
    const h = { Accept: 'application/vnd.github+json', ...extra };
    if (cfg.portalMode) { if (cfg.session) h.Authorization = `Bearer ${cfg.session}`; }
    else if (cfg.token) h.Authorization = `Bearer ${cfg.token}`;
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
    const [projects, entries, roster, team, pos, resources] = await Promise.all([
      api.readJson('data/projects.json', DEFAULT_PROJECTS),
      api.readJson('data/index.json', []),
      api.readJson('data/roster.json', []),
      api.readJson('data/team.json', { goals: [], tasks: [] }),
      api.readJson('data/pos.json', []),
      api.readJson('data/resources.json', []),
    ]);
    state.projects = projects;
    state.entries = entries;
    state.roster = roster;
    state.team = { goals: team.goals || [], tasks: team.tasks || [] };
    state.pos = pos;
    state.resources = resources;
    render();
    maybeAskWho();
  } catch (e) {
    toast(`Couldn’t load: ${e.message}`, true);
  } finally {
    btn.classList.remove('spin');
  }
}

function maybeAskWho() {
  // account mode: identity comes from the account — never nag with pickers
  if (cfg.portalMode) {
    if (cfg.signedIn && !cfg.rid) linkRosterIdentity();
    return;
  }
  // brand-new members (or invite-link arrivals) get the full onboarding wizard
  if (state.roster.length && !cfg.rid && !localStorage.getItem('bh_onboarded') && !localStorage.getItem('bh_who_skipped')) {
    openOnboarding();
    return;
  }
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
  renderTopbarAvatar();
  renderHome();
  renderResources();
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
    <div class="card-meta">${badge}<span>${esc(e.author || 'Unknown')}</span><span>·</span><span>${when}</span>${nFiles ? `<span>· 📎 ${nFiles}</span>` : ''}${e.video ? '<span>· 🎥</span>' : ''}</div>
    ${e.title ? `<div class="card-title">${esc(e.title)}</div>` : ''}
    ${e.body ? `<div class="card-body${clamp ? ' clamp' : ''}">${esc(e.body)}</div>` : ''}
  `;
  card.querySelector('.card-meta').prepend(avatarNode(e.authorRid || e.author));

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
    div.innerHTML = `<span class="project-name" style="display:flex;align-items:center;gap:9px">${esc(m.name)}${m.id === cfg.rid ? ' <span class="badge">you</span>' : ''}</span>
      <span class="project-count">${n} open task${n === 1 ? '' : 's'}</span>`;
    div.querySelector('.project-name').prepend(avatarNode(m.id));
    div.onclick = () => {
      const action = confirm(`Remove ${m.name} from the roster?\n(OK = remove, Cancel = keep)`);
      if (action) removeMember(m.id);
    };
    list.appendChild(div);
  });
  if (!state.roster.length) list.innerHTML = '<p class="settings-note">No members yet. Add the team so tasks can be assigned and everyone can pick their name.</p>';
  renderUserAdmin();
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
    const div = document.createElement('div');
    div.className = 'project-card';
    if (po.kind === 'draft') {
      const total = poDraftTotal(po);
      div.innerHTML = `<div><div class="project-name">🛠 ${esc(po.name)}</div>
          <div class="project-count">draft · started ${new Date(po.created).toLocaleDateString()} by ${esc(po.by || '?')}</div></div>
        <span class="project-count">${po.items.length} item${po.items.length === 1 ? '' : 's'} · $${total.grand.toFixed(2)} ›</span>`;
      div.onclick = () => openPob(po.id);
    } else {
      const arrived = po.rows.filter((r) => r.arrived).length;
      div.innerHTML = `<div><div class="project-name">${esc(po.name)}</div>
          <div class="project-count">${new Date(po.uploaded).toLocaleDateString()} · ${esc(po.by || '')}</div></div>
        <span class="project-count">${arrived}/${po.rows.length} arrived ›</span>`;
      div.onclick = () => { state.openPo = po.id; switchView('po'); renderPoDetail(); };
    }
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

/* ----- PO builder (create POs from product links) ----- */

const VENDOR_MAP = {
  amazon: 'Amazon', mcmaster: 'McMaster', digikey: 'DigiKey', oshpark: 'OSH Park',
  sparkfun: 'SparkFun', adafruit: 'Adafruit', grainger: 'Grainger', mouser: 'Mouser',
  homedepot: 'Home Depot', lowes: 'Lowe’s', onlinemetals: 'Online Metals',
  sendcutsend: 'SendCutSend', aliexpress: 'AliExpress', ebay: 'eBay',
};

/* Cross-origin fetch strategy:
   1. public CORS proxies (fast, but blocked on some campus networks)
   2. relay through our own GitHub Actions (slower ~30s, always works)   */
const PROXIES = [
  (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
  (u) => 'https://corsproxy.io/?url=' + encodeURIComponent(u),
  (u) => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u),
];

async function proxyFetchText(target) {
  // own Worker first — immune to campus filtering
  if (cfg.signedIn) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch(`${cfg.portal}/api/fetch?url=${encodeURIComponent(target)}`,
        { headers: { Authorization: `Bearer ${cfg.session}` }, signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) {
        const text = await r.text();
        if (text && text.length > 50) return text;
      }
    } catch { /* fall through */ }
  }
  for (const p of PROXIES) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(p(target), { signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) {
        const text = await r.text();
        if (text && text.length > 50) return text;
      }
    } catch { /* try next proxy */ }
  }
  return null;
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/* Relay a lookup through GitHub Actions: commit a request file, poll for the answer. */
async function relayLookup(kind, query, onStatus) {
  if (!cfg.token) throw new Error('needs a GitHub token (Settings)');
  const id = uid();
  onStatus('Direct fetch blocked — relaying via GitHub…');
  await api.write(`data/lookups/requests/${id}.json`,
    JSON.stringify({ kind, query, by: cfg.name || '?', at: new Date().toISOString() }),
    `lookup: ${kind} ${String(query).slice(0, 40)}`);
  for (let i = 1; i <= 24; i++) {
    await sleep(5000);
    onStatus(`Relaying via GitHub Actions… ${i * 5}s (usually ~30s)`);
    const res = await api.readJson(`data/lookups/responses/${id}.json`, null);
    if (res) {
      api.remove(`data/lookups/responses/${id}.json`, 'lookup: cleanup').catch(() => {});
      if (!res.ok) throw new Error(res.error || 'lookup failed');
      return res.data;
    }
  }
  throw new Error('Relay timed out — check the repo’s Actions tab');
}

function vendorFromUrl(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '').split('.')[0];
    return VENDOR_MAP[h.toLowerCase()] || h.charAt(0).toUpperCase() + h.slice(1);
  } catch { return ''; }
}

function decodeEntities(s) {
  const el = document.createElement('textarea');
  el.innerHTML = s;
  return el.value;
}

function currentPob() { return state.pos.find((p) => p.id === state.openPob); }

function poDraftTotal(po) {
  const items = po.items.reduce((n, i) => n + (i.unitCost || 0) * (i.qty || 1), 0);
  const ship = Object.values(po.vendors || {}).reduce((n, v) => n + (parseFloat(v.shipping) || 0), 0);
  return { items, ship, grand: items + ship };
}

async function newDraftPo() {
  if (!requireToken()) return;
  const name = prompt('Name this purchase order:', `Order ${today()}`);
  if (!name || !name.trim()) return;
  const po = { id: uid(), kind: 'draft', name: name.trim(), created: new Date().toISOString(), by: cfg.name || 'Unknown', items: [], vendors: {} };
  state.pos.unshift(po);
  renderPos();
  openPob(po.id);
  try { await savePos(`po: new draft ${po.name}`); } catch (e) { toast(e.message, true); }
}

function openPob(id) {
  state.openPob = id;
  switchView('pob');
  renderPob();
}

function renderPob() {
  const po = currentPob();
  if (!po) { switchView('pos'); return; }
  $('pobTitle').textContent = po.name;
  $('pobMeta').textContent = `Started ${new Date(po.created).toLocaleDateString()} by ${po.by || '?'} · draft`;

  // items
  const wrap = $('pobItems');
  wrap.innerHTML = '';
  if (!po.items.length) wrap.innerHTML = '<p class="settings-note">No items yet — paste a product link to get started.</p>';
  po.items.forEach((it) => {
    const card = document.createElement('div');
    card.className = 'poi-card';
    const line = (it.unitCost || 0) * (it.qty || 1);
    card.innerHTML = `
      <div class="poi-top"><span class="poi-name">${esc(it.name)}</span>
        <span class="poi-price">$${line.toFixed(2)}</span></div>
      <div class="poi-meta">
        <span class="badge">${esc(it.vendor)}</span>
        <span>$${(it.unitCost || 0).toFixed(2)} × ${it.qty}</span>
        ${it.qtyDesc ? `<span>(${esc(it.qtyDesc)})</span>` : ''}
        ${it.team ? `<span>· ${esc(projName(it.team))}</span>` : ''}
        <span>· ${esc(it.addedBy || '?')}</span>
      </div>
      ${it.justification ? `<div class="poi-just">“${esc(it.justification)}”</div>` : ''}
      <div class="poi-actions">
        ${it.url ? '<button class="open">Open link</button>' : ''}
        <button class="edit">Edit</button>
        <button class="del">Remove</button>
      </div>`;
    const open = card.querySelector('.open');
    if (open) open.onclick = () => window.open(it.url, '_blank', 'noopener');
    card.querySelector('.edit').onclick = () => openPoItemSheet(it.id);
    card.querySelector('.del').onclick = async () => {
      if (!confirm(`Remove “${it.name}”?`)) return;
      po.items = po.items.filter((x) => x.id !== it.id);
      pruneVendors(po);
      renderPob();
      try { await savePos(`po: remove item from ${po.name}`); } catch (e) { toast(e.message, true); }
    };
    wrap.appendChild(card);
  });

  // vendors
  const vw = $('pobVendors');
  vw.innerHTML = '';
  const vendors = [...new Set(po.items.map((i) => i.vendor))];
  if (!vendors.length) vw.innerHTML = '<p class="settings-note">Vendors appear here as you add items — set estimated shipping and run the 889 compliance check per vendor.</p>';
  vendors.forEach((v) => {
    po.vendors[v] = po.vendors[v] || { shipping: 0 };
    const info = po.vendors[v];
    const card = document.createElement('div');
    card.className = 'vendor-card';
    const s = info.s889;
    const chip = s
      ? `<span class="s889 ${s.status === 'COMPLIANT' ? 'ok' : (/NON/.test(s.status) ? 'bad' : 'unk')}">${esc(s.status)}</span>`
      : '<span class="s889 unk">889 NOT CHECKED</span>';
    card.innerHTML = `
      <div class="vendor-head">
        <span class="vendor-name">${esc(v)}</span>
        <span style="display:flex;gap:7px;align-items:center">${chip}
          <button class="mini-btn check">Check 889</button></span>
      </div>
      ${s ? `<div class="poi-meta" style="margin-top:5px"><span>Matched: ${esc(s.legalName)} · checked by ${esc(s.by)} ${new Date(s.date).toLocaleDateString()}</span></div>` : ''}
      <div class="vendor-ship">Est. shipping $
        <input class="input ship" type="number" min="0" step="0.01" value="${info.shipping || 0}">
        <a href="https://889.smartpay.gsa.gov/#/" target="_blank" rel="noopener" style="color:var(--accent);margin-left:auto;font-size:12.5px">open GSA tool ↗</a>
      </div>
      <div class="s889-results hidden"></div>`;
    card.querySelector('.check').onclick = () => check889(po, v, card);
    card.querySelector('.ship').onchange = async (ev) => {
      info.shipping = parseFloat(ev.target.value) || 0;
      renderPobTotals(po);
      try { await savePos(`po: shipping ${v} ${po.name}`); } catch (e) { toast(e.message, true); }
    };
    vw.appendChild(card);
  });

  renderPobTotals(po);
}

function pruneVendors(po) {
  const used = new Set(po.items.map((i) => i.vendor));
  Object.keys(po.vendors || {}).forEach((v) => { if (!used.has(v)) delete po.vendors[v]; });
}

function renderPobTotals(po) {
  const t = poDraftTotal(po);
  $('pobTotals').innerHTML = `Items <b>$${t.items.toFixed(2)}</b> + shipping <b>$${t.ship.toFixed(2)}</b> = <b style="color:var(--accent)">$${t.grand.toFixed(2)}</b> total · ${po.items.length} items`;
}

/* 889 compliance lookup via the GSA SmartPay tool's public API */
async function check889(po, vendor, card) {
  const box = card.querySelector('.s889-results');
  box.classList.remove('hidden');
  const status = (msg) => { box.innerHTML = `<p class="settings-note">${esc(msg)}</p>`; };
  status('Searching SAM.gov via GSA 889 tool…');
  try {
    let j = null;
    if (cfg.signedIn) { // own Worker's dedicated 889 endpoint
      try {
        const r = await fetch(`${cfg.portal}/api/889?q=${encodeURIComponent(vendor)}`,
          { headers: { Authorization: `Bearer ${cfg.session}` } });
        if (r.ok) j = await r.json();
      } catch { /* fall through */ }
    }
    const target = `https://889.smartpay.gsa.gov/api/entity-information/v3/entities?samToolsSearch=${encodeURIComponent(vendor)}&page=0`;
    if (!j) {
      const direct = await proxyFetchText(target);
      if (direct) { try { j = JSON.parse(direct); } catch {} }
    }
    if (!j) j = await relayLookup('889', vendor, status);
    const ents = (j.entityData || []).slice(0, 6);
    if (!ents.length) {
      box.innerHTML = '<p class="settings-note">No SAM.gov match found — verify manually in the GSA tool, then note it.</p>';
      return;
    }
    box.innerHTML = '<p class="settings-note">Pick the matching legal entity:</p>';
    ents.forEach((e) => {
      const name = e.entityRegistration?.legalBusinessName || '?';
      const st = e.samToolsData?.eightEightNine?.statusText || 'UNKNOWN';
      const b = document.createElement('button');
      b.innerHTML = `${esc(name)} — <b>${esc(st)}</b>`;
      b.onclick = async () => {
        po.vendors[vendor].s889 = { status: st, legalName: name, by: cfg.name || '?', date: new Date().toISOString() };
        renderPob();
        try { await savePos(`po: 889 ${vendor} ${st}`); } catch (err) { toast(err.message, true); }
      };
      box.appendChild(b);
    });
  } catch (e) {
    box.innerHTML = `<p class="settings-note">Lookup failed (${esc(e.message)}) — use the GSA tool link above and verify manually.</p>`;
  }
}

/* ----- PO item sheet ----- */

function openPoItemSheet(itemId = null) {
  const po = currentPob();
  if (!po) return;
  state.editingPoItem = itemId;
  const it = itemId ? po.items.find((x) => x.id === itemId) : null;
  $('poItemTitle').textContent = it ? 'Edit Item' : 'Add Item';
  $('poItemSave').textContent = it ? 'Save' : 'Add';
  $('piUrl').value = it ? (it.url || '') : '';
  $('piName').value = it ? it.name : '';
  $('piVendor').value = it ? it.vendor : '';
  $('piCost').value = it ? it.unitCost : '';
  $('piQty').value = it ? it.qty : 1;
  $('piQtyDesc').value = it ? (it.qtyDesc || '') : '';
  $('piJust').value = it ? (it.justification || '') : '';
  $('piNotes').value = it ? (it.notes || '') : '';
  $('piTeam').innerHTML = state.projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  if (it && it.team) $('piTeam').value = it.team;
  document.querySelectorAll('#piDeliverySeg .seg-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.del === ((it && it.delivery) || 'Delivery')));
  $('piAutofillNote').textContent = '';
  $('poItemSheet').classList.remove('hidden');
}

async function autofillFromLink() {
  const url = $('piUrl').value.trim();
  if (!url) { toast('Paste a product link first', true); return; }
  const note = $('piAutofillNote');
  const status = (msg) => { note.textContent = msg; };
  if (!$('piVendor').value) $('piVendor').value = vendorFromUrl(url);
  // McMaster blocks ALL automated reads (bots, proxies, even server-side) —
  // extract the part number from the URL instead of erroring out.
  if (/mcmaster\.com/i.test(url)) {
    const pm = url.match(/mcmaster\.com\/([A-Za-z0-9-]+)/);
    if (pm && !$('piName').value) $('piName').value = `McMaster ${pm[1]}`;
    status('McMaster blocks all robots — part number filled from the link; copy the price and full name from their page.');
    return;
  }
  status('Fetching product page…');
  try {
    let info = null;
    const html = await proxyFetchText(url);
    if (html && html.length > 500) {
      info = {};
      const tm = html.match(/<meta[^>]*(?:og:title|twitter:title)[^>]*content=["']([^"']+)/i) || html.match(/<title[^>]*>([^<]+)</i);
      if (tm) info.title = decodeEntities(tm[1]).replace(/\s*[|–-]\s*(Amazon|McMaster|DigiKey|eBay).*$/i, '').trim().slice(0, 100);
      const pm = html.match(/og:price:amount["'][^>]*content=["']([\d.,]+)/i) ||
                 html.match(/"price"\s*:\s*"?\$?([\d,]+\.?\d{0,2})"?/i) ||
                 html.match(/\$\s?([\d,]+\.\d{2})/);
      if (pm) info.price = parseFloat(pm[1].replace(/,/g, ''));
    }
    if (!info || (!info.title && !info.price)) {
      info = await relayLookup('product', url, status);
    }
    if (info.title && !$('piName').value) $('piName').value = info.title;
    if (info.price != null && !$('piCost').value) $('piCost').value = info.price;
    const qm = ($('piName').value || '').match(/(?:pack|box|bag|set) of (\d+)|(\d+)\s?[- ]?(?:pack|pcs|pieces|count|ct)\b/i);
    if (qm && !$('piQtyDesc').value) $('piQtyDesc').value = `pack of ${qm[1] || qm[2]}`;
    else if (info.qtyDesc && !$('piQtyDesc').value) $('piQtyDesc').value = info.qtyDesc;
    status(($('piName').value || $('piCost').value)
      ? '✓ Got what I could — double-check name and price, then fill in the rest.'
      : 'This vendor blocks robots entirely — fill the fields in manually.');
  } catch (e) {
    status(`Couldn’t auto-read (${e.message}) — big vendors like Amazon block robots. Fill in manually.`);
  }
}

async function savePoItem() {
  const po = currentPob();
  if (!po) return;
  const name = $('piName').value.trim();
  const vendor = $('piVendor').value.trim();
  const cost = parseFloat($('piCost').value);
  const just = $('piJust').value.trim();
  if (!name || !vendor || !(cost >= 0) || !just) { toast('Need: name, vendor, unit cost, and justification', true); return; }
  const data = {
    name, vendor,
    url: $('piUrl').value.trim() || undefined,
    unitCost: cost,
    qty: Math.max(1, parseInt($('piQty').value, 10) || 1),
    qtyDesc: $('piQtyDesc').value.trim() || undefined,
    team: $('piTeam').value,
    justification: just,
    delivery: document.querySelector('#piDeliverySeg .seg-btn.active').dataset.del,
    notes: $('piNotes').value.trim() || undefined,
  };
  if (state.editingPoItem) {
    Object.assign(po.items.find((x) => x.id === state.editingPoItem), data);
  } else {
    po.items.push({ id: uid(), addedBy: cfg.name || 'Unknown', addedRid: cfg.rid, added: new Date().toISOString(), ...data });
  }
  po.vendors[vendor] = po.vendors[vendor] || { shipping: 0 };
  pruneVendors(po);
  $('poItemSheet').classList.add('hidden');
  renderPob();
  renderPos();
  try { await savePos(`po: ${state.editingPoItem ? 'edit' : 'add'} ${name} (${po.name})`); toast('Saved ✓'); }
  catch (e) { toast(e.message, true); }
}

/* ----- PO Excel export (mirrors the team's purchasing-office format) ----- */

async function exportPoXlsx() {
  const po = currentPob();
  if (!po || !po.items.length) { toast('Add items first', true); return; }
  try {
    const XLSX = await loadXLSX();
    const header = ['889?', 'Part Name', 'Team/Project', 'Justification', 'Vendor', 'Unit Cost',
      'Quantity', 'Q. Descriptor', 'Shipping', 'Total Cost', 'Delivery/Pickup', 'Link', 'Requested By', 'Notes'];
    const rows = [header];
    const vendors = [...new Set(po.items.map((i) => i.vendor))];
    let grand = 0;
    vendors.forEach((v) => {
      rows.push(['', v, '', '', '', '', '', '', '', '', '', '', '', '']); // vendor section header
      const vinfo = po.vendors[v] || {};
      const s889 = vinfo.s889 ? (vinfo.s889.status === 'COMPLIANT' ? 'Yes' : (/NON/.test(vinfo.s889.status) ? 'NO' : '?')) : '';
      const ship = parseFloat(vinfo.shipping) || 0;
      po.items.filter((i) => i.vendor === v).forEach((i, idx) => {
        const line = (i.unitCost || 0) * (i.qty || 1);
        grand += line;
        rows.push([s889, i.name, projName(i.team || ''), i.justification || '', v,
          i.unitCost, i.qty, i.qtyDesc || '', idx === 0 ? ship : '', line,
          i.delivery || 'Delivery', i.url || '', i.addedBy || '', i.notes || '']);
      });
      grand += ship;
    });
    rows.push([]);
    rows.push(['', '', '', '', '', '', '', '', 'GRAND TOTAL', grand, '', '', '', '']);
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 5 }, { wch: 34 }, { wch: 18 }, { wch: 34 }, { wch: 14 }, { wch: 9 },
      { wch: 8 }, { wch: 16 }, { wch: 9 }, { wch: 10 }, { wch: 13 }, { wch: 40 }, { wch: 14 }, { wch: 18 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, po.name.slice(0, 30).replace(/[\\/?*[\]:]/g, ' '));
    XLSX.writeFile(wb, `${po.name.replace(/[^\w.-]+/g, '_')}.xlsx`);
    toast('Excel exported ✓');
  } catch (e) { toast(e.message, true); }
}

async function deleteDraftPo() {
  const po = currentPob();
  if (!po) return;
  if (!confirm(`Delete “${po.name}” and all its items?`)) return;
  state.pos = state.pos.filter((p) => p.id !== po.id);
  switchView('pos');
  renderPos();
  try { await savePos(`po: delete draft ${po.name}`); } catch (e) { toast(e.message, true); }
}

async function renamePob() {
  const po = currentPob();
  if (!po) return;
  const name = prompt('Rename purchase order:', po.name);
  if (!name || !name.trim()) return;
  po.name = name.trim();
  renderPob();
  renderPos();
  try { await savePos(`po: rename ${po.name}`); } catch (e) { toast(e.message, true); }
}

/* ----- avatars & profile ----- */

function initials(name) {
  return String(name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
}

/* Returns an <img> (if the member has an avatar) or a <span> with initials. */
function avatarNode(ridOrName, cls = 'avatar-sm') {
  const m = state.roster.find((x) => x.id === ridOrName) ||
            state.roster.find((x) => x.name === ridOrName);
  if (m && m.avatar) {
    const img = document.createElement('img');
    img.className = cls;
    img.alt = m.name;
    img.dataset.path = m.avatar;
    img.src = photoUrl(m.avatar);
    return img;
  }
  const el = document.createElement('span');
  el.className = cls;
  el.textContent = initials(m ? m.name : ridOrName);
  return el;
}

function renderTopbarAvatar() {
  const btn = $('btnProfile');
  btn.innerHTML = '';
  btn.appendChild(avatarNode(cfg.rid || cfg.name, 'avatar-sm'));
}

function openProfile() {
  if (!cfg.rid && !cfg.name) { openWhoPicker(); return; }
  const wrap = $('profileAvatar');
  wrap.innerHTML = '';
  const av = avatarNode(cfg.rid || cfg.name, 'avatar-big');
  av.style.pointerEvents = 'none';
  wrap.appendChild(av);
  $('profileName').textContent = cfg.name || memberName(cfg.rid);
  const mine = state.entries.filter((e) => (e.authorRid && e.authorRid === cfg.rid) || e.author === cfg.name);
  const openTasks = state.team.tasks.filter((t) => t.status !== 'done' && (t.assignees || []).includes(cfg.rid));
  const photos = mine.reduce((n, e) => n + (e.photos || []).length, 0);
  $('profileStats').textContent = `${mine.length} entries · ${photos} photos · ${openTasks.length} open tasks. Tap the picture to change it.` +
    (cfg.portalMode && cfg.signedIn ? ` Signed in (${cfg.role}).` : '');
  $('profileSwitch').textContent = cfg.portalMode && cfg.signedIn ? 'Sign out' : 'Switch person';
  const list = $('profileEntries');
  list.innerHTML = '';
  mine.slice(0, 5).forEach((e) => list.appendChild(entryCard(e)));
  $('profileSheet').classList.remove('hidden');
}

function openWhoPicker() {
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

async function uploadAvatar(file) {
  if (!requireToken()) return;
  if (!cfg.rid) { toast('Pick your name from the roster first', true); return; }
  try {
    toast('Uploading photo…');
    const { blob } = await compressImage(file, 512);
    const path = `data/avatars/${cfg.rid}.jpg`;
    const sha = await api.sha(path);
    await api.write(path, blob, `avatar: ${cfg.name}`, sha);
    await api.updateJson('data/roster.json',
      (cur) => (Array.isArray(cur) ? cur : []).map((m) => (m.id === cfg.rid ? { ...m, avatar: path } : m)),
      `avatar: ${cfg.name}`);
    state.blobCache.delete(path);
    await loadAll(false);
    openProfile();
    toast('Profile photo updated ✓');
  } catch (e) { toast(e.message, true); }
}

/* ----- invite links ----- */

function parseInviteLink() {
  const m = location.hash.match(/#invite=([A-Za-z0-9+/=_-]+)/);
  if (!m) return;
  try {
    const inv = JSON.parse(atob(decodeURIComponent(m[1])));
    if (inv.r) cfg.set('repo', inv.r);
    if (inv.b) cfg.set('branch', inv.b);
    if (inv.t) cfg.set('token', inv.t);
    localStorage.removeItem('bh_who_skipped');
    state.invited = true;
    history.replaceState(null, '', location.pathname + location.search);
  } catch { /* malformed invite — ignore */ }
}

function copyInviteLink() {
  if (!cfg.repo || !cfg.token) { toast('Set up repo + token in Settings first', true); return; }
  const inv = btoa(JSON.stringify({ r: cfg.repo, b: cfg.branch, t: cfg.token }));
  const url = `${location.origin}${location.pathname}#invite=${inv}`;
  const done = () => toast('Invite link copied — send it to the new member ✓');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(done).catch(() => prompt('Copy this invite link:', url));
  } else {
    prompt('Copy this invite link:', url);
  }
}

/* ----- resources ----- */

function renderResources() {
  const wrap = $('resourceList');
  wrap.innerHTML = '';
  if (!state.resources.length) {
    wrap.innerHTML = '<div class="empty"><p class="empty-title">No resources yet</p><p>Add your Onshape workspace, software downloads, guides…</p></div>';
    return;
  }
  const cats = [...new Set(state.resources.map((r) => r.category || 'General'))];
  cats.forEach((cat) => {
    const g = document.createElement('div');
    g.className = 'res-group';
    g.innerHTML = `<h3>${esc(cat)}</h3>`;
    state.resources.filter((r) => (r.category || 'General') === cat).forEach((r) => {
      const item = document.createElement('div');
      item.className = 'res-item';
      item.innerHTML = `<span>${r.url ? '🔗' : fileIcon(r.title)}</span>
        <span class="r-title">${esc(r.title)}</span>
        <span class="r-kind">${r.url ? 'link' : 'download'}</span>
        <button class="text-btn danger" aria-label="Remove">&times;</button>`;
      item.onclick = () => {
        if (r.url) window.open(r.url, '_blank', 'noopener');
        else if (r.filePath) downloadFile(r.filePath, r.title);
      };
      item.querySelector('button').onclick = (ev) => {
        ev.stopPropagation();
        if (confirm(`Remove “${r.title}” from resources?`)) removeResource(r.id);
      };
      g.appendChild(item);
    });
    wrap.appendChild(g);
  });
}

async function addResource() {
  if (!requireToken()) return;
  const title = prompt('Resource title (e.g. "Onshape — Team CAD"):');
  if (!title || !title.trim()) return;
  const url = prompt('Paste the link.\n(Leave empty to upload a file instead.)');
  if (url === null) return;
  const category = prompt('Category:', 'General') || 'General';
  if (url && url.trim()) {
    await saveResource({ id: uid(), title: title.trim(), url: url.trim(), category: category.trim() });
  } else {
    state.pendingResource = { title: title.trim(), category: category.trim() };
    $('resourceFileInput').click();
  }
}

async function saveResource(res) {
  try {
    await api.updateJson('data/resources.json',
      (cur) => [...(Array.isArray(cur) ? cur : []), res], `resource: ${res.title}`);
    state.resources.push(res);
    renderResources();
    toast('Resource added ✓');
  } catch (e) { toast(e.message, true); }
}

async function removeResource(id) {
  if (!requireToken()) return;
  try {
    await api.updateJson('data/resources.json',
      (cur) => (Array.isArray(cur) ? cur : []).filter((r) => r.id !== id), 'resource: remove');
    state.resources = state.resources.filter((r) => r.id !== id);
    renderResources();
  } catch (e) { toast(e.message, true); }
}

/* ----- onboarding wizard ----- */

const OB_STEPS = 5;

function openOnboarding() {
  state.obStep = 0;
  renderOnboarding();
  $('onboardSheet').classList.remove('hidden');
}

function obDots() {
  return `<div class="ob-dots">${Array.from({ length: OB_STEPS }, (_, i) =>
    `<span class="${i === state.obStep ? 'on' : ''}"></span>`).join('')}</div>`;
}

function renderOnboarding() {
  const body = $('onboardBody');
  const step = state.obStep;
  $('onboardNext').textContent = step === OB_STEPS - 1 ? 'Done' : 'Next';
  const titles = ['Welcome', 'Who are you?', 'The projects', 'Resources', 'How we document'];
  $('onboardStep').textContent = titles[step];

  if (step === 0) {
    body.innerHTML = `<div class="ob-hero"><div class="ob-emoji">🚀</div>
      <h2>Welcome to BlueHorizon</h2>
      <p>This is where the team documents everything — work logs, photos, meetings, purchase orders. It takes 60 seconds to learn and it’s how knowledge survives graduation.</p></div>${obDots()}`;
  } else if (step === 1) {
    body.innerHTML = `<p class="settings-note">Pick your name so entries and tasks link to you. Not listed? Ask your team lead to add you to the roster.</p>
      <div class="assignee-grid" id="obWho"></div>${obDots()}`;
    const grid = body.querySelector('#obWho');
    state.roster.forEach((m) => {
      const chip = document.createElement('button');
      chip.className = 'assignee-chip' + (cfg.rid === m.id ? ' on' : '');
      chip.textContent = m.name;
      chip.onclick = () => {
        cfg.set('rid', m.id);
        cfg.set('name', m.name);
        grid.querySelectorAll('.assignee-chip').forEach((c) => c.classList.remove('on'));
        chip.classList.add('on');
        renderTopbarAvatar();
      };
      grid.appendChild(chip);
    });
  } else if (step === 2) {
    body.innerHTML = `<p class="settings-note">The team is split into subteams. Browse any of them later under More → Projects.</p>${obDots()}`;
    state.projects.forEach((p) => {
      const latest = state.entries.find((e) => e.project === p.id);
      const card = document.createElement('div');
      card.className = 'ob-card';
      card.innerHTML = `<div class="ob-t">${esc(p.name)}</div>
        <div class="ob-s">${latest ? `Latest: ${esc(latest.title || latest.body?.slice(0, 60) || 'entry')} (${new Date(latest.date).toLocaleDateString()})` : 'No entries yet — be the first!'}</div>`;
      body.insertBefore(card, body.lastElementChild);
    });
  } else if (step === 3) {
    body.innerHTML = `<p class="settings-note">Everything you need — CAD, software, guides. Always available under More → Resources.</p>${obDots()}`;
    if (!state.resources.length) {
      const d = document.createElement('div');
      d.className = 'ob-card';
      d.innerHTML = '<div class="ob-s">No resources posted yet — check back soon.</div>';
      body.insertBefore(d, body.lastElementChild);
    }
    state.resources.slice(0, 8).forEach((r) => {
      const card = document.createElement('div');
      card.className = 'ob-card';
      card.style.cursor = 'pointer';
      card.innerHTML = `<div class="ob-t">${r.url ? '🔗' : '📥'} ${esc(r.title)}</div><div class="ob-s">${esc(r.category || '')}</div>`;
      card.onclick = () => { if (r.url) window.open(r.url, '_blank', 'noopener'); else if (r.filePath) downloadFile(r.filePath, r.title); };
      body.insertBefore(card, body.lastElementChild);
    });
  } else {
    body.innerHTML = `<div class="ob-hero"><div class="ob-emoji">📸</div>
      <h2>Document as you go</h2>
      <p>After every work session: tap <b>+</b>, snap a photo, write two sentences. That’s it.<br><br>
      Weekly journals (More → Write weekly journal) keep the story going, and whoever comes after you will thank you.</p></div>${obDots()}`;
  }
}

function onboardNext() {
  if (state.obStep < OB_STEPS - 1) {
    state.obStep++;
    renderOnboarding();
  } else {
    localStorage.setItem('bh_onboarded', '1');
    $('onboardSheet').classList.add('hidden');
    render();
    if (cfg.rid) toast(`Welcome aboard, ${cfg.name.split(' ')[0]}! 🚀`);
  }
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
  if (e.video) {
    const yt = e.video.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{6,})/);
    if (yt) {
      const iframe = document.createElement('iframe');
      iframe.className = 'video-embed';
      iframe.src = `https://www.youtube-nocookie.com/embed/${yt[1]}`;
      iframe.allowFullscreen = true;
      iframe.allow = 'accelerometer; encrypted-media; picture-in-picture';
      el.appendChild(iframe);
    } else {
      const a = document.createElement('div');
      a.className = 'file-chip';
      a.innerHTML = `<span>🎥</span><span class="f-name">Watch meeting recording</span>`;
      a.onclick = () => window.open(e.video, '_blank', 'noopener');
      el.appendChild(a);
    }
  }
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
  if (/\.(mp4|mov|webm)$/i.test(f.name)) {
    // inline video player
    try {
      toast('Loading video…');
      const blob = cfg.token ? await api.readBlob(f.path) : await fetch(rawUrl(f.path)).then((r) => r.blob());
      const v = document.createElement('video');
      v.className = 'video-embed';
      v.controls = true;
      v.src = URL.createObjectURL(blob);
      $('sheetViewerTitle').textContent = f.name;
      $('sheetViewerBody').innerHTML = '';
      $('sheetViewerBody').appendChild(v);
      const dl = $('sheetViewerDownload');
      dl.href = v.src;
      dl.download = f.name;
      $('sheetViewer').classList.remove('hidden');
    } catch (e) { toast(e.message, true); }
    return;
  }
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
  $('composeVideo').value = e.video || '';
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
    : type === 'meeting' ? 'Attendees, decisions made, action items…\n\nTip: paste a transcript here, or attach a .txt/.vtt file. Record with your phone’s voice memo transcription or upload the video to YouTube (unlisted) for free auto-captions.'
    : 'What did you do? What worked, what didn’t, what’s next?\n\nTwo sentences beats zero.';
  $('composeTitle').placeholder =
    type === 'meeting' ? `Meeting ${today()}` : 'Title (optional — e.g. ‘Igniter test #3’)';
  $('composeVideo').classList.toggle('hidden', type !== 'meeting');
}

function resetCompose() {
  $('composeTitle').value = '';
  $('composeBody').value = '';
  $('composeVideo').value = '';
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

async function compressImage(file, MAX = 1600) {
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
    authorRid: existing ? (existing.authorRid || cfg.rid) : cfg.rid,
    date: existing ? existing.date : now.toISOString(),
    photos: [...state.keepPhotos],
    files: [...state.keepFiles],
  };
  const videoUrl = $('composeVideo').value.trim();
  if (state.composeType === 'meeting' && videoUrl) entry.video = videoUrl;
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

  const pos = state.pos.filter((p) => hit(p.name) ||
    (p.rows || []).some((r) => r.cells.some((c) => hit(c))) ||
    (p.items || []).some((i) => hit(i.name) || hit(i.vendor) || hit(i.justification)));
  if (pos.length) {
    group(`Purchase Orders (${pos.length})`);
    pos.slice(0, 10).forEach((p) => {
      total++;
      const sub = p.kind === 'draft'
        ? `draft · ${(p.items || []).length} items`
        : `${p.rows.filter((r) => r.arrived).length}/${p.rows.length} arrived`;
      item(mark(p.name), sub, () => {
        if (p.kind === 'draft') openPob(p.id);
        else { state.openPo = p.id; switchView('po'); renderPoDetail(); }
      });
    });
  }

  const res = state.resources.filter((r) => hit(r.title) || hit(r.category));
  if (res.length) {
    group(`Resources (${res.length})`);
    res.slice(0, 8).forEach((r) => {
      total++;
      item(mark(r.title), esc(r.category || ''), () => {
        if (r.url) window.open(r.url, '_blank', 'noopener');
        else switchView('resources');
      });
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
  $('setPortal').value = cfg.portal;
  $('connTest').textContent = firstRun ? 'Welcome! Point the app at your club’s GitHub repo to get started.' : '';
  $('settings').classList.remove('hidden');
}

async function saveSettings() {
  cfg.set('name', $('setName').value);
  cfg.set('repo', $('setRepo').value.replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, ''));
  cfg.set('branch', $('setBranch').value || 'main');
  cfg.set('token', $('setToken').value);
  cfg.set('portal', $('setPortal').value.trim().replace(/\/+$/, ''));
  $('settings').classList.add('hidden');
  state.blobCache.clear();
  if (cfg.portalMode && !cfg.signedIn) openAuth();
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

const VIEWS = ['home', 'feed', 'photos', 'projects', 'project', 'meetings', 'pos', 'po', 'pob', 'roster', 'resources'];

function switchView(v) {
  state.view = v;
  VIEWS.forEach((name) => $('view-' + name).classList.toggle('hidden', name !== v));
  document.querySelectorAll('.tabbar .tab[data-view]').forEach((t) => {
    t.classList.toggle('active', t.dataset.view === v || (t.dataset.view === 'pos' && (v === 'po' || v === 'pob')));
  });
  $('tabMore').classList.toggle('active', ['photos', 'projects', 'project', 'meetings', 'roster', 'resources'].includes(v));
  window.scrollTo(0, 0);
}

function requireToken() {
  if (cfg.portalMode) {
    if (!cfg.signedIn) { openAuth(); return false; }
    if (cfg.role === 'pending') { toast('Your account is awaiting admin approval', true); return false; }
    return true;
  }
  if (!cfg.token) { toast('Add a GitHub token in Settings first', true); openSettings(); return false; }
  return true;
}

/* ----- portal accounts (Cloudflare Worker backend) ----- */

let authMode = 'login';

function openAuth() {
  authMode = 'login';
  renderAuthMode();
  $('authMsg').textContent = '';
  $('authSheet').classList.remove('hidden');
}

function renderAuthMode() {
  const signup = authMode === 'signup';
  $('authTitle').textContent = signup ? 'Create account' : 'Sign in';
  $('authSubmit').textContent = signup ? 'Create account' : 'Sign in';
  $('authName').classList.toggle('hidden', !signup);
  $('authEmail').classList.toggle('hidden', !signup);
  $('authToggle').textContent = signup ? 'Have an account? Sign in' : 'New here? Create an account';
}

/* After sign-in, tie the account to the team roster automatically —
   no pickers, no settings. Creates the roster entry if it doesn't exist. */
async function linkRosterIdentity() {
  if (!cfg.name) return;
  let m = state.roster.find((x) => x.name.toLowerCase() === cfg.name.toLowerCase());
  if (!m && cfg.canWrite) {
    const id = slug(cfg.name);
    try {
      await api.updateJson('data/roster.json',
        (cur) => {
          const list = Array.isArray(cur) ? cur : [];
          if (list.some((x) => x.id === id)) return list;
          return [...list, { id, name: cfg.name }].sort((a, b) => a.name.localeCompare(b.name));
        }, `roster: add ${cfg.name} (account)`);
      m = { id, name: cfg.name };
      state.roster.push(m);
    } catch { /* pending users can't write — linked on first approval */ }
  }
  if (m) {
    cfg.set('rid', m.id);
    fetch(`${cfg.portal}/api/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.session}` },
      body: JSON.stringify({ rid: m.id }),
    }).catch(() => {});
  }
  localStorage.setItem('bh_onboarded', '1'); // accounts replace the who-picker
}

async function submitAuth() {
  const username = $('authUser').value.trim();
  const password = $('authPass').value;
  const msg = $('authMsg');
  if (!username || !password) { msg.textContent = 'Username and password required.'; return; }
  const body = { username, password };
  if (authMode === 'signup') {
    body.name = $('authName').value.trim();
    body.email = $('authEmail').value.trim();
    if (!body.name) { msg.textContent = 'Name required.'; return; }
  }
  msg.textContent = 'Working…';
  try {
    const r = await fetch(`${cfg.portal}/api/${authMode}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) { msg.textContent = j.error || `Error ${r.status}`; return; }
    cfg.set('session', j.token);
    cfg.set('role', j.role);
    cfg.set('name', j.name);
    $('authSheet').classList.add('hidden');
    toast(j.message || `Signed in as ${j.name} ✓`);
    await linkRosterIdentity();
    render();
    loadAll(false);
    if (j.role === 'pending') toast('Account created — ask your admin to approve you', true);
  } catch (e) {
    msg.textContent = 'Can’t reach the portal server — check the URL in Settings.';
  }
}

function signOut() {
  cfg.del('session'); cfg.del('role');
  toast('Signed out');
  render();
  openAuth();
}

/* admin: pending approvals & roles (portal mode) */
async function renderUserAdmin() {
  const list = $('rosterList');
  if (!cfg.portalMode || cfg.role !== 'admin') return;
  try {
    const r = await fetch(`${cfg.portal}/api/users`, { headers: { Authorization: `Bearer ${cfg.session}` } });
    if (!r.ok) return;
    const users = await r.json();
    const box = document.createElement('div');
    box.style.marginBottom = '14px';
    box.innerHTML = '<h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-dim);margin:4px 0 8px">Accounts</h3>';
    users.forEach((u) => {
      const row = document.createElement('div');
      row.className = 'project-card';
      const roleSel = `<select class="input select" style="width:auto;padding:6px 10px" data-user="${esc(u.username)}">
        ${['pending', 'member', 'lead', 'admin', 'remove'].map((r2) =>
          `<option value="${r2}" ${u.role === r2 ? 'selected' : ''}>${r2}</option>`).join('')}</select>`;
      row.innerHTML = `<div><div class="project-name">${esc(u.name)} <span class="project-count">@${esc(u.username)}</span>
        ${u.role === 'pending' ? '<span class="badge" style="background:rgba(251,191,36,.15);color:#fbbf24">needs approval</span>' : ''}</div></div>${roleSel}`;
      row.querySelector('select').onchange = async (ev) => {
        const role = ev.target.value;
        if (role === 'remove' && !confirm(`Remove account @${u.username}?`)) { ev.target.value = u.role; return; }
        await fetch(`${cfg.portal}/api/users/role`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.session}` },
          body: JSON.stringify({ username: u.username, role }),
        });
        toast(role === 'remove' ? 'Account removed' : `@${u.username} → ${role} ✓`);
        renderRoster();
      };
      box.appendChild(row);
    });
    list.prepend(box);
  } catch { /* worker unreachable — skip */ }
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
  $('moreOnboard').onclick = () => { $('moreSheet').classList.add('hidden'); openOnboarding(); };
  $('moreEngineLab').onclick = () => { $('moreSheet').classList.add('hidden'); window.open('engine-lab.html', '_blank', 'noopener'); };

  // auth
  $('authSubmit').onclick = submitAuth;
  $('authToggle').onclick = () => { authMode = authMode === 'login' ? 'signup' : 'login'; renderAuthMode(); };
  $('authAdvanced').onclick = () => { $('authSheet').classList.add('hidden'); openSettings(); };
  $('authPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAuth(); });

  // new club repo (org)
  $('moreNewRepo').onclick = () => {
    $('moreSheet').classList.add('hidden');
    if (!requireToken()) return;
    if (cfg.portalMode && !['admin', 'lead'].includes(cfg.role)) { toast('Leads and admins only', true); return; }
    $('repoName').value = '';
    $('repoDesc').value = '';
    $('repoResult').textContent = '';
    $('repoSheet').classList.remove('hidden');
  };
  $('repoCancel').onclick = () => $('repoSheet').classList.add('hidden');
  document.querySelectorAll('#repoVisSeg .seg-btn').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('#repoVisSeg .seg-btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
    };
  });
  $('repoCreate').onclick = async () => {
    const name = $('repoName').value.trim();
    if (!name) { toast('Repo name required', true); return; }
    const out = $('repoResult');
    out.textContent = 'Creating…';
    try {
      const r = await fetch(`${cfg.portal}/api/repos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.session}` },
        body: JSON.stringify({
          name,
          description: $('repoDesc').value.trim(),
          isPrivate: document.querySelector('#repoVisSeg .seg-btn.active').dataset.vis === 'private',
        }),
      });
      const j = await r.json();
      if (!r.ok) { out.textContent = '✗ ' + (j.error || r.status); return; }
      out.innerHTML = `✓ Created — <a href="${esc(j.url)}" target="_blank" rel="noopener" style="color:var(--accent)">${esc(j.fullName)}</a>`;
      toast('Repo created ✓');
    } catch (e) { out.textContent = '✗ ' + e.message; }
  };

  // hero video (public site) uploader
  $('moreHero').onclick = () => {
    $('moreSheet').classList.add('hidden');
    if (!requireToken()) return;
    if (cfg.portalMode && !['admin', 'lead'].includes(cfg.role)) { toast('Admins and leads only', true); return; }
    $('heroInput').click();
  };
  $('heroInput').onchange = async (ev) => {
    const f = ev.target.files[0];
    ev.target.value = '';
    if (!f) return;
    if (f.size > 40 * 1048576) { toast('Keep the hero video under 40 MB (trim/compress the montage)', true); return; }
    try {
      toast('Uploading hero video — this can take a minute…');
      const sha = await api.sha('media/hero.mp4');
      await api.write('media/hero.mp4', f, 'site: update hero video', sha);
      toast('Hero video updated ✓ (public site refreshes in ~1 min)');
    } catch (e) { toast(e.message, true); }
  };
  $('btnProfile').onclick = openProfile;
  $('profileClose').onclick = () => $('profileSheet').classList.add('hidden');
  $('profileSwitch').onclick = () => {
    $('profileSheet').classList.add('hidden');
    if (cfg.portalMode && cfg.signedIn) signOut();
    else openWhoPicker();
  };
  $('avatarInput').onchange = (ev) => { if (ev.target.files[0]) uploadAvatar(ev.target.files[0]); ev.target.value = ''; };
  $('btnInviteLink').onclick = copyInviteLink;
  $('btnAddResource').onclick = addResource;
  $('resourceFileInput').onchange = async (ev) => {
    const f = ev.target.files[0];
    ev.target.value = '';
    if (!f || !state.pendingResource) return;
    if (f.size > 40 * 1048576) { toast('File over 40 MB — host it externally and add as a link', true); return; }
    try {
      toast('Uploading…');
      const path = `data/resources/${sanitizeName(f.name)}`;
      await api.write(path, f, `resource: ${state.pendingResource.title}`, await api.sha(path));
      await saveResource({ id: uid(), title: state.pendingResource.title, filePath: path, size: f.size, category: state.pendingResource.category });
    } catch (e) { toast(e.message, true); }
    state.pendingResource = null;
  };
  $('onboardNext').onclick = onboardNext;
  $('onboardSkip').onclick = () => { localStorage.setItem('bh_onboarded', '1'); $('onboardSheet').classList.add('hidden'); };
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
      const isVideo = /\.(mp4|mov|webm)$/i.test(f.name);
      const cap = isVideo ? 40 : 8;
      if (f.size > cap * 1048576) {
        toast(`${f.name} is over ${cap} MB — ${isVideo ? 'upload it to YouTube (unlisted) and paste the link instead' : 'too big for the repo'}`, true);
        continue;
      }
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

  // PO import + builder
  $('poFileInput').onchange = (ev) => {
    if (ev.target.files[0]) importPoFile(ev.target.files[0]);
    ev.target.value = '';
  };
  $('btnNewPo').onclick = newDraftPo;
  $('btnAddPoItem').onclick = () => { if (requireToken()) openPoItemSheet(null); };
  $('poItemCancel').onclick = () => $('poItemSheet').classList.add('hidden');
  $('poItemSave').onclick = savePoItem;
  $('piAutofill').onclick = autofillFromLink;
  document.querySelectorAll('#piDeliverySeg .seg-btn').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('#piDeliverySeg .seg-btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
    };
  });
  $('btnExportPo').onclick = exportPoXlsx;
  $('btnDeletePo').onclick = deleteDraftPo;
  $('pobTitle').onclick = renamePob;

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

  ['compose', 'entrySheet', 'settings', 'moreSheet', 'taskSheet', 'searchOverlay', 'sheetViewer', 'profileSheet', 'poItemSheet', 'authSheet', 'repoSheet'].forEach((id) => {
    $(id).addEventListener('click', (e) => { if (e.target === $(id)) $(id).classList.add('hidden'); });
  });
}

/* ----- boot ----- */

window.addEventListener('load', () => {
  parseInviteLink();
  wire();
  state.projects = DEFAULT_PROJECTS;
  render();
  loadAll();
  if (state.invited) toast('Welcome! Setting things up…');
  if (cfg.portalMode && !cfg.signedIn) openAuth();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
});
