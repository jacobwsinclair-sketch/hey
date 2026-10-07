# Deploying the registration site

The site is one small Node.js process with a SQLite database file. Any host works if it gives you:

- **HTTPS** on a public URL (attendees enter personal details).
- **A persistent disk** for the database. Without one, every redeploy wipes all registrations
  and Local counts.
- **One running instance.** The capacity check relies on a single process owning the database
  file. Don't scale it out to several instances.

The repo includes a `Dockerfile`. The image stores the database at `/data/registrations.db`,
so mount your persistent disk at `/data`.

## Settings

Set these as environment variables (or secrets) on your host. See `.env.example` for all of them.

| Variable | Required | Notes |
|---|---|---|
| `ADMIN_PASSWORD` | yes | Password for `/admin`. Use a long random one. |
| `CVENT_MODE` | | `off` (default) or `api`. |
| `CVENT_REGION` | in `api` mode | `na` or `eu`. |
| `CVENT_CLIENT_ID`, `CVENT_CLIENT_SECRET` | in `api` mode | From your Cvent API app. Store as secrets. |
| `CVENT_SCOPE` | if Cvent requires it | Space-separated scopes. |
| `WEBHOOK_SECRET` | if using the webhook | A long random string. |
| `SYNC_INTERVAL_MINUTES` | | Default 2. |

`PORT` and `DATABASE_FILE` are already set in the image.

Health check path: `GET /healthz` returns `ok`.

## Option A: Render

1. Create a **Web Service** from this GitHub repo. Render detects the `Dockerfile`.
2. Choose a plan that supports a **persistent disk**, and add a disk mounted at `/data`
   (1 GB is plenty).
3. Add the environment variables above.
4. Set the health check path to `/healthz`.
5. Deploy, then open `https://<your-service>.onrender.com/admin`.

## Option B: Fly.io

```bash
fly launch --no-deploy            # uses the Dockerfile; pick a region near your attendees
fly volumes create data --size 1  # same region as the app
```

In the generated `fly.toml`, mount the volume and keep it to one machine:

```toml
[mounts]
  source = "data"
  destination = "/data"

[[http_service.checks]]
  path = "/healthz"
  interval = "30s"
  timeout = "5s"
```

```bash
fly secrets set ADMIN_PASSWORD=... CVENT_MODE=api CVENT_CLIENT_ID=... CVENT_CLIENT_SECRET=...
fly deploy
fly scale count 1
```

## Option C: Any server with Docker

```bash
docker build -t union-reg .
docker volume create union-reg-data
docker run -d --name union-reg --restart unless-stopped \
  -p 3000:3000 -v union-reg-data:/data --env-file .env union-reg
```

Put a reverse proxy with HTTPS in front of it (for example Caddy or nginx with Let's Encrypt).

## If the app can't write to `/data`

The container runs as the unprivileged `node` user (uid 1000). Docker named volumes pick up the
right owner automatically, but some hosts mount a fresh disk owned by root. If the logs show a
permission error opening `/data/registrations.db`, make the disk writable by uid 1000 once. For
example, on a Docker host:

```bash
docker run --rm -v union-reg-data:/data alpine chown 1000:1000 /data
```

On a managed host, use its shell or console to run `chown 1000:1000 /data` as root once.

## Backups

Everything lives in the one database file. Back it up regularly, and always before an event
opens. Run the included backup script inside the container; it's safe while the site is running:

```bash
npm run backup                         # writes /data/backup-YYYY-MM-DD.db
npm run backup -- /data/my-backup.db   # or choose the file name
```

Then copy the backup file somewhere off the server.

The admin CSV export is also a handy human-readable snapshot.

## After deploying

1. Open `/admin`, create the event and add the Locals with their limits.
2. Follow [CVENT_SETUP.md](CVENT_SETUP.md) to connect Cvent.
3. Do one test registration end to end before sharing the link.
