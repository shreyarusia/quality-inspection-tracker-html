const SEVERITIES = ['Critical', 'Major', 'Minor'];
const SEVERITY_RANK = { Critical: 0, Major: 1, Minor: 2 };
const STATUS_RANK = { Open: 0, Resolved: 1 };

const state = {
  token: null,
  user: null,
  view: 'log',
  online: navigator.onLine,
  syncing: false,
  inspections: [],
  pending: [],
  filters: {
    status: 'All',
    severity: 'All',
    from: '',
    to: '',
    sort: 'date-desc',
  },
  resolving: null,
};

const $ = (selector) => document.querySelector(selector);

function createUuid() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function todayISO() {
  const date = new Date();
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function formatDate(iso) {
  if (!iso) return '';
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function loadOutbox() {
  const items = loadJson('qit.outbox', []);
  return Array.isArray(items) ? items : [];
}

function saveOutbox(items) {
  state.pending = items;
  saveJson('qit.outbox', items);
}

class ApiError extends Error {
  constructor(message, status, network = false) {
    super(message);
    this.status = status;
    this.network = network;
  }
}

async function api(path, { method = 'GET', body, auth = true } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(auth && state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      },
      body: body == null ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('You appear to be offline.', 0, true);
  }

  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && auth) {
    clearSession();
    showLogin();
    throw new ApiError(data.error || 'Sign in required', 401);
  }
  if (!response.ok && response.status !== 409) {
    throw new ApiError(data.error || 'Request failed', response.status);
  }
  return { status: response.status, data };
}

function clearSession() {
  state.token = null;
  state.user = null;
  localStorage.removeItem('qit.token');
  localStorage.removeItem('qit.user');
}

function showLogin() {
  $('#shell').hidden = true;
  $('#login-view').hidden = false;
}

function showShell() {
  $('#login-view').hidden = true;
  $('#shell').hidden = false;
}

let toastTimer = 0;
function showToast(message, kind = 'ok') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.toggle('error', kind === 'error');
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 3200);
}

function setFormError(id, message) {
  const node = $(id);
  node.hidden = !message;
  node.textContent = message || '';
}

function mergedInspections() {
  const resolves = new Map(
    state.pending.filter((item) => item.kind === 'resolve').map((item) => [item.id, item])
  );
  const server = state.inspections.map((inspection) => {
    const pending = resolves.get(inspection.id);
    if (!pending) return inspection;
    return {
      ...inspection,
      status: 'Resolved',
      resolutionNote: pending.resolutionNote,
      pendingSync: true,
    };
  });
  const known = new Set(server.map((inspection) => inspection.clientUuid).filter(Boolean));
  const local = state.pending
    .filter((item) => item.kind === 'create' && !known.has(item.payload.clientUuid))
    .map((item) => ({
      id: `local-${item.payload.clientUuid}`,
      local: true,
      pendingSync: true,
      clientUuid: item.payload.clientUuid,
      inspectionDate: item.payload.inspectionDate,
      machineLineId: item.payload.machineLineId,
      defectType: item.payload.defectType,
      severity: item.payload.severity,
      remarks: item.payload.remarks || null,
      status: item.resolutionNote ? 'Resolved' : 'Open',
      resolutionNote: item.resolutionNote || null,
      resolvedAt: null,
      source: 'manual',
      sapReference: null,
      createdAt: item.createdAt,
    }));
  return [...local, ...server];
}

function filteredInspections() {
  const { status, severity, from, to, sort } = state.filters;
  if (from && to && from > to) return [];
  const items = mergedInspections().filter((inspection) => {
    if (status !== 'All' && inspection.status !== status) return false;
    if (severity !== 'All' && inspection.severity !== severity) return false;
    if (from && inspection.inspectionDate < from) return false;
    if (to && inspection.inspectionDate > to) return false;
    return true;
  });

  const [key, direction] = sort.split('-');
  const factor = direction === 'desc' ? -1 : 1;
  items.sort((a, b) => {
    let diff = 0;
    if (key === 'date') diff = a.inspectionDate.localeCompare(b.inspectionDate);
    else if (key === 'severity') diff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    else if (key === 'status') diff = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    else diff = a.machineLineId.localeCompare(b.machineLineId, undefined, { sensitivity: 'base' });
    const tie = String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    return diff * factor || tie;
  });
  return items;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([key, value]) => {
    if (value == null || value === false) return;
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value === true ? '' : value);
  });
  children.flat().forEach((child) => {
    if (child == null || child === false) return;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  });
  return node;
}

function renderBanner() {
  const banner = $('#status-banner');
  const pending = state.pending.length;
  const syncBtn = $('#sync-btn');
  if (!state.online) {
    banner.hidden = false;
    $('#status-text').textContent = pending
      ? `Offline. ${pending} change${pending === 1 ? '' : 's'} will sync when you reconnect.`
      : 'Offline. You can still log inspections on this phone.';
    syncBtn.hidden = true;
    return;
  }
  if (pending) {
    banner.hidden = false;
    $('#status-text').textContent = state.syncing
      ? 'Syncing saved inspections…'
      : `${pending} change${pending === 1 ? '' : 's'} waiting to sync.`;
    syncBtn.hidden = state.syncing;
    return;
  }
  banner.hidden = true;
}

function renderFilters() {
  $('#status-filter').querySelectorAll('button').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.status === state.filters.status));
  });
}

function renderList() {
  const rangeError = state.filters.from && state.filters.to && state.filters.from > state.filters.to;
  setFormError('#range-error', rangeError ? 'The start date is after the end date.' : '');
  const items = filteredInspections();
  const noun = items.length === 1 ? 'inspection' : 'inspections';
  $('#list-count').textContent = rangeError ? '' : `${items.length} ${noun}`;
  const list = $('#list');
  list.replaceChildren();
  if (!items.length) {
    list.append(el('p', { class: 'empty' }, [
      rangeError ? 'Fix the date range to see inspections.' : 'No inspections match these filters.',
    ]));
    return;
  }

  items.forEach((inspection) => {
    const pills = [
      el('span', { class: `pill pill-${inspection.severity.toLowerCase()}` }, [inspection.severity]),
      el('span', { class: `pill pill-${inspection.status.toLowerCase()}` }, [inspection.status]),
    ];
    if (inspection.source === 'sap') pills.push(el('span', { class: 'pill pill-sap' }, ['SAP']));
    if (inspection.pendingSync) pills.push(el('span', { class: 'pill pill-pending' }, ['Pending sync']));

    const card = el('article', {
      class: `card${inspection.pendingSync ? ' pending' : ''}`,
      'data-severity': inspection.severity,
    }, [
      el('div', { class: 'card-top' }, [
        el('strong', {}, [inspection.machineLineId]),
        el('time', { datetime: inspection.inspectionDate }, [formatDate(inspection.inspectionDate)]),
      ]),
      el('p', { class: 'defect' }, [inspection.defectType]),
      el('div', { class: 'pills' }, pills),
      inspection.remarks ? el('p', { class: 'remarks' }, [inspection.remarks]) : null,
      inspection.resolutionNote
        ? el('p', { class: 'resolution' }, [`Resolved: ${inspection.resolutionNote}`])
        : null,
      inspection.status === 'Open'
        ? el('button', {
          class: 'btn btn-primary',
          type: 'button',
          'data-resolve': inspection.local ? inspection.clientUuid : String(inspection.id),
          'data-local': inspection.local ? 'true' : 'false',
          'data-label': `${inspection.machineLineId} · ${inspection.defectType}`,
        }, ['Mark resolved'])
        : null,
    ]);
    list.append(card);
  });
}

function renderSummary() {
  const items = mergedInspections();
  const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, { open: 0, resolved: 0 }]));
  items.forEach((inspection) => {
    const bucket = counts[inspection.severity];
    if (!bucket) return;
    if (inspection.status === 'Resolved') bucket.resolved += 1;
    else bucket.open += 1;
  });
  const totals = SEVERITIES.reduce((acc, severity) => {
    acc.open += counts[severity].open;
    acc.resolved += counts[severity].resolved;
    return acc;
  }, { open: 0, resolved: 0 });

  $('#open-total').textContent = String(totals.open);
  $('#resolved-total').textContent = String(totals.resolved);
  const body = $('#summary-body');
  body.replaceChildren();
  SEVERITIES.forEach((severity) => {
    const row = counts[severity];
    body.append(el('tr', {}, [
      el('td', {}, [severity]),
      el('td', { class: 'num' }, [String(row.open)]),
      el('td', { class: 'num' }, [String(row.resolved)]),
      el('td', { class: 'num' }, [String(row.open + row.resolved)]),
    ]));
  });
  body.append(el('tr', { class: 'total-row' }, [
    el('td', {}, ['Total']),
    el('td', { class: 'num' }, [String(totals.open)]),
    el('td', { class: 'num' }, [String(totals.resolved)]),
    el('td', { class: 'num' }, [String(totals.open + totals.resolved)]),
  ]));

  const note = $('#summary-note');
  const pending = state.pending.length;
  note.hidden = pending === 0;
  note.textContent = pending
    ? 'These counts include inspections still waiting to sync from this phone.'
    : '';
}

function renderTabs() {
  document.querySelectorAll('.tabbar button').forEach((button) => {
    if (button.dataset.view === state.view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  $('#view-log').hidden = state.view !== 'log';
  $('#view-list').hidden = state.view !== 'list';
  $('#view-summary').hidden = state.view !== 'summary';
}

function render() {
  renderBanner();
  renderFilters();
  renderTabs();
  renderList();
  renderSummary();
}

function switchView(view) {
  state.view = view;
  render();
  window.scrollTo(0, 0);
}

async function refresh() {
  const { data } = await api('/api/inspections');
  state.inspections = data.inspections || [];
  saveJson('qit.cache', state.inspections);
  state.online = true;
}

async function syncItem(item) {
  if (item.kind === 'create') {
    const { data } = await api('/api/inspections', { method: 'POST', body: item.payload });
    if (item.resolutionNote) {
      const created = data.inspection;
      const resolved = await api(`/api/inspections/${created.id}/resolve`, {
        method: 'PATCH',
        body: { resolutionNote: item.resolutionNote },
      });
      if (resolved.status === 409) return;
    }
    return;
  }
  const result = await api(`/api/inspections/${item.id}/resolve`, {
    method: 'PATCH',
    body: { resolutionNote: item.resolutionNote },
  });
  if (result.status === 409) return;
}

async function flushOutbox() {
  if (!state.online || !state.token || state.syncing || state.pending.length === 0) return;
  state.syncing = true;
  renderBanner();
  const queue = [...state.pending];
  const remaining = [];
  for (let index = 0; index < queue.length; index += 1) {
    try {
      await syncItem(queue[index]);
    } catch (error) {
      if (error.status === 400) {
        showToast(error.message, 'error');
        continue;
      }
      if (error.network) state.online = false;
      remaining.push(...queue.slice(index));
      break;
    }
  }
  saveOutbox(remaining);
  state.syncing = false;
  if (state.online && state.token) {
    try {
      await refresh();
    } catch (error) {
      if (error.network) state.online = false;
    }
  }
  render();
}

function enqueue(item) {
  saveOutbox([...state.pending, item]);
}

function readInspectionForm() {
  const inspectionDate = $('#inspection-date').value;
  const machineLineId = $('#machine-line').value.replace(/\s+/g, ' ').trim();
  const defectType = $('#defect-type').value;
  const severityInput = document.querySelector('input[name="severity"]:checked');
  const remarks = $('#remarks').value.trim();
  if (!inspectionDate) return { error: 'Choose the inspection date.' };
  if (!machineLineId) return { error: 'Enter the machine / line ID.' };
  if (machineLineId.length > 80) return { error: 'Machine / line ID must be 80 characters or fewer.' };
  if (!defectType) return { error: 'Choose a defect type.' };
  if (!severityInput) return { error: 'Choose a severity.' };
  if (remarks.length > 1000) return { error: 'Remarks must be 1000 characters or fewer.' };
  return {
    value: {
      clientUuid: createUuid(),
      inspectionDate,
      machineLineId,
      defectType,
      severity: severityInput.value,
      remarks: remarks || null,
    },
  };
}

function resetInspectionForm() {
  $('#inspection-form').reset();
  $('#inspection-date').value = todayISO();
  setFormError('#form-error', '');
}

async function saveInspection(payload) {
  if (!state.online) {
    enqueue({ kind: 'create', payload, createdAt: new Date().toISOString() });
    resetInspectionForm();
    showToast('Saved on this phone. It will sync when you are back online.');
    switchView('list');
    return;
  }
  try {
    await api('/api/inspections', { method: 'POST', body: payload });
    await refresh();
    resetInspectionForm();
    showToast('Inspection logged.');
    switchView('list');
  } catch (error) {
    if (error.network) {
      state.online = false;
      enqueue({ kind: 'create', payload, createdAt: new Date().toISOString() });
      resetInspectionForm();
      showToast('Saved on this phone. It will sync when you are back online.');
      switchView('list');
      return;
    }
    setFormError('#form-error', error.message);
  }
}

function openResolve(inspectionKey, local, label) {
  state.resolving = { key: inspectionKey, local, label };
  $('#resolve-context').textContent = label;
  $('#resolve-note').value = '';
  setFormError('#resolve-error', '');
  $('#resolve-layer').hidden = false;
  document.body.classList.add('modal-open');
  $('#resolve-note').focus();
}

function closeResolve() {
  state.resolving = null;
  $('#resolve-layer').hidden = true;
  document.body.classList.remove('modal-open');
}

async function confirmResolve() {
  const note = $('#resolve-note').value.trim();
  if (!note) {
    setFormError('#resolve-error', 'A resolution note is required.');
    return;
  }
  if (note.length > 1000) {
    setFormError('#resolve-error', 'Resolution note must be 1000 characters or fewer.');
    return;
  }
  const target = state.resolving;
  if (!target) return;
  $('#resolve-save').disabled = true;

  try {
    if (target.local) {
      const next = state.pending.map((item) => (
        item.kind === 'create' && item.payload.clientUuid === target.key
          ? { ...item, resolutionNote: note }
          : item
      ));
      saveOutbox(next);
      closeResolve();
      showToast(state.online ? 'Resolution saved. Syncing…' : 'Resolution saved on this phone.');
      render();
      if (state.online) await flushOutbox();
      return;
    }

    const id = Number(target.key);
    if (!state.online) {
      enqueue({ kind: 'resolve', id, resolutionNote: note });
      closeResolve();
      showToast('Resolution saved on this phone. It will sync when you are back online.');
      render();
      return;
    }

    try {
      const result = await api(`/api/inspections/${id}/resolve`, {
        method: 'PATCH',
        body: { resolutionNote: note },
      });
      if (result.status === 409) showToast('This inspection was already resolved.');
      else showToast('Inspection resolved.');
      await refresh();
      closeResolve();
      render();
    } catch (error) {
      if (error.network) {
        state.online = false;
        enqueue({ kind: 'resolve', id, resolutionNote: note });
        closeResolve();
        showToast('Resolution saved on this phone. It will sync when you are back online.');
        render();
        return;
      }
      setFormError('#resolve-error', error.message);
    }
  } finally {
    $('#resolve-save').disabled = false;
  }
}

function bindEvents() {
  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    setFormError('#login-error', '');
    const button = event.target.querySelector('button');
    button.disabled = true;
    try {
      const { data } = await api('/api/auth/login', {
        method: 'POST',
        auth: false,
        body: {
          username: $('#username').value.trim(),
          password: $('#password').value,
        },
      });
      state.token = data.token;
      state.user = data.user;
      localStorage.setItem('qit.token', data.token);
      saveJson('qit.user', data.user);
      state.online = true;
      showShell();
      await refresh();
      await flushOutbox();
      switchView('log');
    } catch (error) {
      if (error.status !== 401) {
        setFormError('#login-error', error.network
          ? 'Can’t reach the server. Connect once to sign in.'
          : error.message);
      } else {
        setFormError('#login-error', 'Incorrect username or password.');
      }
    } finally {
      button.disabled = false;
    }
  });

  $('#logout-btn').addEventListener('click', () => {
    clearSession();
    showLogin();
  });

  $('#inspection-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    setFormError('#form-error', '');
    const parsed = readInspectionForm();
    if (parsed.error) {
      setFormError('#form-error', parsed.error);
      return;
    }
    const button = $('#save-btn');
    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      await saveInspection(parsed.value);
    } finally {
      button.disabled = false;
      button.textContent = 'Save inspection';
    }
  });

  document.querySelector('.tabbar').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-view]');
    if (!button) return;
    switchView(button.dataset.view);
  });

  $('#status-filter').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-status]');
    if (!button) return;
    state.filters.status = button.dataset.status;
    render();
  });

  $('#severity-filter').addEventListener('change', (event) => {
    state.filters.severity = event.target.value;
    render();
  });
  $('#from-date').addEventListener('change', (event) => {
    state.filters.from = event.target.value;
    render();
  });
  $('#to-date').addEventListener('change', (event) => {
    state.filters.to = event.target.value;
    render();
  });
  $('#sort-filter').addEventListener('change', (event) => {
    state.filters.sort = event.target.value;
    render();
  });

  $('#list').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-resolve]');
    if (!button) return;
    openResolve(button.dataset.resolve, button.dataset.local === 'true', button.dataset.label);
  });

  $('#resolve-cancel').addEventListener('click', closeResolve);
  $('#resolve-save').addEventListener('click', confirmResolve);
  $('#resolve-layer').addEventListener('click', (event) => {
    if (event.target === $('#resolve-layer')) closeResolve();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#resolve-layer').hidden) closeResolve();
  });
  $('#sync-btn').addEventListener('click', () => {
    flushOutbox().catch((error) => showToast(error.message, 'error'));
  });

  window.addEventListener('online', () => {
    state.online = true;
    flushOutbox().catch(() => {});
  });
  window.addEventListener('offline', () => {
    state.online = false;
    render();
  });
}

async function boot() {
  $('#inspection-date').value = todayISO();
  state.token = localStorage.getItem('qit.token');
  state.user = loadJson('qit.user', null);
  state.pending = loadOutbox();
  state.inspections = loadJson('qit.cache', []);
  bindEvents();

  if (!state.token) {
    showLogin();
    return;
  }

  showShell();
  render();
  if (!navigator.onLine) return;
  try {
    await api('/api/auth/me');
    await refresh();
    render();
    await flushOutbox();
  } catch (error) {
    if (error.network) {
      state.online = false;
      render();
    }
  }
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

boot();
