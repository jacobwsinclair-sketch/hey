# Union Local Registration

A small registration site that sits in front of Cvent. Cvent can't cap attendance per Union
Local, so this site does it:

```
Attendee → our site (pick Local, enter details) → spot reserved → Cvent (payment) → confirmed
```

1. The attendee picks their **Union Local** and fills in their details. Locals that are full are
   shown as "full" and can't be picked.
2. On submit the site **reserves a spot** for that Local (atomically, so two people can never
   both take the last spot). The spot is held for a set time (default 30 minutes).
3. The attendee is **created in Cvent** (with their Local recorded on a Cvent custom question) and
   **redirected to Cvent** to pay.
4. The site **checks Cvent** every couple of minutes (and whenever Cvent calls the webhook).
   When Cvent shows the attendee as registered, the spot becomes **confirmed**. If they never
   finish paying, the hold **expires** and the spot is released for someone else.

Admins manage events, Locals and limits at `/admin`, can see confirmed / held / remaining per
Local, confirm or cancel people by hand, and export a CSV.

## Running it

Requires Node.js 20+.

```bash
npm install
cp .env.example .env        # then edit .env – at minimum set ADMIN_PASSWORD
npm start                   # http://localhost:3000, admin at /admin
npm test
```

Data is stored in a SQLite file (`data/registrations.db` by default). Run it on any host that
keeps a persistent disk (a small VM, Render/Railway/Fly with a volume, etc.) behind HTTPS, and
back up the database file.

## Setting up an event

1. In Cvent, create the event as usual (registration types, fees, payment).
2. In `/admin`, create an event:
   - **Cvent event ID** – the event's ID from Cvent (needed for API mode).
   - **Cvent registration URL** – the event's registration link (used in `off` mode, and as a fallback).
   - **Cvent "Union Local" question ID** – optional. Create a custom registration question in
     Cvent (e.g. "Union Local") and paste its ID here so the Local shows up in Cvent reports too.
   - **Hold minutes** – how long a spot is held while someone pays.
3. Add Locals in bulk, one per line: `Local 183, 10`.
4. Share `https://your-site/e/<slug>` as the registration link — **not** the Cvent link.

### Stop people skipping the Local check

If the Cvent registration page is public, people could go straight to it and bypass the limits.
In Cvent, restrict registration to the **invitation list only** (invitees only). In API mode
this site adds each person to the invitation list right before sending them over, so only people
who went through the Local check can register.

## Cvent integration

`CVENT_MODE` in `.env` controls how the site talks to Cvent.

### `CVENT_MODE=off` (no API)

The site doesn't call Cvent. After reserving a spot it sends the attendee to the event's
**Cvent registration URL** (or the **redirect template**, see below). Because the site can't see
who paid, confirm registrations in `/admin` (or leave holds to expire). Good for testing and
as a fallback while API access is being set up.

### `CVENT_MODE=api` (recommended)

Needs Cvent REST API access (an API app in the Cvent developer portal with a client ID/secret
and attendee + contact read/write scopes). The site then:

- gets an OAuth token (`POST /ea/oauth2/token`, client-credentials),
- creates the contact (`POST /ea/contacts`) and adds them to the event as an invitee
  (`POST /ea/attendees`), answering the Union Local question,
- redirects them to their personalised Cvent registration link,
- polls `GET /ea/attendees?filter=event.id eq '<id>'` to confirm (`Accepted` / `Attended`)
  or cancel (`Cancelled` / `Declined`).

> **Verify before go-live:** Cvent's API paths, payload fields and scopes vary by subscription
> and API version, and couldn't be tested against a live Cvent account while building this.
> All Cvent calls are in [`src/cvent.js`](src/cvent.js) — check them against the API reference
> in your Cvent developer portal and run a test registration end to end on a test event first.
> In particular, check which field of the created attendee holds the personalised registration
> link (`findRegistrationLink`); if your API doesn't return one, use a redirect template.

#### Webhook (optional, faster confirmation)

Set `WEBHOOK_SECRET` and point a Cvent webhook (attendee registered / status changed) at
`https://your-site/webhooks/cvent/<WEBHOOK_SECRET>`. The payload isn't trusted; it just triggers
an immediate sync from the API. Without it, the timer (`SYNC_INTERVAL_MINUTES`) does the same.

### Redirect template

Per event, you can override where attendees are sent with a URL template. Placeholders:
`{link}` (Cvent's personalised link, inserted as-is), `{attendeeId}`, `{contactId}`, `{email}`,
`{firstName}`, `{lastName}`, `{local}`, `{cventEventId}`, `{token}`. Example:

```
https://web.cvent.com/event/{cventEventId}/regProcessStep1?e={email}
```

## How limits are counted

A Local's spot is in use while a registration is **confirmed** or **held** (and not yet expired).

- Same email coming back while their hold is live → sent back to Cvent, no second spot used.
- Same email already confirmed → told they're already registered.
- Cvent call fails → the hold is released immediately and the person is asked to retry.
- Someone pays in Cvent after their hold expired → still marked confirmed (they've paid); the
  admin screen highlights the Local as **over** its limit so you can decide what to do.
- Lowering a limit below current registrations doesn't cancel anyone; it just stops new ones.

## Project layout

```
src/server.js         startup, config, sync timer
src/app.js            Express app, home page, Cvent webhook
src/routes/public.js  registration form + hand-off to Cvent
src/routes/admin.js   admin screens (HTTP Basic auth via ADMIN_PASSWORD)
src/db.js             SQLite schema and the capacity-checked reservation
src/cvent.js          Cvent REST client and redirect URL builder
src/sync.js           pull statuses from Cvent, expire holds
src/views.js          HTML templates
test/                 node:test suite (Cvent API is mocked)
```
