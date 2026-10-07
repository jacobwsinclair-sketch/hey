# Cvent setup checklist

A step-by-step list for whoever administers your Cvent account. Cvent's menu names change
between versions and plans, so if a label below doesn't match what you see, search Cvent's help
for the feature named in **bold**.

## 1. Choose a mode

- **No-API mode (`CVENT_MODE=off`)** works today. Attendees are sent to the event's normal
  registration link, and you confirm payments by hand in `/admin`. Skip to step 4.
- **API mode (`CVENT_MODE=api`)** is fully automatic: the site creates each attendee in Cvent
  and confirms them when they've paid. It needs Cvent **REST API** access (see step 2).

## 2. Create API credentials (API mode)

You need **Admin** rights in Cvent and **REST API** on your plan.

**Open the developer portal**
- [ ] In Cvent, go to **Admin** → **Integrations** → **REST API** and click **Manage API Access**.
      The developer portal opens in a new tab.

**Set up a workspace** (it controls which data apps are allowed to use)
- [ ] Create a **workspace** for this site, or use an existing one.
- [ ] On **Choose permissions**, don't use **Select all**. Tick only:
  - **Events**: covers every scope in the table below, since they all start with `event/`.
  - **Webhook** (optional): only if you'll set up the webhook in step 5.

  The workspace's permissions limit what its applications can be given, so the scopes in the
  table must be included here. **Machine to Machine** doesn't appear on this screen; it comes
  when you create the application.
- [ ] On the **Developers** tab, click **+ Invite developer** and invite whoever will create the
      app. As the Cvent admin, you can invite yourself.

**Create the application**
- [ ] Go to **Applications** → **Create application**.
- [ ] Choose **Machine to Machine** as the application type. This is the "client credentials"
      sign-in the site uses; Cvent's screens don't use that name.
- [ ] Name it, for example "Union Local registration".
- [ ] Add these scopes:

      | Scope | Why the site needs it |
      |---|---|
      | `event/contacts:write` | Create the person as a contact |
      | `event/contacts:read` | Read the contact back |
      | `event/attendees:write` | Add them to the event's invitation list, with their Union Local |
      | `event/attendees:read` | Check who has registered and paid |
      | `event/events:read` | Read the event (if Cvent lists it separately) |

      If Cvent shows slightly different names, pick the read and write scopes for
      **contacts** and **attendees**, and read for **events**.
- [ ] Click **Save**.

**Copy the credentials into the site**
- [ ] On the application's page, click **Copy** next to the **Client ID** and put it in the
      site's `CVENT_CLIENT_ID` setting.
- [ ] Do the same for the **Client Secret** → `CVENT_CLIENT_SECRET`. Store it as a secret on
      your host and don't share it.
- [ ] Set `CVENT_REGION` to `eu` if your Cvent account is hosted in Europe, otherwise `na`.
- [ ] Set `CVENT_MODE` to `api`.
- [ ] Leave `CVENT_SCOPE` empty to start. If the site logs "Cvent auth failed" mentioning
      scope, set it to the scopes above, separated by spaces.

## 3. Check the API calls against your account (API mode)

The site's Cvent calls were written without access to a live Cvent account. Have a developer
compare these against the API reference in your Cvent developer portal. All of them are in
`src/cvent.js`.

| What the site does | Call it makes |
|---|---|
| Get an access token | `POST /ea/oauth2/token` |
| Create the person | `POST /ea/contacts` with first name, last name, email, phone |
| Add them to the event | `POST /ea/attendees` with the event ID, contact ID, status `No Response` (not yet registered) and the Union Local answer |
| Check who has paid | `GET /ea/attendees?filter=event.id eq '<id>'` |

- [ ] Paths, field names and the paging format match your API version.
- [ ] Find which field on a created attendee holds their **personalised registration link**.
      The site looks for `registrationLink`, `registrationUrl` or `links.registration.href`. If
      your API returns none of these, set a **Redirect template** on the event in `/admin` (see
      the README).
- [ ] Attendee statuses: the site treats `Accepted` and `Attended` as paid, and `Cancelled` and
      `Declined` as cancelled. Confirm these match what Cvent reports after payment.

### Run the connection test

The site includes a command that tries these calls with your credentials and shows exactly what
Cvent sends back. You run it yourself, so the Client Secret stays on your computer or server.

**One-time setup on your computer** (skip if the site is already deployed; run it there instead):

- [ ] Install **Node.js 20 or newer** from nodejs.org.
- [ ] Download this repository (on GitHub: **Code → Download ZIP**, then unzip it) and open a
      terminal in that folder.
- [ ] Run `npm install`.
- [ ] Copy `.env.example` to a new file called `.env`, and fill in `CVENT_CLIENT_ID`,
      `CVENT_CLIENT_SECRET` and `CVENT_REGION`. `.env` is never uploaded to GitHub.

**Run it in three stages:**

| Command | What it checks | Changes anything in Cvent? |
|---|---|---|
| `npm run cvent:check` | The Client ID and Secret work; which region and scopes you have | No |
| `npm run cvent:check -- --event <event ID>` | The site can read the event and its attendees, and which statuses they have | No |
| `npm run cvent:check -- --event <event ID> --create-test-attendee you+test@yourdomain.ca` | Adds **one** test person and shows Cvent's full reply, including whether a **personal registration link** comes back | Yes: adds one person |
| `npm run cvent:check -- --event <event ID> --attendee <attendee ID>` | Shows one attendee's full record, including any personal registration link | No |

- [ ] Use a **test event** for the third command, never the live one, and remove the test
      person from the event in Cvent afterwards.
- [ ] To also test the Union Local answer, add `--question <question ID>` to the third command.
- [ ] Each run prints what it found and saves a report to `data/cvent-check-<date>.json`. The
      report contains no secrets and only field names (not personal details) for existing
      attendees, so it's safe to send to the developer or to Cvent support.
- [ ] If a step fails, the message includes Cvent's own error text. That's the thing to show Cvent.

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
