const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const layout = (title, body, { admin = false } = {}) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/style.css">
</head>
<body class="${admin ? 'admin' : ''}">
<main>
${body}
</main>
</body>
</html>`;

const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' }) : '');

// ---------- public ----------

function registrationForm(event, locals, { error, values = {} } = {}) {
  const anyOpen = locals.some((l) => l.remaining > 0);
  const options = locals.map((l) => {
    const full = l.remaining <= 0;
    const selected = String(values.local_id) === String(l.id) ? ' selected' : '';
    return `<option value="${l.id}"${full ? ' disabled' : ''}${selected}>${esc(l.name)}${full ? ' — full' : ''}</option>`;
  }).join('');

  return layout(event.name, `
<h1>${esc(event.name)}</h1>
<p class="lead">Register below. Each Union Local has a limited number of spots. Once your spot is reserved you'll
continue to Cvent to complete payment.</p>
${error ? `<p class="alert">${esc(error)}</p>` : ''}
${!event.is_open ? '<p class="alert">Registration for this event is closed.</p>' :
  !anyOpen ? '<p class="alert">All Locals have reached their limit for this event.</p>' : `
<form method="post" class="card">
  <label>Union Local
    <select name="local_id" required>
      <option value="">Select your Local…</option>
      ${options}
    </select>
  </label>
  <div class="row">
    <label>First name <input name="first_name" required maxlength="100" autocomplete="given-name" value="${esc(values.first_name)}"></label>
    <label>Last name <input name="last_name" required maxlength="100" autocomplete="family-name" value="${esc(values.last_name)}"></label>
  </div>
  <label>Email <input type="email" name="email" required maxlength="200" autocomplete="email" value="${esc(values.email)}"></label>
  <div class="row">
    <label>Phone <input type="tel" name="phone" maxlength="40" autocomplete="tel" value="${esc(values.phone)}"></label>
    <label>Member number <span class="muted">(optional)</span> <input name="member_number" maxlength="60" value="${esc(values.member_number)}"></label>
  </div>
  <button type="submit">Reserve my spot &amp; continue to payment</button>
  <p class="muted small">Your spot is held for ${event.hold_minutes} minutes while you complete payment in Cvent.</p>
</form>`}`);
}

function handoffPage(event, reg) {
  // Shown only if the redirect could not be issued automatically (e.g. no Cvent URL configured).
  return layout(event.name, `
<h1>${esc(event.name)}</h1>
<div class="card">
  <p>Your spot is reserved, ${esc(reg.first_name)}.</p>
  ${reg.redirect_url
    ? `<p><a class="button" href="${esc(reg.redirect_url)}">Continue to payment</a></p>`
    : '<p class="alert">The payment page is not configured yet. Please contact the event organiser.</p>'}
</div>`);
}

function notFound() {
  return layout('Not found', '<h1>Not found</h1><p>This registration page does not exist.</p>');
}

// ---------- admin ----------

function adminHome(events) {
  const rows = events.map((e) => `
    <tr>
      <td><a href="/admin/events/${e.id}">${esc(e.name)}</a></td>
      <td><a href="/e/${esc(e.slug)}">/e/${esc(e.slug)}</a></td>
      <td>${e.is_open ? 'Open' : 'Closed'}</td>
    </tr>`).join('');
  return layout('Admin', `
<h1>Events</h1>
<table><thead><tr><th>Event</th><th>Public link</th><th>Status</th></tr></thead>
<tbody>${rows || '<tr><td colspan="3" class="muted">No events yet.</td></tr>'}</tbody></table>
<h2>New event</h2>
${eventForm({}, '/admin/events')}`, { admin: true });
}

function eventForm(e, action) {
  return `
<form method="post" action="${action}" class="card">
  <div class="row">
    <label>Event name <input name="name" required value="${esc(e.name)}"></label>
    <label>URL slug <input name="slug" required pattern="[a-zA-Z0-9-]+" value="${esc(e.slug)}"></label>
  </div>
  <div class="row">
    <label>Cvent event ID <input name="cvent_event_id" value="${esc(e.cvent_event_id)}"></label>
    <label>Hold minutes <input type="number" name="hold_minutes" min="5" value="${esc(e.hold_minutes ?? 30)}"></label>
  </div>
  <label>Cvent registration URL <input type="url" name="cvent_registration_url" value="${esc(e.cvent_registration_url)}"></label>
  <label>Redirect template <span class="muted">(optional, see README)</span>
    <input name="redirect_template" placeholder="{link}" value="${esc(e.redirect_template)}"></label>
  <label>Cvent "Union Local" question ID <span class="muted">(optional)</span>
    <input name="cvent_local_question_id" value="${esc(e.cvent_local_question_id)}"></label>
  <label class="check"><input type="checkbox" name="is_open" ${e.is_open === 0 ? '' : 'checked'}> Registration open</label>
  <button type="submit">Save event</button>
</form>`;
}

function adminEvent(event, locals, regs, { flash, cventEnabled }) {
  const localRows = locals.map((l) => {
    const over = l.confirmed + l.held > l.capacity;
    return `
    <tr class="${over ? 'over' : ''}">
      <td>${esc(l.name)}</td>
      <td>
        <form method="post" action="/admin/events/${event.id}/locals" class="inline">
          <input type="hidden" name="name" value="${esc(l.name)}">
          <input type="number" name="capacity" min="0" value="${l.capacity}" class="narrow">
          <button class="small">Save</button>
        </form>
      </td>
      <td>${l.confirmed}</td><td>${l.held}</td>
      <td>${over ? '<strong>Over by ' + (l.confirmed + l.held - l.capacity) + '</strong>' : l.remaining}</td>
      <td><form method="post" action="/admin/locals/${l.id}/delete" class="inline"
            onsubmit="return confirm('Delete this Local?')"><button class="small link">Delete</button></form></td>
    </tr>`;
  }).join('');

  const regRows = regs.map((r) => `
    <tr class="status-${r.status}">
      <td>${esc(r.first_name)} ${esc(r.last_name)}</td>
      <td>${esc(r.email)}</td>
      <td>${esc(r.local_name)}</td>
      <td>${r.status}${r.status === 'held' ? `<br><span class="muted small">until ${fmtTime(r.expires_at)}</span>` : ''}</td>
      <td>${esc(r.cvent_status || '')}</td>
      <td>${fmtTime(r.created_at)}</td>
      <td class="actions">
        ${r.status !== 'confirmed' ? `<form method="post" action="/admin/registrations/${r.id}/status" class="inline">
          <input type="hidden" name="status" value="confirmed"><button class="small">Confirm</button></form>` : ''}
        ${r.status !== 'cancelled' ? `<form method="post" action="/admin/registrations/${r.id}/status" class="inline">
          <input type="hidden" name="status" value="cancelled"><button class="small link">Cancel</button></form>` : ''}
      </td>
    </tr>`).join('');

  return layout(`${event.name} — Admin`, `
<p><a href="/admin">← All events</a></p>
<h1>${esc(event.name)}</h1>
<p>Public registration link: <a href="/e/${esc(event.slug)}">/e/${esc(event.slug)}</a></p>
${flash ? `<p class="notice">${esc(flash)}</p>` : ''}

<h2>Union Locals</h2>
<table>
  <thead><tr><th>Local</th><th>Limit</th><th>Confirmed</th><th>Held</th><th>Remaining</th><th></th></tr></thead>
  <tbody>${localRows || '<tr><td colspan="6" class="muted">No Locals yet — add some below.</td></tr>'}</tbody>
</table>
<form method="post" action="/admin/events/${event.id}/locals/bulk" class="card">
  <label>Add or update Locals <span class="muted">— one per line: <code>Local name, limit</code></span>
    <textarea name="lines" rows="5" placeholder="Local 183, 10&#10;Local 506, 5"></textarea></label>
  <button type="submit">Save Locals</button>
</form>

<h2>Registrations</h2>
<p>
  <a class="button" href="/admin/events/${event.id}/export.csv">Export CSV</a>
  ${cventEnabled ? `<form method="post" action="/admin/events/${event.id}/sync" class="inline"><button>Sync with Cvent now</button></form>` : ''}
</p>
<table>
  <thead><tr><th>Name</th><th>Email</th><th>Local</th><th>Status</th><th>Cvent status</th><th>Started</th><th></th></tr></thead>
  <tbody>${regRows || '<tr><td colspan="7" class="muted">No registrations yet.</td></tr>'}</tbody>
</table>

<h2>Event settings</h2>
${eventForm(event, `/admin/events/${event.id}`)}`, { admin: true });
}

module.exports = { esc, layout, registrationForm, handoffPage, notFound, adminHome, adminEvent };
