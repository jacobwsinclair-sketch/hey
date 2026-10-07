# Cvent setup checklist

A step-by-step list for whoever administers your Cvent account. Cvent's menu names change
between versions and plans, so if a label below doesn't match what you see, search Cvent's help
for the feature named in **bold**.

## 1. Choose a mode

- **No-API mode (`CVENT_MODE=off`)** works today. Attendees are sent to the event's normal
  registration link, and you confirm payments by hand in `/admin`. Skip to step 4.
- **API mode (`CVENT_MODE=api`)** is fully automatic: the site creates each attendee in Cvent
  and confirms them when they've paid. It needs Cvent **REST API** access, which depends on your
  Cvent plan. Ask your Cvent account manager if you don't see it.

## 2. Create API credentials (API mode)

- [ ] In Cvent's **developer portal**, create an **API application** for this site.
- [ ] Use the **client credentials** (server-to-server) grant type.
- [ ] Grant read and write access to **attendees** and **contacts** (and **events** read, if
      it's listed separately). Note the exact scope names Cvent shows.
- [ ] Copy the **client ID** and **client secret** into the site's `CVENT_CLIENT_ID` and
      `CVENT_CLIENT_SECRET` settings.
- [ ] Set `CVENT_REGION` to `eu` if your account is hosted in Europe, otherwise `na`.
- [ ] If Cvent requires scopes in the token request, set `CVENT_SCOPE` to them, space-separated.

## 3. Check the API calls against your account (API mode)

The site's Cvent calls were written without access to a live Cvent account. Have a developer
compare these against the API reference in your Cvent developer portal. All of them are in
`src/cvent.js`.

| What the site does | Call it makes |
|---|---|
| Get an access token | `POST /ea/oauth2/token` |
| Create the person | `POST /ea/contacts` with first name, last name, email, phone |
| Add them to the event | `POST /ea/attendees` with the event ID, contact ID, status `Invited` and the Union Local answer |
| Check who has paid | `GET /ea/attendees?filter=event.id eq '<id>'` |

- [ ] Paths, field names and the paging format match your API version.
- [ ] Find which field on a created attendee holds their **personalised registration link**.
      The site looks for `registrationLink`, `registrationUrl` or `links.registration.href`. If
      your API returns none of these, set a **Redirect template** on the event in `/admin` (see
      the README).
- [ ] Attendee statuses: the site treats `Accepted` and `Attended` as paid, and `Cancelled` and
      `Declined` as cancelled. Confirm these match what Cvent reports after payment.

## 4. Configure the event in Cvent

- [ ] Set up registration types, fees and **payment** as usual. Payment stays entirely in Cvent.
- [ ] Add a custom registration question, for example **"Union Local"** (a text field is
      simplest). Copy its **question ID** into the event's settings in `/admin`. The site fills
      it in automatically in API mode, so the Local appears in Cvent's reports.
- [ ] **Restrict registration to the invitation list (invitees only).** This is what stops
      people from skipping the Local check by going straight to Cvent. In API mode, the site
      adds each person to the invitation list just before sending them over. In no-API mode
      you can't use this, so keep the Cvent link private.
- [ ] Copy the event's **Cvent event ID** and **registration URL** into the event's settings
      in `/admin`.

## 5. Webhook (optional, API mode)

Without a webhook the site checks Cvent every 2 minutes. A webhook makes confirmations almost
instant.

- [ ] Set a long random `WEBHOOK_SECRET` on the site.
- [ ] In Cvent, create a **webhook** for attendee registration or status-change events,
      pointing to `https://<your-site>/webhooks/cvent/<WEBHOOK_SECRET>`.
- [ ] The site ignores the webhook's contents and re-reads attendee statuses from the API, so
      any payload format works.

## 6. Test before going live

Use a test event, or the real event before you share the link.

- [ ] Create a Local with a limit of 1 in `/admin`.
- [ ] Register through the site. You should land on Cvent with the person's details already
      in place.
- [ ] Complete payment in Cvent (use test payment mode if your account has one).
- [ ] Within a couple of minutes, `/admin` shows the person as **confirmed** and the Local as
      full.
- [ ] Try to register a second person for that Local. The site should refuse them.
- [ ] Start a registration and abandon it at payment. After the hold time it should show as
      **expired**, and the spot should open up again.
- [ ] Try opening the Cvent registration link directly, without going through the site. Cvent
      should refuse to let you register.
