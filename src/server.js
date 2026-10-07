require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { CventClient } = require('./cvent');
const { createApp } = require('./app');
const { syncAll } = require('./sync');

const env = process.env;
if (!env.ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD must be set (see .env.example).');
  process.exit(1);
}

const dbFile = env.DATABASE_FILE || path.join(__dirname, '..', 'data', 'registrations.db');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const store = db.open(dbFile);

const cvent = new CventClient({
  mode: env.CVENT_MODE,
  region: env.CVENT_REGION,
  clientId: env.CVENT_CLIENT_ID,
  clientSecret: env.CVENT_CLIENT_SECRET,
  scope: env.CVENT_SCOPE,
  inviteeStatus: env.CVENT_INVITEE_STATUS,
});
if (cvent.enabled && (!env.CVENT_CLIENT_ID || !env.CVENT_CLIENT_SECRET)) {
  console.error('CVENT_MODE=api requires CVENT_CLIENT_ID and CVENT_CLIENT_SECRET.');
  process.exit(1);
}

const app = createApp({ db: store, cvent, adminPassword: env.ADMIN_PASSWORD, webhookSecret: env.WEBHOOK_SECRET });

const port = Number(env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Registration site on http://localhost:${port}  (admin: /admin, Cvent mode: ${cvent.mode})`);
});

// Confirm paid registrations from Cvent and release expired holds on a timer.
const everyMs = (Number(env.SYNC_INTERVAL_MINUTES) || 2) * 60 * 1000;
let running = false;
setInterval(async () => {
  if (running) return;
  running = true;
  try { await syncAll(store, cvent); } finally { running = false; }
}, everyMs);
