const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { after, before, describe, it } = require('node:test');

const dbPath = path.join(os.tmpdir(), `qit-${process.pid}-${Date.now()}.db`);
process.env.NODE_ENV = 'test';
process.env.DB_PATH = dbPath;
process.env.JWT_SECRET = 'test-secret';
process.env.SAP_WEBHOOK_TOKEN = 'test-sap';

const { app, close } = require('../server');

let server;
let base;
let token;

async function request(pathname, { method = 'GET', body, auth = true, headers = {} } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

before(async () => {
  server = await new Promise((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await request('/api/auth/login', {
    method: 'POST',
    auth: false,
    body: { username: 'supervisor', password: 'shopfloor' },
  });
  assert.equal(login.status, 200);
  token = login.data.token;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  close();
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(dbPath + suffix, { force: true });
  }
});

describe('quality inspection API', () => {
  it('rejects unknown users and missing tokens', async () => {
    const health = await request('/api/health', { auth: false });
    assert.equal(health.status, 200);
    const denied = await request('/api/inspections', { auth: false });
    assert.equal(denied.status, 401);
    const badLogin = await request('/api/auth/login', {
      method: 'POST',
      auth: false,
      body: { username: 'supervisor', password: 'wrong' },
    });
    assert.equal(badLogin.status, 401);
  });

  it('logs, filters, sorts, and resolves an inspection', async () => {
    const created = await request('/api/inspections', {
      method: 'POST',
      body: {
        clientUuid: '11111111-1111-4111-8111-111111111111',
        inspectionDate: '2024-03-02',
        machineLineId: 'GJ-SUR-L04',
        defectType: 'weave defect',
        severity: 'major',
        remarks: 'Broken end',
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.inspection.defectType, 'Weave Defect');
    assert.equal(created.data.inspection.severity, 'Major');
    assert.equal(created.data.inspection.status, 'Open');

    const again = await request('/api/inspections', {
      method: 'POST',
      body: {
        clientUuid: '11111111-1111-4111-8111-111111111111',
        inspectionDate: '2024-03-02',
        machineLineId: 'GJ-SUR-L04',
        defectType: 'Weave Defect',
        severity: 'Major',
      },
    });
    assert.equal(again.status, 200);
    assert.equal(again.data.deduped, true);
    assert.equal(again.data.inspection.id, created.data.inspection.id);

    await request('/api/inspections', {
      method: 'POST',
      body: {
        inspectionDate: '2024-03-01',
        machineLineId: 'MH-PUN-L02',
        defectType: 'Hole/Tear',
        severity: 'Critical',
      },
    });

    const openMajor = await request('/api/inspections?severity=Major&status=Open&from=2024-03-01&to=2024-03-02&sort=inspectionDate&order=asc');
    assert.equal(openMajor.status, 200);
    assert.equal(openMajor.data.inspections.length, 1);
    assert.equal(openMajor.data.inspections[0].machineLineId, 'GJ-SUR-L04');

    const byDate = await request('/api/inspections?from=2024-03-01&to=2024-03-02&sort=inspectionDate&order=asc');
    assert.deepEqual(
      byDate.data.inspections.map((item) => item.inspectionDate),
      ['2024-03-01', '2024-03-02']
    );

    const missingNote = await request(`/api/inspections/${created.data.inspection.id}/resolve`, {
      method: 'PATCH',
      body: { resolutionNote: '   ' },
    });
    assert.equal(missingNote.status, 400);

    const resolved = await request(`/api/inspections/${created.data.inspection.id}/resolve`, {
      method: 'PATCH',
      body: { resolutionNote: 'End drawn in and the roll cleared.' },
    });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.data.inspection.status, 'Resolved');
    assert.equal(resolved.data.inspection.resolutionNote, 'End drawn in and the roll cleared.');

    const duplicate = await request(`/api/inspections/${created.data.inspection.id}/resolve`, {
      method: 'PATCH',
      body: { resolutionNote: 'Again' },
    });
    assert.equal(duplicate.status, 409);

    const summary = await request('/api/summary');
    const major = summary.data.severities.find((row) => row.severity === 'Major');
    const critical = summary.data.severities.find((row) => row.severity === 'Critical');
    assert.equal(major.resolved, 1);
    assert.equal(critical.open, 1);
    assert.equal(summary.data.totals.open + summary.data.totals.resolved, 2);
  });

  it('rejects an inverted date range and unknown defect types', async () => {
    const range = await request('/api/inspections?from=2024-04-02&to=2024-04-01');
    assert.equal(range.status, 400);
    const bad = await request('/api/inspections', {
      method: 'POST',
      body: {
        inspectionDate: '2024-04-02',
        machineLineId: 'L1',
        defectType: 'Stain',
        severity: 'Minor',
      },
    });
    assert.equal(bad.status, 400);
  });

  it('creates an inspection from the SAP webhook and ignores a repeated reference', async () => {
    const denied = await request('/api/sap-webhook', {
      method: 'POST',
      auth: false,
      body: {
        inspectionDate: '2024-05-01',
        machineLineId: 'MH-NGP-L07',
        defectType: 'Shade Variation',
        severity: 'Critical',
        sapReference: 'QM-1',
      },
    });
    assert.equal(denied.status, 401);

    const payload = {
      inspectionDate: '2024-05-01T09:30:00Z',
      machineLineId: 'MH-NGP-L07',
      defectType: 'Shade Variation',
      severity: 'Critical',
      remarks: 'Auto-created from SAP QM',
      sapReference: 'QM-10001',
    };
    const created = await request('/api/sap-webhook', {
      method: 'POST',
      auth: false,
      headers: { 'X-SAP-Token': 'test-sap' },
      body: payload,
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.inspection.source, 'sap');
    assert.equal(created.data.inspection.inspectionDate, '2024-05-01');
    assert.equal(created.data.inspection.sapReference, 'QM-10001');

    const repeat = await request('/api/sap-webhook', {
      method: 'POST',
      auth: false,
      headers: { 'X-SAP-Token': 'test-sap' },
      body: payload,
    });
    assert.equal(repeat.status, 200);
    assert.equal(repeat.data.deduped, true);
    assert.equal(repeat.data.inspection.id, created.data.inspection.id);
  });
});
