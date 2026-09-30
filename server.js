const crypto = require('crypto');
const path = require('path');
const express = require('express');
const db = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const TOKEN_SECRET = process.env.JWT_SECRET || '123';
const SAP_TOKEN = process.env.SAP_WEBHOOK_TOKEN || 'sap-demo-token';
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

function signToken(user) {
  const body = Buffer.from(JSON.stringify({
    sub: user.id,
    username: user.username,
    displayName: user.display_name,
    exp: Date.now() + TOKEN_TTL_MS,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function readToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  const actualBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (actualBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(actualBuf, expectedBuf)) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function safeEqual(left, right) {
  const actual = Buffer.from(String(left));
  const expected = Buffer.from(String(right));
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const payload = readToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'Sign in required' });
  }
  req.user = payload;
  return next();
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function normalizeDate(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match || !isIsoDate(match[1])) return null;
  return match[1];
}

function canonical(value, allowed) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return allowed.find((item) => item.toLowerCase() === trimmed) || null;
}

function cleanMachine(value) {
  if (typeof value !== 'string') return { error: 'Machine / line ID is required' };
  const machine = value.replace(/\s+/g, ' ').trim();
  if (!machine) return { error: 'Machine / line ID is required' };
  if (machine.length > 80) return { error: 'Machine / line ID must be 80 characters or fewer' };
  return { value: machine };
}

function cleanOptionalText(value, label, max) {
  if (value == null || value === '') return { value: null };
  if (typeof value !== 'string') return { error: `${label} must be text` };
  const text = value.trim();
  if (!text) return { value: null };
  if (text.length > max) return { error: `${label} must be ${max} characters or fewer` };
  return { value: text };
}

function cleanClientUuid(value) {
  if (value == null || value === '') return { value: null };
  if (typeof value !== 'string') return { error: 'clientUuid must be text' };
  const uuid = value.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) {
    return { error: 'clientUuid must be a UUID' };
  }
  return { value: uuid.toLowerCase() };
}

function validateInspection(body) {
  const source = body || {};
  const inspectionDate = normalizeDate(source.inspectionDate);
  if (!inspectionDate) return { error: 'Inspection date must be a valid date (YYYY-MM-DD)' };

  const machine = cleanMachine(source.machineLineId);
  if (machine.error) return machine;

  const defectType = canonical(source.defectType, db.DEFECT_TYPES);
  if (!defectType) {
    return { error: `Defect type must be one of: ${db.DEFECT_TYPES.join(', ')}` };
  }

  const severity = canonical(source.severity, db.SEVERITIES);
  if (!severity) {
    return { error: `Severity must be one of: ${db.SEVERITIES.join(', ')}` };
  }

  const remarks = cleanOptionalText(source.remarks, 'Remarks', 1000);
  if (remarks.error) return remarks;

  const clientUuid = cleanClientUuid(source.clientUuid);
  if (clientUuid.error) return clientUuid;

  return {
    value: {
      inspectionDate,
      machineLineId: machine.value,
      defectType,
      severity,
      remarks: remarks.value,
      clientUuid: clientUuid.value,
    },
  };
}

function parseListQuery(query) {
  const severity = query.severity ? canonical(query.severity, db.SEVERITIES) : null;
  if (query.severity && !severity) {
    return { error: `Severity must be one of: ${db.SEVERITIES.join(', ')}` };
  }
  const status = query.status ? canonical(query.status, db.STATUSES) : null;
  if (query.status && !status) {
    return { error: `Status must be one of: ${db.STATUSES.join(', ')}` };
  }
  const from = query.from ? normalizeDate(query.from) : null;
  if (query.from && !from) return { error: 'from must be a valid date (YYYY-MM-DD)' };
  const to = query.to ? normalizeDate(query.to) : null;
  if (query.to && !to) return { error: 'to must be a valid date (YYYY-MM-DD)' };
  if (from && to && from > to) return { error: 'from must be on or before to' };

  const sort = query.sort || 'inspectionDate';
  if (!Object.prototype.hasOwnProperty.call(db.SORTS, sort)) {
    return { error: 'sort must be inspectionDate, severity, status, or machineLineId' };
  }
  const order = query.order ? String(query.order).toLowerCase() : undefined;
  if (order && order !== 'asc' && order !== 'desc') {
    return { error: 'order must be asc or desc' };
  }
  return { value: { severity, status, from, to, sort, order } };
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/api/auth/login', (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const user = username ? db.findUserByUsername(username) : null;
  const passwordOk = db.verifyPassword(password, user ? user.password_hash : db.DUMMY_PASSWORD_HASH);
  if (!user || !passwordOk) {
    return res.status(401).json({ error: 'Incorrect username or password' });
  }
  return res.json({
    token: signToken(user),
    user: { id: user.id, username: user.username, displayName: user.display_name },
  });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({
    user: {
      id: req.user.sub,
      username: req.user.username,
      displayName: req.user.displayName,
    },
  });
});

app.get('/api/inspections', requireAuth, (req, res) => {
  const parsed = parseListQuery(req.query);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  return res.json({ inspections: db.listInspections(parsed.value) });
});

app.post('/api/inspections', requireAuth, (req, res) => {
  const parsed = validateInspection(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { inspection, deduped } = db.insertInspection({
    ...parsed.value,
    source: 'manual',
    sapReference: null,
    createdBy: req.user.sub,
    createdAt: new Date().toISOString(),
  });
  return res.status(deduped ? 200 : 201).json({ inspection, deduped });
});

app.patch('/api/inspections/:id/resolve', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Inspection id is invalid' });
  }
  const note = cleanOptionalText(req.body?.resolutionNote, 'Resolution note', 1000);
  if (note.error) return res.status(400).json({ error: note.error });
  if (!note.value) return res.status(400).json({ error: 'Resolution note is required' });

  const existing = db.findById(id);
  if (!existing) return res.status(404).json({ error: 'Inspection not found' });
  if (existing.status === 'Resolved') {
    return res.status(409).json({ error: 'Inspection is already resolved', inspection: existing });
  }
  const inspection = db.resolveInspection(id, note.value, new Date().toISOString());
  return res.json({ inspection });
});

app.get('/api/summary', requireAuth, (req, res) => {
  res.json(db.summary());
});

app.post('/api/sap-webhook', (req, res) => {
  const provided = req.get('x-sap-token') || '';
  if (!provided || !safeEqual(provided, SAP_TOKEN)) {
    return res.status(401).json({ error: 'Invalid SAP token' });
  }
  const parsed = validateInspection(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const reference = cleanOptionalText(req.body?.sapReference, 'sapReference', 64);
  if (reference.error) return res.status(400).json({ error: reference.error });
  if (reference.value && !/^[\w./:-]+$/.test(reference.value)) {
    return res.status(400).json({ error: 'sapReference may contain only letters, numbers, and . / : _ -' });
  }

  const { inspection, deduped } = db.insertInspection({
    ...parsed.value,
    clientUuid: null,
    source: 'sap',
    sapReference: reference.value,
    createdBy: null,
    createdAt: new Date().toISOString(),
  });
  return res.status(deduped ? 200 : 201).json({ inspection, deduped });
});

app.use((req, res, next) => {
  if (req.path === '/sw.js') res.setHeader('Cache-Control', 'no-cache');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((error, req, res, next) => {
  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body must be JSON' });
  }
  console.error(error);
  return res.status(500).json({ error: 'Something went wrong' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Quality Inspection Tracker running at http://localhost:${PORT}`);
    console.log('Sign in with username "supervisor" and password "shopfloor"');
    if (TOKEN_SECRET === 'dev-only-change-me') {
      console.log('Using the built-in session secret. Set JWT_SECRET if this host is shared.');
    }
  });
}

module.exports = { app, close: db.close };
