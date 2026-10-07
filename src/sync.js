const { STATUS_MAP } = require('./cvent');

// Pull attendee statuses from Cvent and update our registrations, then expire stale holds.
// Runs on a timer, when Cvent calls our webhook, and from the admin "Sync now" button.
async function syncEvent(db, cvent, event) {
  if (!cvent.enabled || !event.cvent_event_id) return { updated: 0 };
  const attendees = await cvent.listAttendees(event.cvent_event_id);
  const byId = new Map();
  const byEmail = new Map();
  for (const a of attendees) {
    if (a.id) byId.set(a.id, a);
    const email = a.contact && a.contact.email;
    if (email) byEmail.set(email.toLowerCase(), a);
  }

  let updated = 0;
  for (const reg of db.listRegistrations(event.id)) {
    const a = (reg.cvent_attendee_id && byId.get(reg.cvent_attendee_id)) || byEmail.get(reg.email);
    if (!a) continue;
    const next = STATUS_MAP[a.status];
    // A hold that expired but was then paid for in Cvent still becomes confirmed —
    // the person has paid, so the admin screen flags the Local as over capacity instead.
    if (next && next !== reg.status && !(reg.status === 'cancelled' && next === 'cancelled')) {
      db.setStatus(reg.id, next, a.status);
      updated++;
    } else if (a.status !== reg.cvent_status) {
      db.setStatus(reg.id, reg.status, a.status);
    }
    if (!reg.cvent_attendee_id && a.id) db.setCventIds(reg.id, { attendeeId: a.id });
  }
  return { updated };
}

async function syncAll(db, cvent, log = console) {
  for (const event of db.listEvents()) {
    try {
      const { updated } = await syncEvent(db, cvent, event);
      if (updated) log.info(`[sync] ${event.slug}: ${updated} registration(s) updated from Cvent`);
    } catch (err) {
      log.error(`[sync] ${event.slug}: ${err.message}`);
    }
  }
  const expired = db.expireHolds();
  if (expired) log.info(`[sync] released ${expired} expired hold(s)`);
}

module.exports = { syncEvent, syncAll };
