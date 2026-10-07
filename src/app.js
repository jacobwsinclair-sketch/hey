const path = require('path');
const crypto = require('crypto');
const express = require('express');
const views = require('./views');
const { syncAll } = require('./sync');

function createApp({ db, cvent, adminPassword, webhookSecret, log = console }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.urlencoded({ extended: false, limit: '50kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Health check for hosting platforms; also confirms the database is readable.
  app.get('/healthz', (req, res) => {
    db.raw.prepare('SELECT 1').get();
    res.type('text/plain').send('ok');
  });

  app.get('/', (req, res) => {
    const open = db.listEvents().filter((e) => e.is_open);
    res.send(views.layout('Event registration', `
<h1>Event registration</h1>
${open.length ? `<ul class="events">${open.map((e) =>
      `<li><a href="/e/${views.esc(e.slug)}">${views.esc(e.name)}</a></li>`).join('')}</ul>`
    : '<p>There are no events open for registration right now.</p>'}`));
  });

  app.use(require('./routes/public')({ db, cvent, log }));
  app.use('/admin', require('./routes/admin')({ db, cvent, adminPassword }));

  // Cvent webhook: point a Cvent webhook (e.g. on registration / attendee status change) at
  // /webhooks/cvent/<WEBHOOK_SECRET>. We don't trust the payload — it only triggers a sync,
  // which reads the real statuses back from the Cvent API.
  let syncing = null;
  app.post('/webhooks/cvent/:secret', express.json({ limit: '1mb' }), (req, res) => {
    const a = Buffer.from(String(req.params.secret));
    const b = Buffer.from(String(webhookSecret || ''));
    if (!webhookSecret || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.sendStatus(404);
    if (!syncing) syncing = syncAll(db, cvent, log).finally(() => { syncing = null; });
    res.sendStatus(202);
  });

  app.use((req, res) => res.status(404).send(views.notFound()));
  app.use((err, req, res, next) => {
    log.error(err);
    res.status(500).send(views.layout('Error', '<h1>Something went wrong</h1><p>Please try again.</p>'));
  });
  return app;
}

module.exports = { createApp };
