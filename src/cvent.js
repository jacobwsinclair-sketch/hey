// Cvent REST API client (https://developers.cvent.com).
//
// Everything Cvent-specific lives in this file so it can be adjusted to match your account.
// Cvent's API paths, payload shapes and OAuth scopes depend on your Cvent API subscription —
// confirm each call below against the API reference in your Cvent developer portal before go-live.
//
// CVENT_MODE=off disables all API calls: attendees are simply redirected to the event's Cvent
// registration URL and registrations are confirmed by hand in the admin screen. Useful for
// local testing and as a fallback if API access isn't set up yet.

const BASE_URLS = {
  na: 'https://api-platform.cvent.com',
  eu: 'https://api-platform-eur.cvent.com',
};

// Cvent attendee statuses mapped to our registration statuses. Anything not listed is left alone.
const STATUS_MAP = {
  Accepted: 'confirmed',
  Attended: 'confirmed',
  Cancelled: 'cancelled',
  Declined: 'cancelled',
};

class CventClient {
  constructor({ mode, region, clientId, clientSecret, scope, inviteeStatus, fetchImpl } = {}) {
    this.mode = mode || 'off';
    this.base = BASE_URLS[region] || region || BASE_URLS.na;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.scope = scope;
    this.inviteeStatus = inviteeStatus || null;
    this.fetch = fetchImpl || globalThis.fetch;
    this.token = null;
    this.tokenExpires = 0;
  }

  get enabled() {
    return this.mode === 'api';
  }

  async accessToken() {
    if (this.token && Date.now() < this.tokenExpires - 60_000) return this.token;
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: this.clientId });
    if (this.scope) body.set('scope', this.scope);
    const res = await this.fetch(`${this.base}/ea/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!res.ok) throw new Error(`Cvent auth failed (${res.status}): ${await res.text()}`);
    const json = await res.json();
    this.token = json.access_token;
    this.tokenInfo = { scope: json.scope, expiresIn: json.expires_in, tokenType: json.token_type };
    this.tokenExpires = Date.now() + (json.expires_in || 3600) * 1000;
    return this.token;
  }

  async request(method, path, body) {
    const res = await this.fetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`Cvent ${method} ${path} failed (${res.status}): ${text}`);
      err.status = res.status;
      err.body = text;
      throw err;
    }
    return text ? JSON.parse(text) : null;
  }

  // Cvent's create endpoints ("Create Contacts", etc.) generally take a list of records, even
  // for one. Send a one-item list; if Cvent can't read that body, retry with a single object.
  // Remembers which form worked per path (see bodyForms) so later calls go straight to it.
  async createOne(path, item) {
    this.bodyForms = this.bodyForms || {};
    const form = this.bodyForms[path] || 'list';
    try {
      const created = unwrapCreated(await this.request('POST', path, form === 'list' ? [item] : item), path);
      this.bodyForms[path] = form;
      return created;
    } catch (err) {
      const unreadable = err.status === 400 && /request body|valid json|deserializ|cannot.*array/i.test(err.body || '');
      if (this.bodyForms[path] || !unreadable) throw err;
      const created = unwrapCreated(await this.request('POST', path, item), path);
      this.bodyForms[path] = 'object';
      return created;
    }
  }

  // Create the person in Cvent as an invitee of the event, tagged with their Local, and
  // return what we need to send them on to Cvent's registration/payment pages.
  async createAttendee(event, reg, localName) {
    const contact = await this.findOrCreateContact({
      firstName: reg.first_name,
      lastName: reg.last_name,
      email: reg.email,
      ...(reg.phone ? { mobilePhone: reg.phone } : {}),
    });

    const attendee = {
      event: { id: event.cvent_event_id },
      contact: { id: contact.id },
    };
    if (event.cvent_local_question_id) {
      attendee.answers = [{ question: { id: event.cvent_local_question_id }, value: [localName] }];
    }
    let created;
    try {
      created = await this.createInvitee(attendee);
    } catch (err) {
      // Already on this event (e.g. they started before and came back): reuse that record.
      if (!isDuplicate(err)) throw err;
      created = await this.findOne('/ea/attendees',
        `event.id eq '${q(event.cvent_event_id)}' and contact.id eq '${q(contact.id)}'`, err);
    }

    return {
      contactId: contact.id,
      attendeeId: created.id,
      link: findRegistrationLink(created),
      raw: { contact, attendee: created },
    };
  }

  // Most members are already in the Cvent address book from past events, and Cvent refuses a
  // second contact with the same email. In that case, use the existing contact.
  async findOrCreateContact(fields) {
    try {
      return await this.createOne('/ea/contacts', fields);
    } catch (err) {
      if (!isDuplicate(err)) throw err;
      return this.findOne('/ea/contacts', `email eq '${q(fields.email)}'`, err);
    }
  }

  // First record matching a filter, or rethrow `original` if there's none.
  async findOne(path, filter, original) {
    const page = await this.request('GET', `${path}?${new URLSearchParams({ filter, limit: '1' })}`);
    const found = page && (Array.isArray(page) ? page[0] : page.data && page.data[0]);
    if (!found || !found.id) throw original;
    return found;
  }

  // Add the person to the event as an invitee who hasn't registered yet. Cvent calls that status
  // "No Response" ("Invited" is rejected). The exact spelling the API wants isn't documented
  // publicly, so try the likely spellings and remember the one Cvent accepts. Never let Cvent
  // default the status: "Accepted" would count them as registered before they've paid.
  async createInvitee(attendee) {
    const candidates = this.inviteeStatus ? [this.inviteeStatus] : ['No Response', 'NoResponse'];
    let lastErr;
    for (const status of candidates) {
      try {
        const created = await this.createOne('/ea/attendees', { ...attendee, status });
        this.inviteeStatus = status;
        return created;
      } catch (err) {
        if (!(err.status === 400 && /invalid value/i.test(err.body || ''))) throw err;
        lastErr = err;
      }
    }
    throw lastErr;
  }

  // All attendees for an event (handles paging).
  async listAttendees(cventEventId) {
    const out = [];
    let token;
    do {
      const qs = new URLSearchParams({ filter: `event.id eq '${cventEventId}'`, limit: '200' });
      if (token) qs.set('token', token);
      const page = await this.request('GET', `/ea/attendees?${qs}`);
      out.push(...(page.data || []));
      token = page.paging && page.paging.nextToken;
    } while (token);
    return out;
  }
}

const isDuplicate = (err) => /duplicate|already exists/i.test(`${err.body || ''} ${err.message}`);
// Quote a value inside a Cvent filter string.
const q = (v) => String(v).replace(/'/g, "''");

// Pull the created record out of Cvent's reply, whether it's the record itself, a list of
// records, or the record wrapped in `data`.
// List replies carry a status per record, so a 200 reply can still hold a failed record:
// that is raised as an error with the record's own status and message.
function unwrapCreated(reply, path) {
  let r = reply;
  if (Array.isArray(r)) r = r[0];
  else if (r && Array.isArray(r.data)) r = r.data[0];
  if (r && typeof r.status === 'number' && r.status >= 400) {
    const detail = (r.data && r.data.message) || r.message || 'unknown error';
    const err = new Error(`Cvent POST ${path} failed (${r.status}): ${detail}`);
    err.status = r.status;
    err.body = JSON.stringify(r);
    throw err;
  }
  if (r && !r.id && r.data && typeof r.data === 'object' && !Array.isArray(r.data)) r = r.data;
  if (!r || !r.id) {
    throw new Error(`Cvent POST ${path} succeeded but no ID was found in the reply: ${JSON.stringify(reply)}`);
  }
  return r;
}

// Cvent can return a personalised registration link for an invitee; field names vary by API
// version, so check the likely spots.
function findRegistrationLink(attendee) {
  if (!attendee) return null;
  const candidates = [
    attendee.registrationLink,
    attendee.registrationUrl,
    attendee.links && attendee.links.registration && attendee.links.registration.href,
    attendee._links && attendee._links.registration && attendee._links.registration.href,
    attendee.links && attendee.links.invitation && attendee.links.invitation.href,
  ];
  return candidates.find((u) => typeof u === 'string' && /^https?:\/\//.test(u)) || null;
}

// Build the URL we send the attendee to. An event's redirect template may use
// {link} {attendeeId} {contactId} {email} {firstName} {lastName} {local} {cventEventId} {token}.
// Without a template we use Cvent's personalised link if we got one, else the event's reg URL.
function buildRedirectUrl(event, reg, localName, cventResult = {}) {
  const template = event.redirect_template || (cventResult.link ? '{link}' : event.cvent_registration_url);
  if (!template) return null;
  const values = {
    link: cventResult.link || event.cvent_registration_url || '',
    attendeeId: cventResult.attendeeId || '',
    contactId: cventResult.contactId || '',
    email: reg.email,
    firstName: reg.first_name,
    lastName: reg.last_name,
    local: localName,
    cventEventId: event.cvent_event_id || '',
    token: reg.token,
  };
  // {link} is a full URL and is inserted as-is; everything else is URL-encoded.
  return template.replace(/\{(\w+)\}/g, (m, key) =>
    key in values ? (key === 'link' ? values[key] : encodeURIComponent(values[key])) : m);
}

module.exports = { CventClient, STATUS_MAP, buildRedirectUrl, findRegistrationLink };
