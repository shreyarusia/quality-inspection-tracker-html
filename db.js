const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'inspections.db');

const SEVERITIES = ['Critical', 'Major', 'Minor'];
const DEFECT_TYPES = [
  'Weave Defect',
  'Shade Variation',
  'Hole/Tear',
  'Count Deviation',
  'Other',
];
const STATUSES = ['Open', 'Resolved'];

const SORTS = {
  inspectionDate: 'inspection_date',
  severity: "CASE severity WHEN 'Critical' THEN 1 WHEN 'Major' THEN 2 ELSE 3 END",
  status: "CASE status WHEN 'Open' THEN 1 ELSE 2 END",
  machineLineId: 'machine_line_id COLLATE NOCASE',
};

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, hash] = String(stored).split(':');
    if (!salt || !hash) return false;
    const actual = Buffer.from(hash, 'hex');
    const expected = crypto.scryptSync(password, salt, 64);
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function localISODate(date) {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return shifted.toISOString().slice(0, 10);
}

function daysAgo(days) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return localISODate(date);
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const isNewDatabase = !fs.existsSync(DB_PATH);
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS inspections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_uuid TEXT UNIQUE,
    inspection_date TEXT NOT NULL,
    machine_line_id TEXT NOT NULL,
    defect_type TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('Critical', 'Major', 'Minor')),
    remarks TEXT,
    status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Resolved')),
    resolution_note TEXT,
    resolved_at TEXT,
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'sap')),
    sap_reference TEXT,
    created_by INTEGER,
    created_at TEXT NOT NULL,
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_inspections_sap_reference
    ON inspections (sap_reference)
    WHERE sap_reference IS NOT NULL;

  CREATE INDEX IF NOT EXISTS idx_inspections_filters
    ON inspections (inspection_date, status, severity);
`);

const DUMMY_PASSWORD_HASH = hashPassword('not-a-real-password');

function ensureSupervisor() {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get('supervisor');
  if (existing) return existing.id;
  const result = db.prepare(
    'INSERT INTO users (username, password_hash, display_name) VALUES (?, ?, ?)'
  ).run('supervisor', hashPassword('shopfloor'), 'Floor Supervisor');
  return Number(result.lastInsertRowid);
}

function seedSamples(userId) {
  const insert = db.prepare(`
    INSERT INTO inspections (
      client_uuid, inspection_date, machine_line_id, defect_type, severity,
      remarks, status, resolution_note, resolved_at, source, sap_reference,
      created_by, created_at
    ) VALUES (
      @client_uuid, @inspection_date, @machine_line_id, @defect_type, @severity,
      @remarks, @status, @resolution_note, @resolved_at, @source, @sap_reference,
      @created_by, @created_at
    )
  `);

  const now = new Date().toISOString();
  const resolved = (note) => ({
    status: 'Resolved',
    resolution_note: note,
    resolved_at: now,
  });
  const open = {
    status: 'Open',
    resolution_note: null,
    resolved_at: null,
  };

  const rows = [
    {
      inspection_date: daysAgo(0),
      machine_line_id: 'GJ-SUR-L04',
      defect_type: 'Weave Defect',
      severity: 'Major',
      remarks: 'Broken warp near the selvedge, about 2 metres in.',
      ...open,
      source: 'manual',
      sap_reference: null,
    },
    {
      inspection_date: daysAgo(0),
      machine_line_id: 'MH-PUN-L02',
      defect_type: 'Shade Variation',
      severity: 'Critical',
      remarks: 'Panel shade does not match the approved swatch.',
      ...open,
      source: 'manual',
      sap_reference: null,
    },
    {
      inspection_date: daysAgo(1),
      machine_line_id: 'GJ-AMD-L11',
      defect_type: 'Hole/Tear',
      severity: 'Critical',
      remarks: 'Tear found during doffing. Roll held at the line.',
      ...open,
      source: 'manual',
      sap_reference: null,
    },
    {
      inspection_date: daysAgo(1),
      machine_line_id: 'GJ-SUR-L04',
      defect_type: 'Count Deviation',
      severity: 'Minor',
      remarks: 'Reed count looked short on the first check.',
      ...resolved('Re-checked the reed count. Second reading is within tolerance.'),
      source: 'manual',
      sap_reference: null,
    },
    {
      inspection_date: daysAgo(2),
      machine_line_id: 'GJ-SUR-L09',
      defect_type: 'Hole/Tear',
      severity: 'Minor',
      remarks: 'Pin hole near the centre of the roll.',
      ...open,
      source: 'manual',
      sap_reference: null,
    },
    {
      inspection_date: daysAgo(3),
      machine_line_id: 'MH-NGP-L07',
      defect_type: 'Weave Defect',
      severity: 'Minor',
      remarks: 'Occasional float. Watching the next two rolls.',
      ...open,
      source: 'manual',
      sap_reference: null,
    },
    {
      inspection_date: daysAgo(5),
      machine_line_id: 'GJ-AMD-L11',
      defect_type: 'Other',
      severity: 'Major',
      remarks: 'Oil mark along one edge.',
      ...resolved('Traced to a leaking guide. Guide cleaned and the roll downgraded.'),
      source: 'manual',
      sap_reference: null,
    },
    {
      inspection_date: daysAgo(8),
      machine_line_id: 'MH-PUN-L02',
      defect_type: 'Shade Variation',
      severity: 'Major',
      remarks: 'SAP QM lot flagged a shade delta against the standard.',
      ...resolved('Lot blocked in SAP and sent back for re-dye.'),
      source: 'sap',
      sap_reference: 'QM-44810',
    },
  ];

  const write = db.transaction((items) => {
    for (const item of items) {
      insert.run({
        client_uuid: null,
        created_by: item.source === 'sap' ? null : userId,
        created_at: now,
        ...item,
      });
    }
  });
  write(rows);
}

const supervisorId = ensureSupervisor();
if (isNewDatabase && process.env.NODE_ENV !== 'test') {
  seedSamples(supervisorId);
}

function mapInspection(row) {
  if (!row) return null;
  return {
    id: row.id,
    clientUuid: row.client_uuid,
    inspectionDate: row.inspection_date,
    machineLineId: row.machine_line_id,
    defectType: row.defect_type,
    severity: row.severity,
    remarks: row.remarks,
    status: row.status,
    resolutionNote: row.resolution_note,
    resolvedAt: row.resolved_at,
    source: row.source,
    sapReference: row.sap_reference,
    createdAt: row.created_at,
  };
}

function findUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function findByClientUuid(clientUuid) {
  return mapInspection(
    db.prepare('SELECT * FROM inspections WHERE client_uuid = ?').get(clientUuid)
  );
}

function findBySapReference(sapReference) {
  return mapInspection(
    db.prepare('SELECT * FROM inspections WHERE sap_reference = ?').get(sapReference)
  );
}

function findById(id) {
  return mapInspection(db.prepare('SELECT * FROM inspections WHERE id = ?').get(id));
}

function insertInspection(record) {
  try {
    const result = db.prepare(`
      INSERT INTO inspections (
        client_uuid, inspection_date, machine_line_id, defect_type, severity,
        remarks, status, resolution_note, resolved_at, source, sap_reference,
        created_by, created_at
      ) VALUES (
        @clientUuid, @inspectionDate, @machineLineId, @defectType, @severity,
        @remarks, 'Open', NULL, NULL, @source, @sapReference,
        @createdBy, @createdAt
      )
    `).run(record);
    return { inspection: findById(Number(result.lastInsertRowid)), deduped: false };
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      if (record.clientUuid) {
        const existing = findByClientUuid(record.clientUuid);
        if (existing) return { inspection: existing, deduped: true };
      }
      if (record.sapReference) {
        const existing = findBySapReference(record.sapReference);
        if (existing) return { inspection: existing, deduped: true };
      }
    }
    throw error;
  }
}

function listInspections({ severity, status, from, to, sort, order } = {}) {
  const where = [];
  const params = {};
  if (severity) {
    where.push('severity = @severity');
    params.severity = severity;
  }
  if (status) {
    where.push('status = @status');
    params.status = status;
  }
  if (from) {
    where.push('inspection_date >= @from');
    params.from = from;
  }
  if (to) {
    where.push('inspection_date <= @to');
    params.to = to;
  }

  const sortKey = SORTS[sort] ? sort : 'inspectionDate';
  const direction = order === 'asc' || order === 'desc'
    ? order.toUpperCase()
    : (sortKey === 'inspectionDate' ? 'DESC' : 'ASC');

  const sql = `
    SELECT * FROM inspections
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${SORTS[sortKey]} ${direction}, id DESC
  `;
  return db.prepare(sql).all(params).map(mapInspection);
}

function resolveInspection(id, resolutionNote, resolvedAt) {
  const result = db.prepare(`
    UPDATE inspections
    SET status = 'Resolved',
        resolution_note = @resolutionNote,
        resolved_at = @resolvedAt
    WHERE id = @id AND status = 'Open'
  `).run({ id, resolutionNote, resolvedAt });
  return result.changes > 0 ? findById(id) : null;
}

function summary() {
  const rows = db.prepare(`
    SELECT severity,
           SUM(CASE WHEN status = 'Open' THEN 1 ELSE 0 END) AS open_count,
           SUM(CASE WHEN status = 'Resolved' THEN 1 ELSE 0 END) AS resolved_count
    FROM inspections
    GROUP BY severity
  `).all();
  const bySeverity = new Map(rows.map((row) => [row.severity, row]));
  const severities = SEVERITIES.map((severity) => {
    const row = bySeverity.get(severity);
    return {
      severity,
      open: row ? Number(row.open_count) : 0,
      resolved: row ? Number(row.resolved_count) : 0,
    };
  });
  const totals = severities.reduce(
    (acc, row) => {
      acc.open += row.open;
      acc.resolved += row.resolved;
      return acc;
    },
    { open: 0, resolved: 0 }
  );
  return { severities, totals };
}

function close() {
  db.close();
}

module.exports = {
  SEVERITIES,
  DEFECT_TYPES,
  STATUSES,
  SORTS,
  DUMMY_PASSWORD_HASH,
  verifyPassword,
  findUserByUsername,
  findByClientUuid,
  findBySapReference,
  findById,
  insertInspection,
  listInspections,
  resolveInspection,
  summary,
  close,
};
