// Cvent connection test. Run it yourself with the site's Cvent settings:
//
//   npm run cvent:check                                  # sign in only
//   npm run cvent:check -- --event <cventEventId>        # + read the event and its attendees
//   npm run cvent:check -- --event <id> --create-test-attendee you+test@example.com
//                                                        # + add ONE test person to that event
//
// It prints what Cvent returns and saves a report (no secrets in it) to data/cvent-check-*.json,
// so the answers can be shared without sharing the Client Secret.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { CventClient, findRegistrationLink } = require('./cvent');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--event') args.eventId = argv[++i];
    else if (a === '--create-test-attendee') args.testEmail = argv[++i];
    else if (a === '--question') args.questionId = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`Unknown option: ${a}`);
  }
  return args;
}

// Run each step, record what happened, and keep going where it makes sense.
async function runCheck(client, { eventId, testEmail, questionId } = {}, log = console.log) {
  const report = { ranAt: new Date().toISOString(), apiBase: client.base, steps: [] };
  const step = async (name, fn) => {
    log(`\n▶ ${name}`);
    try {
      const result = await fn();
      report.steps.push({ name, ok: true, result });
      log('  ✔ OK');
      return result;
    } catch (err) {
      report.steps.push({ name, ok: false, error: err.message });
      log(`  ✘ ${err.message}`);
      return undefined;
    }
  };

  const signedIn = await step('Sign in to Cvent (client ID + secret)', async () => {
    await client.accessToken();
    const info = client.tokenInfo || {};
    log(`  Region/API: ${client.base}`);
    log(`  Scopes granted: ${info.scope || '(Cvent did not list them)'}`);
    return info;
  });
  if (!signedIn) {
    log('\nSign-in failed. Check CVENT_CLIENT_ID, CVENT_CLIENT_SECRET and CVENT_REGION (na or eu).');
    return report;
  }
  if (!eventId) {
    log('\nSign-in works. Add --event <Cvent event ID> to test reading your event.');
    return report;
  }

  await step(`Read event ${eventId}`, async () => {
    const event = await client.request('GET', `/ea/events/${encodeURIComponent(eventId)}`);
    log(`  Name: ${event && (event.title || event.name) || '(no title field)'}`);
    log(`  Fields Cvent returned: ${Object.keys(event || {}).join(', ')}`);
    return event;
  });

  await step('List attendees on the event', async () => {
    const attendees = await client.listAttendees(eventId);
    const byStatus = {};
    for (const a of attendees) byStatus[a.status || '(none)'] = (byStatus[a.status || '(none)'] || 0) + 1;
    log(`  ${attendees.length} attendee(s). By status: ${JSON.stringify(byStatus)}`);
    if (attendees[0]) log(`  Fields on an attendee: ${Object.keys(attendees[0]).join(', ')}`);
    // Field names only: the report must not carry real attendees' personal details.
    return { count: attendees.length, byStatus, attendeeFields: attendees[0] ? Object.keys(attendees[0]) : [] };
  });

  if (!testEmail) {
    log('\nTo see what Cvent returns for a new person (including any personal registration link),');
    log('re-run on a TEST event with: --create-test-attendee you+test@example.com');
    return report;
  }

  await step(`Add test person ${testEmail} to the event`, async () => {
    const result = await client.createAttendee(
      { cvent_event_id: eventId, cvent_local_question_id: questionId || null },
      { first_name: 'Test', last_name: 'Registration', email: testEmail, phone: null },
      'Local TEST',
    );
    log(`  Body format Cvent accepted: ${JSON.stringify(client.bodyForms)}`);
    log(`  Invitee status Cvent accepted: "${client.inviteeStatus}"`);
    log(`  Contact ID: ${result.contactId}`);
    log(`  Attendee ID: ${result.attendeeId}`);
    log(`  Personal registration link: ${result.link || 'NOT FOUND in the response (ask Cvent which field holds it)'}`);
    log('  Full attendee response from Cvent:');
    log(JSON.stringify(result.raw.attendee, null, 2).replace(/^/gm, '    '));
    return { ...result, bodyForms: client.bodyForms, inviteeStatus: client.inviteeStatus, linkFound: Boolean(findRegistrationLink(result.raw.attendee)) };
  });

  log('\nRemember to remove the test person from the event in Cvent afterwards.');
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 9).join('\n'));
    return;
  }
  const env = process.env;
  if (!env.CVENT_CLIENT_ID || !env.CVENT_CLIENT_SECRET) {
    console.error('Set CVENT_CLIENT_ID and CVENT_CLIENT_SECRET (in .env or the environment) first.');
    process.exitCode = 1;
    return;
  }
  const client = new CventClient({
    mode: 'api', region: env.CVENT_REGION, clientId: env.CVENT_CLIENT_ID,
    clientSecret: env.CVENT_CLIENT_SECRET, scope: env.CVENT_SCOPE, inviteeStatus: env.CVENT_INVITEE_STATUS,
  });
  const report = await runCheck(client, args);

  const dir = env.DATABASE_FILE ? path.dirname(env.DATABASE_FILE) : path.join(__dirname, '..', 'data');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `cvent-check-${report.ranAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`\nReport saved to ${file} (contains no secrets).`);
  if (report.steps.some((s) => !s.ok)) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => { console.error(err.message); process.exitCode = 1; });
}

module.exports = { runCheck, parseArgs };
