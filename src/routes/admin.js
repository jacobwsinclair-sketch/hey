const express = require('express');
const crypto = require('crypto');
const views = require('../views');
const { syncEvent } = require('../sync');

// HTTP Basic auth with a single shared admin password (ADMIN_PASSWORD).
function basicAuth(password) {
  const expected = Buffer.from(String(password));
  return (req, res, next) => {
    const [scheme, encoded] = (req.headers.authorization || '').split(' ');
    const supplied = scheme === 'Basic' && encoded
      ? Buffer.from(Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':'))
      : Buffer.alloc(0);
    if (supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected)) return next();
    res.set('WWW-Authenticate', 'Basic realm="Registration admin"').status(401).send('Authentication required');
  };
}

const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

module.exports = function adminRoutes({ db, cvent, adminPassword }) {
  const router = express.Router();
  router.use(basicAuth(adminPassword));

  const loadEvent = (req, res) => {
    const event = db.getEvent(Number(req.params.id));
    if (!event) res.status(404).send(views.notFound());
    return event;
  };
  const back = (res, eventId, flash) =>
    res.redirect(303, `/admin/events/${eventId}${flash ? `?flash=${encodeURIComponent(flash)}` : ''}`);

  router.get('/', (req, res) => res.send(views.adminHome(db.listEvents())));

  router.post('/events', (req, res) => {
    try {
      const id = db.createEvent(req.body);
      back(res, id, 'Event created. Add your Union Locals and their limits below.');
    } catch (err) {
      res.status(400).send(views.layout('Error', `<p class="alert">${views.esc(err.message)}</p><a href="/admin">Back</a>`));
    }
  });

  router.get('/events/:id', (req, res) => {
    const event = loadEvent(req, res);
    if (!event) return;
    res.send(views.adminEvent(event, db.localsWithUsage(event.id), db.listRegistrations(event.id), {
      flash: req.query.flash, cventEnabled: cvent.enabled,
    }));
  });

  router.post('/events/:id', (req, res) => {
    const event = loadEvent(req, res);
    if (!event) return;
    try {
      db.updateEvent(event.id, req.body);
      back(res, event.id, 'Event saved.');
    } catch (err) {
      back(res, event.id, `Could not save: ${err.message}`);
    }
  });

  router.post('/events/:id/locals', (req, res) => {
    const event = loadEvent(req, res);
    if (!event) return;
    const capacity = parseInt(req.body.capacity, 10);
    if (!req.body.name || !(capacity >= 0)) return back(res, event.id, 'Enter a Local name and a limit of 0 or more.');
    db.upsertLocal(event.id, req.body.name, capacity);
    back(res, event.id, `${req.body.name} saved.`);
  });

  router.post('/events/:id/locals/bulk', (req, res) => {
    const event = loadEvent(req, res);
    if (!event) return;
    const bad = [];
    let saved = 0;
    for (const line of String(req.body.lines || '').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const m = line.match(/^(.*?)[,\t]\s*(\d+)\s*$/);
      if (!m || !m[1].trim()) { bad.push(line.trim()); continue; }
      db.upsertLocal(event.id, m[1], parseInt(m[2], 10));
      saved++;
    }
    back(res, event.id, `${saved} Local(s) saved.${bad.length ? ` Skipped (expected "Name, limit"): ${bad.join(' | ')}` : ''}`);
  });

  router.post('/locals/:id/delete', (req, res) => {
    const local = db.getLocal(Number(req.params.id));
    if (!local) return res.status(404).send(views.notFound());
    try {
      db.deleteLocal(local.id);
      back(res, local.event_id, `${local.name} deleted.`);
    } catch (err) {
      back(res, local.event_id, err.message);
    }
  });

  router.post('/registrations/:id/status', (req, res) => {
    const reg = db.getRegistration(Number(req.params.id));
    if (!reg) return res.status(404).send(views.notFound());
    if (!['confirmed', 'cancelled'].includes(req.body.status)) return back(res, reg.event_id, 'Invalid status.');
    db.setStatus(reg.id, req.body.status);
    back(res, reg.event_id, `${reg.first_name} ${reg.last_name} marked ${req.body.status}.`);
  });

  router.post('/events/:id/sync', async (req, res) => {
    const event = loadEvent(req, res);
    if (!event) return;
    try {
      const { updated } = await syncEvent(db, cvent, event);
      const expired = db.expireHolds();
      back(res, event.id, `Synced with Cvent: ${updated} updated, ${expired} expired hold(s) released.`);
    } catch (err) {
      back(res, event.id, `Cvent sync failed: ${err.message}`);
    }
  });

  router.get('/events/:id/export.csv', (req, res) => {
    const event = loadEvent(req, res);
    if (!event) return;
    const header = ['First name', 'Last name', 'Email', 'Phone', 'Member number', 'Local', 'Status',
      'Cvent status', 'Cvent attendee ID', 'Started', 'Confirmed'];
    const rows = db.listRegistrations(event.id).map((r) => [
      r.first_name, r.last_name, r.email, r.phone, r.member_number, r.local_name, r.status, r.cvent_status,
      r.cvent_attendee_id, new Date(r.created_at).toISOString(), r.confirmed_at ? new Date(r.confirmed_at).toISOString() : '',
    ]);
    res.type('text/csv').attachment(`${event.slug}-registrations.csv`)
      .send([header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n'));
  });

  return router;
};
