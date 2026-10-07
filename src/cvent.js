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
  constructor({ mode, region, clientId, clientSecret, scope, fetchImpl } = {}) {
    this.mode = mode || 'off';
    this.base = BASE_URLS[region] || region || BASE_URLS.na;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.scope = scope;
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
    const contact = await this.createOne('/ea/contacts', {
      firstName: reg.first_name,
      lastName: reg.last_name,
      email: reg.email,
      ...(reg.phone ? { mobilePhone: reg.phone } : {}),
    });

    const attendee = {
      event: { id: event.cvent_event_id },
      contact: { id: contact.id },
      status: 'Invited',
    };
    if (event.cvent_local_question_id) {
      attendee.answers = [{ question: { id: event.cvent_local_question_id }, value: [localName] }];
    }
    const created = await this.createOne('/ea/attendees', attendee);

    return {
      contactId: contact.id,
      attendeeId: created.id,
      link: findRegistrationLink(created),
      raw: { contact, attendee: created },
    };
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

// Pull the created record out of Cvent's reply, whether it's the record itself, a list of
// records, or the record wrapped in `data`.
function unwrapCreated(reply, path) {
  let r = reply;
  if (Array.isArray(r)) r = r[0];
  else if (r && Array.isArray(r.data)) r = r.data[0];
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
