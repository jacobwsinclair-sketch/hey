const Database = require('better-sqlite3');
const crypto = require('crypto');

// Registration lifecycle:
//   held      -> spot reserved on our site, attendee sent to Cvent to pay (expires after hold_minutes)
//   confirmed -> Cvent reports the attendee as registered/paid (or an admin confirmed manually)
//   cancelled -> cancelled in Cvent or by an admin
//   expired   -> hold ran out before Cvent confirmed
// A spot counts against a Local's capacity while it is `confirmed` or an unexpired `held`.

function open(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      cvent_event_id TEXT,
      cvent_registration_url TEXT,
      redirect_template TEXT,
      cvent_local_question_id TEXT,
      hold_minutes INTEGER NOT NULL DEFAULT 30,
      is_open INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS locals (
      id INTEGER PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      capacity INTEGER NOT NULL CHECK (capacity >= 0),
      UNIQUE (event_id, name)
    );
    CREATE TABLE IF NOT EXISTS registrations (
      id INTEGER PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      local_id INTEGER NOT NULL REFERENCES locals(id),
      token TEXT NOT NULL UNIQUE,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      member_number TEXT,
      status TEXT NOT NULL CHECK (status IN ('held','confirmed','cancelled','expired')),
      cvent_contact_id TEXT,
      cvent_attendee_id TEXT,
      cvent_status TEXT,
      redirect_url TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      confirmed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_reg_local_status ON registrations(local_id, status);
    CREATE INDEX IF NOT EXISTS idx_reg_event_email ON registrations(event_id, email);
  `);
  return wrap(db);
}

function wrap(db) {
  const now = () => Date.now();

  const usedSql = `
    SELECT COUNT(*) AS n FROM registrations
    WHERE local_id = ? AND (status = 'confirmed' OR (status = 'held' AND expires_at > ?))`;

  const api = {
    raw: db,

    // ---- events ----
    listEvents: () => db.prepare('SELECT * FROM events ORDER BY created_at DESC').all(),
    getEvent: (id) => db.prepare('SELECT * FROM events WHERE id = ?').get(id),
    getEventBySlug: (slug) => db.prepare('SELECT * FROM events WHERE slug = ?').get(slug),
    createEvent(e) {
      const info = db.prepare(`
        INSERT INTO events (slug, name, cvent_event_id, cvent_registration_url, redirect_template,
                            cvent_local_question_id, hold_minutes, is_open)
        VALUES (@slug, @name, @cvent_event_id, @cvent_registration_url, @redirect_template,
                @cvent_local_question_id, @hold_minutes, @is_open)`).run(normalizeEvent(e));
      return info.lastInsertRowid;
    },
    updateEvent(id, e) {
      db.prepare(`
        UPDATE events SET slug=@slug, name=@name, cvent_event_id=@cvent_event_id,
          cvent_registration_url=@cvent_registration_url, redirect_template=@redirect_template,
          cvent_local_question_id=@cvent_local_question_id, hold_minutes=@hold_minutes, is_open=@is_open
        WHERE id=@id`).run({ ...normalizeEvent(e), id });
    },

    // ---- locals ----
    getLocal: (id) => db.prepare('SELECT * FROM locals WHERE id = ?').get(id),
    // Locals for an event with live usage counts.
    localsWithUsage(eventId) {
      return db.prepare(`
        SELECT l.*,
          SUM(CASE WHEN r.status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
          SUM(CASE WHEN r.status = 'held' AND r.expires_at > ? THEN 1 ELSE 0 END) AS held
        FROM locals l LEFT JOIN registrations r ON r.local_id = l.id
        WHERE l.event_id = ?
        GROUP BY l.id ORDER BY l.name COLLATE NOCASE`).all(now(), eventId)
        .map((l) => ({ ...l, confirmed: l.confirmed || 0, held: l.held || 0,
                       remaining: Math.max(0, l.capacity - (l.confirmed || 0) - (l.held || 0)) }));
    },
    upsertLocal(eventId, name, capacity) {
      db.prepare(`
        INSERT INTO locals (event_id, name, capacity) VALUES (?, ?, ?)
        ON CONFLICT (event_id, name) DO UPDATE SET capacity = excluded.capacity`)
        .run(eventId, name.trim(), capacity);
    },
    deleteLocal(id) {
      const used = db.prepare('SELECT COUNT(*) AS n FROM registrations WHERE local_id = ?').get(id).n;
      if (used > 0) throw new Error('This Local already has registrations; set its capacity to 0 instead.');
      db.prepare('DELETE FROM locals WHERE id = ?').run(id);
    },

    // ---- registrations ----
    // Atomically reserve a spot. better-sqlite3 is synchronous and the transaction is IMMEDIATE,
    // so two people can never both take the last spot.
    reserveSpot: db.transaction((event, localId, person) => {
      const local = db.prepare('SELECT * FROM locals WHERE id = ? AND event_id = ?').get(localId, event.id);
      if (!local) return { error: 'Please choose your Local.' };

      const email = person.email.trim().toLowerCase();
      const existing = db.prepare(`
        SELECT * FROM registrations
        WHERE event_id = ? AND email = ? AND (status = 'confirmed' OR (status = 'held' AND expires_at > ?))`)
        .get(event.id, email, now());
      if (existing && existing.status === 'confirmed') {
        return { error: 'This email address is already registered for this event.' };
      }
      if (existing) {
        // Same person coming back while their hold is still active: send them back to Cvent
        // rather than consuming a second spot.
        return { registration: existing, resumed: true };
      }

      const used = db.prepare(usedSql).get(local.id, now()).n;
      if (used >= local.capacity) {
        return { error: `Sorry, ${local.name} has reached its limit of ${local.capacity} attendee(s).` };
      }

      const t = now();
      const reg = {
        event_id: event.id,
        local_id: local.id,
        token: crypto.randomBytes(16).toString('hex'),
        first_name: person.first_name.trim(),
        last_name: person.last_name.trim(),
        email,
        phone: (person.phone || '').trim() || null,
        member_number: (person.member_number || '').trim() || null,
        created_at: t,
        expires_at: t + event.hold_minutes * 60 * 1000,
      };
      const info = db.prepare(`
        INSERT INTO registrations (event_id, local_id, token, first_name, last_name, email, phone,
                                   member_number, status, created_at, expires_at)
        VALUES (@event_id, @local_id, @token, @first_name, @last_name, @email, @phone,
                @member_number, 'held', @created_at, @expires_at)`).run(reg);
      return { registration: api.getRegistration(info.lastInsertRowid) };
    }).immediate,

    getRegistration: (id) => db.prepare('SELECT * FROM registrations WHERE id = ?').get(id),
    listRegistrations(eventId) {
      return db.prepare(`
        SELECT r.*, l.name AS local_name FROM registrations r JOIN locals l ON l.id = r.local_id
        WHERE r.event_id = ? ORDER BY r.created_at DESC`).all(eventId);
    },
    activeHeld(eventId) {
      return db.prepare(`SELECT * FROM registrations WHERE event_id = ? AND status = 'held'`).all(eventId);
    },
    setCventIds(id, { contactId, attendeeId, redirectUrl }) {
      db.prepare(`
        UPDATE registrations SET cvent_contact_id = COALESCE(?, cvent_contact_id),
          cvent_attendee_id = COALESCE(?, cvent_attendee_id), redirect_url = COALESCE(?, redirect_url)
        WHERE id = ?`).run(contactId ?? null, attendeeId ?? null, redirectUrl ?? null, id);
    },
    setStatus(id, status, cventStatus) {
      db.prepare(`
        UPDATE registrations SET status = ?, cvent_status = COALESCE(?, cvent_status),
          confirmed_at = CASE WHEN ? = 'confirmed' THEN COALESCE(confirmed_at, ?) ELSE confirmed_at END
        WHERE id = ?`).run(status, cventStatus ?? null, status, now(), id);
    },
    // Release the spot immediately (e.g. the Cvent hand-off failed).
    release(id) {
      db.prepare(`UPDATE registrations SET status = 'cancelled' WHERE id = ? AND status = 'held'`).run(id);
    },
    expireHolds() {
      return db.prepare(`UPDATE registrations SET status = 'expired' WHERE status = 'held' AND expires_at <= ?`)
        .run(now()).changes;
    },
  };
  return api;
}

function normalizeEvent(e) {
  const blank = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());
  return {
    slug: String(e.slug).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, ''),
    name: String(e.name).trim(),
    cvent_event_id: blank(e.cvent_event_id),
    cvent_registration_url: blank(e.cvent_registration_url),
    redirect_template: blank(e.redirect_template),
    cvent_local_question_id: blank(e.cvent_local_question_id),
    hold_minutes: Math.max(5, parseInt(e.hold_minutes, 10) || 30),
    is_open: e.is_open === true || e.is_open === 'on' || e.is_open === '1' || e.is_open === 1 ? 1 : 0,
  };
}

module.exports = { open };
