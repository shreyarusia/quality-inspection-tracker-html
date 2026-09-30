# Quality Inspection Tracker

Shop-floor supervisors log fabric defects from a phone browser instead of a paper register. The app stores inspections in a local SQLite database and can be used when the line drops offline.

## Setup

Requires Node.js 18 or newer.

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000). On a phone, use the same URL from the computer’s LAN address if you want to try it on a device (`http://<your-ip>:3000`).

Sign in with:

- Username: `supervisor`
- Password: `shopfloor`

The first launch creates `data/inspections.db` and loads a few sample inspections so the list and summary are not empty. Delete that file and start the server again to reset it.

Optional checks:

```bash
npm test
```

## What you can do

- Log a defect with date, machine / line ID, defect type, severity, and optional remarks.
- Filter the list by status, severity, and date range, and sort it.
- Mark an open inspection resolved. A resolution note is required.
- Read open and resolved counts by severity on the Summary tab.

The layout is built for a phone. Check it at 390px width.

## Offline

The page, styles, and script are cached by a service worker on localhost (or HTTPS). After you have signed in once:

1. Turn the network off (or set the browser to Offline).
2. Log an inspection. It stays on the phone and shows **Pending sync**.
3. Turn the network back on. The app posts the queued inspection. Resolving an inspection offline is queued the same way.

Signing in the first time needs a connection. Repeat posts use a client id, so a retry does not create a duplicate.

## API

All routes except health, login, and the SAP webhook require:

```
Authorization: Bearer <token>
```

The token comes from `POST /api/auth/login` and lasts 7 days. Override the signing secret with `JWT_SECRET` if anyone else can reach the server.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness check |
| `POST` | `/api/auth/login` | `{ "username", "password" }` → `{ token, user }` |
| `GET` | `/api/auth/me` | Current supervisor |
| `GET` | `/api/inspections` | List. Query: `severity`, `status`, `from`, `to`, `sort`, `order` |
| `POST` | `/api/inspections` | Create an inspection |
| `PATCH` | `/api/inspections/:id/resolve` | `{ "resolutionNote" }` |
| `GET` | `/api/summary` | Open and resolved counts by severity |
| `POST` | `/api/sap-webhook` | Create an inspection from a mock SAP payload |

`sort` is one of `inspectionDate`, `severity`, `status`, `machineLineId`. `order` is `asc` or `desc`. Dates are `YYYY-MM-DD` and the range is inclusive.

Defect types: `Weave Defect`, `Shade Variation`, `Hole/Tear`, `Count Deviation`, `Other`.

Severities: `Critical`, `Major`, `Minor`. Statuses: `Open`, `Resolved`.

### Create an inspection

```bash
curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"supervisor","password":"shopfloor"}'
```

```bash
curl -s -X POST http://localhost:3000/api/inspections \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "inspectionDate": "2026-09-30",
    "machineLineId": "GJ-SUR-L04",
    "defectType": "Weave Defect",
    "severity": "Major",
    "remarks": "Broken warp near the selvedge"
  }'
```

`clientUuid` is optional. Send the same UUID again to retry a create without inserting a second row.

### SAP webhook

`POST /api/sap-webhook` does not use the supervisor session. Send header `X-SAP-Token: sap-demo-token` (override with `SAP_WEBHOOK_TOKEN`).

```json
{
  "inspectionDate": "2026-09-30",
  "machineLineId": "MH-PUN-L02",
  "defectType": "Shade Variation",
  "severity": "Critical",
  "remarks": "Optional note from SAP QM",
  "sapReference": "QM-44921"
}
```

`inspectionDate` may be a date or a date-time; only the calendar date is stored. `remarks` and `sapReference` are optional. Sending the same `sapReference` again returns the existing inspection instead of creating another one. New rows are `Open` and show an SAP badge in the list.

```bash
curl -s -X POST http://localhost:3000/api/sap-webhook \
  -H 'Content-Type: application/json' \
  -H 'X-SAP-Token: sap-demo-token' \
  -d '{
    "inspectionDate": "2026-09-30",
    "machineLineId": "MH-PUN-L02",
    "defectType": "Shade Variation",
    "severity": "Critical",
    "remarks": "Auto-created from SAP QM",
    "sapReference": "QM-44921"
  }'
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `JWT_SECRET` | a local dev secret | Signs session tokens |
| `SAP_WEBHOOK_TOKEN` | `sap-demo-token` | Shared secret for the webhook |
| `DB_PATH` | `data/inspections.db` | SQLite file |

## Project layout

```
server.js          Express routes
db.js              SQLite schema, queries, sample data
public/            HTML, CSS, and client script
public/sw.js       Offline cache
test/api.test.js   API checks
```
