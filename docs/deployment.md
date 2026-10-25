# Deployment

## Railway (Recommended)

Production should **not** auto-deploy from `develop`. Use **`main` only** for Railway production deploys, and create **version tags** (`v*`) after the `main` commit is ready so GitHub Releases match what was shipped.

This page sets up one environment. To run `develop` on a staging bot in your own test server next to production, follow [operations.md](operations.md) after it - that page also covers releases, hotfixes and rollbacks.

### 1. Create Railway Project

1. Go to [Railway](https://railway.app/) and sign up/login
2. Click "New Project" > "Deploy from GitHub repo"
3. Select this repository
4. Railway will automatically detect the Node.js project
5. Open the service **Settings** → **Source** and set the **trigger branch** to **`main`** (never `develop` for production)

### 2. Configure Volume (Required for SQLite and file data)

The bot stores SQLite data under `/app/data`, and the same volume may also contain backups, voice recordings, and disk buffers. To prevent data loss on redeployments:

1. In your Railway project, go to the service
2. Click "Settings" > "Volumes"
3. Add a new volume:
   - Mount Path: `/app/data`
   - Size: 1GB (sufficient for most use cases)

### 3. Set Environment Variables

In Railway dashboard, add the following variables:

| Variable                        | Description                                                                               | Required          |
| ------------------------------- | ----------------------------------------------------------------------------------------- | ----------------- |
| `DISCORD_TOKEN`                 | Discord bot token                                                                         | Yes               |
| `DISCORD_CLIENT_ID`             | Discord application client ID                                                             | Yes               |
| `BOT_OWNER_IDS`                 | Bot owner Discord IDs (comma-separated); **required when `NODE_ENV=production`**          | Yes in production |
| `DISCORD_GUILD_ID`              | Register commands to this one server only (instant updates); unset in production          | No                |
| `ALLOWED_GUILD_IDS`             | Server IDs this bot may serve (comma-separated); unset serves every server (see below)    | No                |
| `NODE_ENV`                      | Set to `production`                                                                       | No                |
| `TZ`                            | Timezone for the backup cron and log timestamps; VC stats follow `STATS_TIMEZONE`         | No                |
| `STATS_TIMEZONE`                | IANA zone whose midnight starts a VC stats day (default: `TZ` if set, else `Asia/Tokyo`)  | No                |
| `MAX_RECORDING_DURATION`        | Max recording time in seconds (default: 300)                                              | No                |
| `AUDIO_BUFFER_DURATION`         | In-memory ring buffer length in seconds (default: 300, ~0.27MB/s per channel)             | No                |
| `MEMORY_LIMIT_MB`               | Memory budget in MB (default: 512); warns at 70% RSS, sheds connections at 85%            | No                |
| `MAX_CONCURRENT_VC_CONNECTIONS` | Max concurrent VC connections (default: 5)                                                | No                |
| `RECORDING_RETENTION_HOURS`     | Hours to keep generated recording files (default: 24)                                     | No                |
| `VOICE_SESSION_RETENTION_DAYS`  | Days to keep raw VC session rows (default: 30); stats totals survive via the daily rollup | No                |
| `AUDIT_LOG_RETENTION_DAYS`      | Days to keep audit logs (default: 90)                                                     | No                |
| `BACKUP_RETENTION_DAYS`         | Days to keep backups (default: 7)                                                         | No                |
| `BACKUP_CRON`                   | Backup schedule cron expression in `TZ` (default: `0 4 * * *`; UTC unless `TZ` is set)    | No                |
| `SHUTDOWN_FINAL_BACKUP`         | Run final backup before shutdown (default: true)                                          | No                |
| `SHUTDOWN_TIMEOUT_MS`           | Shutdown timeout in ms (default: 10000, range: 5000–120000)                               | No                |
| `ALERT_WEBHOOK_URL`             | Discord webhook URL for alerts (`https://` only)                                          | No                |
| `LOG_LEVEL`                     | Log level: debug, info, warn, error                                                       | No                |
| `DATA_DIR`                      | Base directory for persisted runtime data (must stay relative to repo root)               | No                |
| `DATABASE_PATH`                 | SQLite database path (must stay relative to repo root)                                    | No                |
| `RECORDINGS_DIR`                | Generated recording files directory (must stay relative to repo root)                     | No                |
| `BACKUP_DIR`                    | Backup output directory (must stay relative to repo root)                                 | No                |
| `VOICEVOX_URL`                  | VOICEVOX engine URL; enables `/tts` and the Message Content intent (see below)            | No                |
| `FORCE_COMMAND_SYNC`            | `true` re-uploads the slash commands at startup even when they look unchanged (see below) | No                |
| `NODE_COMPILE_CACHE`            | Node's compile cache directory, e.g. `/app/data/.node-compile-cache` (see below)          | No                |

`ALLOWED_GUILD_IDS` is for a staging bot ([operations.md](operations.md)). When set, the bot leaves any server outside the list as soon as it is added there, and in servers outside the list that it was already in it serves nothing: commands, buttons and forms get a short private notice, and it neither auto-joins voice channels nor posts welcomes or VC notices there. It does not leave those servers by itself, so a wrong value costs a config fix rather than every server. Startup lists them in the logs. Direct messages are always served.

`ALLOWED_GUILD_IDS` is for a staging bot ([operations.md](operations.md)). When set, the bot leaves any server outside the list as soon as it is added there, and refuses commands with a short notice in servers outside the list that it was already in - it does not leave those by itself, so a wrong value costs a config fix rather than every server. Startup lists them in the logs. Direct messages are always served.

If you enable voice recording in production, remember that `/voice record` now requires `Manage Server`, and generated files are delivered ephemerally and cleaned up automatically according to `RECORDING_RETENTION_HOURS`.

Size the instance from `AUDIO_BUFFER_DURATION × 0.27MB × MAX_CONCURRENT_VC_CONNECTIONS` — about 410MB at the defaults — plus the bot's baseline, and set `MEMORY_LIMIT_MB` to the memory the host actually grants. That is the worst case, not the steady state: a channel's buffer is allocated on its first decoded audio chunk, so idle connections cost nothing. Servers that do not want the bot buffering their voice channels can turn it off per guild or per channel with `/voice autojoin`.

### Slash command registration

At startup the bot compares the commands it is about to register with what
it registered last time (a hash in `DATA_DIR/command-sync.json`) and skips
the upload when nothing changed, so a plain restart does not spend Discord's
daily command-update budget. It still reads the registered command IDs, which
turn command names in replies into clickable mentions. Set
`FORCE_COMMAND_SYNC=true` for one start if commands were changed or deleted
outside the bot (for example with `npm run cleanup-commands`), or delete
`command-sync.json`.

### Startup cache

In production the bot turns on Node's compile cache under
`DATA_DIR/.node-compile-cache` (on the volume), which takes about 18% off
loading its modules on a restart. Setting the service variable
`NODE_COMPILE_CACHE=/app/data/.node-compile-cache` also covers the few modules
loaded before the bot enables it; it is optional.

### Shutdown and restarts

`railway.toml` starts the bot with `node dist/index.js`, not `npm start`: npm
does not pass SIGTERM on to node, so the graceful shutdown (final backup,
closing open VC sessions, leaving voice channels) was skipped on every
redeploy. `drainingSeconds = 15` gives that shutdown time to finish before
Railway sends SIGKILL; keep it above `SHUTDOWN_TIMEOUT_MS / 1000`. A crash
exits with code 1 so the `ON_FAILURE` restart policy brings the bot back.

The shutdown first closes open panels and confirmation prompts, so users see
them end ("the bot is restarting, nothing was done") instead of buttons that
fail after the restart; that step gets at most 3 seconds, or a fifth of
`SHUTDOWN_TIMEOUT_MS` if that is less. A button pressed while the bot is
starting or stopping gets a private "restarting, try again in a few seconds"
note and the message is left as it is.

After a redeploy, the old deployment's logs should end with
`Received SIGTERM, initiating graceful shutdown...` and
`Graceful shutdown complete`.

### Text-to-speech (optional)

`/tts` reads chat aloud with [VOICEVOX](https://voicevox.hiroshiba.jp/), which
runs as its own service next to the bot:

1. In the same Railway project, add a service from the Docker image
   `voicevox/voicevox_engine:cpu-latest`. It listens on port `50021` and needs
   no volume. Name the service `voicevox`, or note the private domain shown
   under the service's **Settings → Networking**: Railway derives it from the
   service name, and a service created from an image is usually named after
   the image instead.

   Set `VV_CPU_NUM_THREADS` on the engine service to the number of vCPUs it
   is allowed (usually `1` or `2`), never more: left unset, the engine starts
   one thread per core it can _see_, which inside a container can be far more
   than its CPU limit. Measured on a 2-vCPU limit, 4 threads made every line
   1.4× slower and 8 threads 2.4× slower; on 1 vCPU the automatic choice was
   12–16% slower than `1`. Run `nproc` in the engine service's shell to see
   what it sees.

2. Set `VOICEVOX_URL` on the bot to the engine's private address,
   `http://<private-domain>:50021` - for a service named `voicevox`,
   `http://voicevox.railway.internal:50021`. Keeping the engine on private
   networking means it is never exposed to the internet.

   The image listens on IPv4 only (`VV_HOST=0.0.0.0`). Railway environments
   created before October 16, 2025 have an IPv6-only private network, so there
   the bot cannot connect until you set `VV_HOST=::` on the VOICEVOX service.
   `::` works in newer environments too, so setting it is always safe. If
   `/tts start` keeps answering that it cannot reach the speech engine, check
   the domain and this variable first.

3. In the Discord Developer Portal, open **Bot → Privileged Gateway Intents** and
   turn on **MESSAGE CONTENT INTENT**. The bot only requests that intent when
   `VOICEVOX_URL` is set, and Discord refuses the login (close code 4014) if it
   is requested without being enabled; the bot then logs which intents to
   enable before exiting. Apps with fewer than 10,000 users can toggle it
   directly; larger apps must apply for it.
4. Give the bot the **Speak** permission in voice channels where people will use
   it.

Playback needs no ffmpeg: the bot asks VOICEVOX for 48 kHz stereo audio and
encodes it to Opus with the bundled encoder.

VOICEVOX and each character's terms require a credit (for example
`VOICEVOX:ずんだもん`). The public `/tts start` message credits the default
voice and the voices of everyone in the channel at that moment. Every other
character is credited in the voice channel's chat the first time a line in it
is read during the session: a member who joins later, or who switches voice
(even from another server), so every voice listeners hear has been credited
where they can see it. Each character is credited once per session.

One engine serves every server, so the bot sends it one request at a time and
servers take turns line by line; a burst of chat in one server cannot make
lines time out in another. Lines are rendered clause by clause and start
playing as soon as the first clause is ready (a clause more than 3 seconds late
ends that line instead of leaving silence), and announced names are cached. When chat outruns the
engine, a speaker's consecutive messages are read as one, and a message still
waiting 25 seconds after it was posted is skipped. The bot also asks the engine
to load each voice model in use (`/initialize_speaker`) when reading starts, and
loads the voice list and the default voice once the bot is up, so nobody's
first line waits for its model.

Where a server has turned auto-join off (`/voice autojoin disable` or an
excluded channel), `/tts start` still joins, but deafened and without buffering
any audio, so reading never overrides that choice; turning auto-join off or
excluding the channel later leaves such a join alone. A connection that does
buffer is still dropped by those commands, which ends any reading through it
(the channel is told, and `/tts start` resumes reading deafened).

With `VOICEVOX_URL` set the bot receives every guild message, but it keeps no
message cache (discord.js would otherwise hold the last 200 per channel).
Members who post are still cached, as other events would cache them, so
reading adds little memory beyond the sizing above.

### 4. Choose how production deploys run

**Recommended:** Keep the Railway service connected to GitHub, restrict the trigger branch to **`main`**, and let Railway deploy only after the `main` branch passes CI.

1. In the service **Settings** → **Source**, keep the GitHub repository connected.
2. Set the trigger branch to **`main`** so `develop` never deploys to production.
3. Push version tags (for example `v1.2.3`) only after the `main` commit is ready. The Release workflow builds and publishes GitHub Release artifacts, while Railway deployment continues to come from the `main` branch integration.

If you prefer manual production deploys, disconnect GitHub autodeploys and trigger Railway deployments manually from the Railway dashboard. In that mode, the Release workflow still creates artifacts but does not deploy anything by itself.

### 5. Enable Wait for CI (optional, GitHub-connected services only)

If the service stays connected to GitHub and deploys from **`main`**, you can wait for Actions to pass first:

1. In your Railway project, go to the service
2. Click **Settings** → **Source**
3. Enable **Wait for CI**

Railway’s “Wait for CI” expects a workflow that runs on `push` to `main` (this repository’s CI includes that). Failed CI will skip the deployment.

### Estimated Cost

| Item         | Monthly Cost |
| ------------ | ------------ |
| Hobby Plan   | $5           |
| Volume (1GB) | ~$0.25       |
| **Total**    | **~$5.25**   |

## CI/CD

- **GitHub Actions**: Lint, format-check, type-check (source and tests), tests with coverage floors, production dependency audit, and build on every pull request (any base branch) and on push to `main` and `develop`
- **CodeQL**: JavaScript/TypeScript analysis on `main` / `develop` (plus weekly schedule); review alerts under **Security → Code scanning**
- **Release**: Push tag `v*` to create a GitHub Release with build artifacts; Railway deployment is intentionally handled outside the release workflow
- **Branch strategy**: `feature/*` and `fix/*` → `develop` (squash) → `main` through a release PR (merge commit); `hotfix/*` → `main`, then back into `develop`. Railway **staging** tracks `develop` and **production** tracks `main` only - see [operations.md](operations.md).
- **Runtime**: CI and release workflows run on Node.js `22.12.0`
- **Local parity**: Run `./scripts/validate.sh` before push — it mirrors CI checks including `npm audit --omit=dev --audit-level=high`

[← Back to README](../README.md)
