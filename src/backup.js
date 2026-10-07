// Safe online backup of the SQLite database (works while the site is running).
// Usage: node src/backup.js [destination]   (default: <db dir>/backup-YYYY-MM-DD.db)
require('dotenv').config();
const path = require('path');
const Database = require('better-sqlite3');

const source = process.env.DATABASE_FILE || path.join(__dirname, '..', 'data', 'registrations.db');
const dest = process.argv[2] || path.join(path.dirname(source), `backup-${new Date().toISOString().slice(0, 10)}.db`);

const db = new Database(source, { readonly: true, fileMustExist: true });
db.backup(dest)
  .then(() => console.log(`Backed up ${source} -> ${dest}`))
  .catch((err) => { console.error(`Backup failed: ${err.message}`); process.exitCode = 1; })
  .finally(() => db.close());
