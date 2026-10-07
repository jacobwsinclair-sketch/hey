const express = require('express');
const views = require('../views');
const { buildRedirectUrl } = require('../cvent');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = function publicRoutes({ db, cvent, log = console }) {
  const router = express.Router();

  router.get('/e/:slug', (req, res) => {
    const event = db.getEventBySlug(req.params.slug);
    if (!event) return res.status(404).send(views.notFound());
    res.send(views.registrationForm(event, db.localsWithUsage(event.id)));
  });

  router.post('/e/:slug', async (req, res) => {
    const event = db.getEventBySlug(req.params.slug);
    if (!event) return res.status(404).send(views.notFound());
    const values = req.body || {};
    const fail = (error, status = 400) =>
      res.status(status).send(views.registrationForm(event, db.localsWithUsage(event.id), { error, values }));

    if (!event.is_open) return fail('Registration for this event is closed.');
    for (const f of ['first_name', 'last_name', 'email', 'local_id']) {
      if (!String(values[f] || '').trim()) return fail('Please fill in all required fields.');
    }
    if (!EMAIL_RE.test(values.email.trim())) return fail('Please enter a valid email address.');

    const result = db.reserveSpot(event, Number(values.local_id), values);
    if (result.error) return fail(result.error, 409);
    let reg = result.registration;

    // Returning visitor with a live hold: send them straight back to their Cvent link.
    if (result.resumed) {
      return reg.redirect_url ? res.redirect(303, reg.redirect_url) : res.send(views.handoffPage(event, reg));
    }

    const local = db.getLocal(reg.local_id);
    try {
      let cventResult = {};
      if (cvent.enabled && event.cvent_event_id) {
        cventResult = await cvent.createAttendee(event, reg, local.name);
      }
      const redirectUrl = buildRedirectUrl(event, reg, local.name, cventResult);
      db.setCventIds(reg.id, { ...cventResult, redirectUrl });
      reg = db.getRegistration(reg.id);
    } catch (err) {
      log.error(`[register] ${event.slug}: Cvent hand-off failed for ${reg.email}: ${err.message}`);
      db.release(reg.id);
      return fail('We could not connect to the payment system. Your spot has not been reserved — please try again shortly.', 502);
    }

    if (reg.redirect_url) return res.redirect(303, reg.redirect_url);
    res.send(views.handoffPage(event, reg));
  });

  return router;
};
