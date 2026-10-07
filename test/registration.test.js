const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { CventClient, buildRedirectUrl } = require('../src/cvent');
const { createApp } = require('../src/app');
const { syncEvent } = require('../src/sync');

const silent = { info() {}, error() {} };
const person = (n) => ({ first_name: 'Pat', last_name: `Member${n}`, email: `pat${n}@example.com` });

function setup() {
  const store = db.open(':memory:');
  const id = store.createEvent({
    slug: 'convention', name: 'Convention', cvent_event_id: 'EVT-1',
    cvent_registration_url: 'https://cvent.example/reg', hold_minutes: 30, is_open: 'on',
  });
  store.upsertLocal(id, 'Local 183', 2);
  store.upsertLocal(id, 'Local 506', 1);
  const event = store.getEvent(id);
  const [l183, l506] = store.localsWithUsage(id);
  return { store, event, l183, l506 };
}

// Fake Cvent API: records created attendees and lets the test set their status.
// By default it behaves like Cvent's create endpoints: takes a list, replies with a list.
// With acceptList: false it only understands a single object, like the error seen in testing.
function fakeCvent({ failCreate = false, acceptList = true, validStatus = 'No Response', idOnlyReply = false } = {}) {
  const attendees = [];
  const contacts = [];
  const bodies = [];
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
    if (u.pathname === '/ea/oauth2/token') return json({ access_token: 't', expires_in: 3600 });
    if (opts.method === 'POST') {
      const raw = JSON.parse(opts.body);
      bodies.push({ path: u.pathname, list: Array.isArray(raw) });
      if (Array.isArray(raw) !== acceptList) {
        return json({ error: { code: 'Bad Request', message: 'An error occurred while processing your request body. Please ensure that it is valid JSON' } }, 400);
      }
      const body = Array.isArray(raw) ? raw[0] : raw;
      const reply = (rec) => json(Array.isArray(raw) ? [rec] : rec);
      if (u.pathname === '/ea/contacts') {
        if (contacts.some((c) => c.email === body.email)) {
          // What Cvent actually returned for an existing email: a 200 list with a failed record.
          return json([{ data: { code: 'Bad Request', message: 'Duplicate contact already exists', target: 'Contact' },
                         status: 400, message: 'Something went wrong while processing the entity.' }]);
        }
        const c = { id: `C${contacts.length + 1}`, ...body };
        contacts.push(c);
        return reply(c);
      }
      if (u.pathname === '/ea/attendees') {
        if (failCreate) return json({ message: 'boom' }, 500);
        if (body.status !== validStatus) {
          return json({ error: { code: 'Bad Request', message: `Invalid value: ${body.status}` } }, 400);
        }
        if (attendees.some((x) => x.contact.id === body.contact.id && x.event === body.event.id)) {
          return json([{ data: { message: 'Attendee already exists for this contact' }, status: 409, message: 'Duplicate' }]);
        }
        const a = { id: `A${attendees.length + 1}`, status: 'Invited', contact: { id: body.contact.id }, event: body.event.id,
                    _links: { registration: { href: `https://cvent.example/reg?i=A${attendees.length + 1}` } },
                    answers: body.answers };
        attendees.push(a);
        // Real Cvent replies with only the new ID; the link is on the full record.
        return reply(idOnlyReply ? { id: a.id } : a);
      }
    }
    if (u.pathname === '/ea/contacts') {
      const email = (u.searchParams.get('filter') || '').match(/email eq '(.*)'/)[1];
      return json({ data: contacts.filter((c) => c.email === email), paging: {} });
    }
    const one = u.pathname.match(/^\/ea\/attendees\/(.+)$/);
    if (one) {
      const a = attendees.find((x) => x.id === one[1]);
      return a ? json(a) : json({ error: 'not found' }, 404);
    }
    if (u.pathname === '/ea/attendees') {
      const m = (u.searchParams.get('filter') || '').match(/contact\.id eq '(.*)'/);
      return json({ data: m ? attendees.filter((a) => a.contact.id === m[1]) : attendees, paging: {} });
    }
    return json({}, 404);
  };
  return { client: new CventClient({ mode: 'api', clientId: 'id', clientSecret: 's', fetchImpl }), attendees, contacts, bodies };
}

async function withServer(app, fn) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

const post = (url, data, headers = {}) => fetch(url, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams(data),
});

test('a Local cannot exceed its limit', () => {
  const { store, event, l183 } = setup();
  assert.ok(store.reserveSpot(event, l183.id, person(1)).registration);
  assert.ok(store.reserveSpot(event, l183.id, person(2)).registration);
  const third = store.reserveSpot(event, l183.id, person(3));
  assert.match(third.error, /reached its limit of 2/);
});

test('same email does not take a second spot while the hold is live', () => {
  const { store, event, l183 } = setup();
  const first = store.reserveSpot(event, l183.id, person(1));
  const again = store.reserveSpot(event, l183.id, { ...person(1), email: 'PAT1@example.com ' });
  assert.equal(again.resumed, true);
  assert.equal(again.registration.id, first.registration.id);
  assert.equal(store.localsWithUsage(event.id)[0].held, 1);
});

test('confirmed email cannot register twice', () => {
  const { store, event, l183 } = setup();
  const { registration } = store.reserveSpot(event, l183.id, person(1));
  store.setStatus(registration.id, 'confirmed');
  assert.match(store.reserveSpot(event, l183.id, person(1)).error, /already registered/);
});

test('expired and cancelled holds free the spot', () => {
  const { store, event, l506 } = setup();
  const { registration } = store.reserveSpot(event, l506.id, person(1));
  assert.ok(store.reserveSpot(event, l506.id, person(2)).error);
  store.raw.prepare('UPDATE registrations SET expires_at = ? WHERE id = ?').run(Date.now() - 1, registration.id);
  assert.equal(store.expireHolds(), 1);
  const second = store.reserveSpot(event, l506.id, person(2));
  assert.ok(second.registration);
  store.release(second.registration.id);
  assert.ok(store.reserveSpot(event, l506.id, person(3)).registration);
});

test('register -> Cvent attendee created -> redirected to Cvent -> sync confirms', async () => {
  const { store, event, l183 } = setup();
  store.updateEvent(event.id, { ...event, cvent_local_question_id: 'Q-LOCAL', is_open: 1 });
  const cvent = fakeCvent();
  const app = createApp({ db: store, cvent: cvent.client, adminPassword: 'pw', log: silent });

  await withServer(app, async (base) => {
    const res = await post(`${base}/e/convention`, { local_id: l183.id, ...person(1) });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), 'https://cvent.example/reg?i=A1');
  });

  assert.deepEqual(cvent.attendees[0].answers, [{ question: { id: 'Q-LOCAL' }, value: ['Local 183'] }]);
  const [reg] = store.listRegistrations(event.id);
  assert.equal(reg.status, 'held');
  assert.equal(reg.cvent_attendee_id, 'A1');

  cvent.attendees[0].status = 'Accepted';
  const { updated } = await syncEvent(store, cvent.client, store.getEvent(event.id));
  assert.equal(updated, 1);
  assert.equal(store.getRegistration(reg.id).status, 'confirmed');
});

test('a full Local is rejected and shown as full', async () => {
  const { store, event, l506 } = setup();
  const app = createApp({ db: store, cvent: new CventClient({ mode: 'off' }), adminPassword: 'pw', log: silent });
  await withServer(app, async (base) => {
    const ok = await post(`${base}/e/convention`, { local_id: l506.id, ...person(1) });
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.get('location'), 'https://cvent.example/reg');
    const full = await post(`${base}/e/convention`, { local_id: l506.id, ...person(2) });
    assert.equal(full.status, 409);
    assert.match(await full.text(), /Local 506 has reached its limit/);
    const page = await (await fetch(`${base}/e/convention`)).text();
    assert.match(page, /disabled>Local 506 — full/);
  });
});

test('if Cvent fails the spot is released', async () => {
  const { store, event, l506 } = setup();
  const app = createApp({ db: store, cvent: fakeCvent({ failCreate: true }).client, adminPassword: 'pw', log: silent });
  await withServer(app, async (base) => {
    const res = await post(`${base}/e/convention`, { local_id: l506.id, ...person(1) });
    assert.equal(res.status, 502);
  });
  assert.equal(store.localsWithUsage(event.id).find((l) => l.id === l506.id).remaining, 1);
});

test('admin requires the password', async () => {
  const { store } = setup();
  const app = createApp({ db: store, cvent: new CventClient(), adminPassword: 'pw', log: silent });
  await withServer(app, async (base) => {
    assert.equal((await fetch(`${base}/admin`)).status, 401);
    const auth = { Authorization: 'Basic ' + Buffer.from('admin:pw').toString('base64') };
    assert.equal((await fetch(`${base}/admin`, { headers: auth })).status, 200);
  });
});

test('health check responds ok', async () => {
  const { store } = setup();
  const app = createApp({ db: store, cvent: new CventClient(), adminPassword: 'pw', log: silent });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
  });
});

test('redirect template fills placeholders', () => {
  const url = buildRedirectUrl(
    { redirect_template: 'https://cvent.example/r?email={email}&local={local}', cvent_event_id: 'E' },
    { email: 'a+b@x.com', first_name: 'A', last_name: 'B', token: 't' }, 'Local 1', {});
  assert.equal(url, 'https://cvent.example/r?email=a%2Bb%40x.com&local=Local%201');
});

test('cvent:check signs in, reads the event and reports the personal link', async () => {
  const { runCheck } = require('../src/cvent-check');
  const cvent = fakeCvent();
  const base = cvent.client.fetch;
  cvent.client.fetch = async (url, opts) => {
    if (new URL(url).pathname === '/ea/events/EVT-1') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'EVT-1', title: 'Convention' }) };
    }
    return base(url, opts);
  };
  const lines = [];
  const report = await runCheck(cvent.client, { eventId: 'EVT-1', testEmail: 't@example.com', questionId: 'Q1' },
    (l) => lines.push(l));
  assert.ok(report.steps.every((s) => s.ok), JSON.stringify(report.steps));
  assert.equal(report.steps.length, 4);
  assert.equal(report.steps[3].result.link, 'https://cvent.example/reg?i=A1');
  assert.equal(JSON.stringify(report).includes('access_token'), false);
  assert.ok(lines.some((l) => l.includes('Personal registration link: https://cvent.example/reg?i=A1')));
});

test('cvent:check stops cleanly when sign-in fails', async () => {
  const { runCheck } = require('../src/cvent-check');
  const client = new CventClient({ mode: 'api', clientId: 'x', clientSecret: 'y',
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'invalid_client' }) });
  const report = await runCheck(client, { eventId: 'EVT-1' }, () => {});
  assert.equal(report.steps.length, 1);
  assert.equal(report.steps[0].ok, false);
  assert.match(report.steps[0].error, /401/);
});

test('Cvent create calls send a list, and fall back to a single object if Cvent rejects the list', async () => {
  const listCvent = fakeCvent();
  const r1 = await listCvent.client.createAttendee({ cvent_event_id: 'E' }, person(1), 'Local 1');
  assert.equal(r1.attendeeId, 'A1');
  assert.equal(r1.link, 'https://cvent.example/reg?i=A1');
  assert.deepEqual(listCvent.bodies.map((b) => b.list), [true, true]);

  const objCvent = fakeCvent({ acceptList: false });
  const r2 = await objCvent.client.createAttendee({ cvent_event_id: 'E' }, person(1), 'Local 1');
  assert.equal(r2.contactId, 'C1');
  assert.equal(r2.attendeeId, 'A1');
  assert.deepEqual(objCvent.client.bodyForms, { '/ea/contacts': 'object', '/ea/attendees': 'object' });
  // Second registration goes straight to the form that worked.
  objCvent.bodies.length = 0;
  await objCvent.client.createAttendee({ cvent_event_id: 'E' }, person(2), 'Local 1');
  assert.deepEqual(objCvent.bodies.map((b) => b.list), [false, false]);
});

test('a Cvent reply without an ID is reported, not silently accepted', async () => {
  const client = new CventClient({ mode: 'api', clientId: 'x', clientSecret: 'y', fetchImpl: async (url) => {
    const body = new URL(url).pathname === '/ea/oauth2/token' ? { access_token: 't' } : [{ status: 'queued' }];
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  } });
  await assert.rejects(client.createOne('/ea/contacts', { email: 'a@b.c' }), /no ID was found in the reply/);
});

test('invitee status: uses "No Response", trying the other spelling if Cvent rejects it', async () => {
  const c1 = fakeCvent();
  await c1.client.createAttendee({ cvent_event_id: 'E' }, person(1), 'Local 1');
  assert.equal(c1.client.inviteeStatus, 'No Response');

  const c2 = fakeCvent({ validStatus: 'NoResponse' });
  const r = await c2.client.createAttendee({ cvent_event_id: 'E' }, person(1), 'Local 1');
  assert.equal(r.attendeeId, 'A1');
  assert.equal(c2.client.inviteeStatus, 'NoResponse');

  const c3 = fakeCvent({ validStatus: 'Something else' });
  await assert.rejects(c3.client.createAttendee({ cvent_event_id: 'E' }, person(1), 'Local 1'), /Invalid value: NoResponse/);
});

test('an email already in the Cvent address book reuses that contact', async () => {
  const c = fakeCvent();
  const first = await c.client.createAttendee({ cvent_event_id: 'E1' }, person(1), 'Local 1');
  const again = await c.client.createAttendee({ cvent_event_id: 'E2' }, person(1), 'Local 1');
  assert.equal(again.contactId, first.contactId);
  assert.equal(c.contacts.length, 1);
  assert.equal(c.attendees.length, 2);
});

test('a failed record inside a successful list reply is raised with its own message', () => {
  const client = new CventClient({ mode: 'api', clientId: 'x', clientSecret: 'y', fetchImpl: async (url) => {
    const body = new URL(url).pathname === '/ea/oauth2/token' ? { access_token: 't' }
      : [{ data: { message: 'Email is required' }, status: 422, message: 'Something went wrong' }];
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  } });
  return assert.rejects(client.createOne('/ea/contacts', {}), /failed \(422\): Email is required/);
});

test('a successful record wrapped as {data, status} is unwrapped', async () => {
  const client = new CventClient({ mode: 'api', clientId: 'x', clientSecret: 'y', fetchImpl: async (url) => {
    const body = new URL(url).pathname === '/ea/oauth2/token' ? { access_token: 't' }
      : [{ data: { id: 'C9', email: 'a@b.c' }, status: 201 }];
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  } });
  assert.equal((await client.createOne('/ea/contacts', { email: 'a@b.c' })).id, 'C9');
});

test('someone already on the event is reused, not added twice', async () => {
  const c = fakeCvent();
  const first = await c.client.createAttendee({ cvent_event_id: 'E1' }, person(1), 'Local 1');
  const again = await c.client.createAttendee({ cvent_event_id: 'E1' }, person(1), 'Local 1');
  assert.equal(again.attendeeId, first.attendeeId);
  assert.equal(again.link, first.link);
  assert.equal(c.attendees.length, 1);
});

test('when Cvent replies with only an ID, the personal link is read from the full record', async () => {
  const c = fakeCvent({ idOnlyReply: true });
  const r = await c.client.createAttendee({ cvent_event_id: 'E' }, person(1), 'Local 1');
  assert.equal(r.attendeeId, 'A1');
  assert.equal(r.link, 'https://cvent.example/reg?i=A1');
});

test('cvent:check --attendee shows one attendee record and its link', async () => {
  const { runCheck } = require('../src/cvent-check');
  const c = fakeCvent();
  await c.client.createAttendee({ cvent_event_id: 'E' }, person(1), 'Local 1');
  const lines = [];
  const report = await runCheck(c.client, { eventId: 'E', attendeeId: 'A1' }, (l) => lines.push(l));
  const step = report.steps.find((s) => s.name === 'Read attendee A1');
  assert.ok(step && step.ok);
  assert.ok(lines.some((l) => l.includes('Personal registration link: https://cvent.example/reg?i=A1')));
});

test('the personal link is read from webLinks.acceptRegistration, as Cvent returns it', () => {
  const { findRegistrationLink } = require('../src/cvent');
  // Shape copied from a live Cvent attendee record.
  const attendee = {
    id: '82873f4c', status: 'No Response',
    webLinks: {
      acceptRegistration: 'https://cvent.me/dRXBq4?i=TD-abc',
      declineRegistration: 'https://cvent.me/7Y0xRr?i=TD-abc',
    },
  };
  assert.equal(findRegistrationLink(attendee), 'https://cvent.me/dRXBq4?i=TD-abc');
});

test('cvent:check times each step and prompts to open the new link straight away', async () => {
  const { runCheck } = require('../src/cvent-check');
  const c = fakeCvent({ idOnlyReply: true });
  const lines = [];
  const report = await runCheck(c.client, { eventId: 'E', testEmail: 't@example.com' }, (l) => lines.push(l));
  assert.ok(report.steps.every((s) => typeof s.seconds === 'number'));
  assert.ok(lines.some((l) => l.includes('OPEN IT NOW')));
  assert.ok(lines.some((l) => l.includes('https://cvent.example/reg?i=A1')));
});
