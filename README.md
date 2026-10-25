# Discord Bot

![Build Status](https://img.shields.io/github/actions/workflow/status/iam74k4/Bot-Discord/.github/workflows/ci.yml?style=flat-square)
![Version](https://img.shields.io/github/v/release/iam74k4/Bot-Discord?style=flat-square)
![License](https://img.shields.io/github/license/iam74k4/Bot-Discord?style=flat-square)
![Node.js Version](https://img.shields.io/badge/node-22.12%2B-339933?style=flat-square&logo=node.js&logoColor=white)

A modular Discord bot built with TypeScript and discord.js v14.

## Table of Contents

- [Features](#features)
- [Tech Stack](#tech-stack)
- [Requirements](#requirements)
- [Setup](#setup)
- [Usage](#usage)
- [Commands](#commands)
- [Available Scripts](#available-scripts)
- [Project Structure](#project-structure)
- [Documentation](#documentation)
- [License](#license)

## Features

- Slash command support with automatic registration (skipped when nothing changed)
- Japanese-first replies with English for everyone else; every command name in a reply is a clickable mention
- **Voice channel recording** (restricted past-audio recording with `/voice record`)
- **Text-to-speech** (`/tts`): reads chat aloud in voice channels with VOICEVOX, so members who cannot or would rather not speak can still take part
- **Captions** (`/caption`): shows what people say in a voice channel as text in its chat, transcribed by a self-hosted Whisper engine, for members who cannot or would rather not listen; only members who consented are captioned
- VC join/leave and member-join notifications, plus per-user VC time stats
- Community features (native Discord polls, VC roulette)
- Admin system (`/admin` server settings with one overview of every feature's settings, `/owner` bot-owner tools)
- Audit logging for role changes, notification setup, and settings changes
- Middleware system (permissions, per-subcommand cooldowns)
- SQLite database for persistence
- Modular feature-based architecture for easy extension
- TypeScript with strict type checking
- ESLint + Prettier for code quality

## Tech Stack

| Category     | Technology                    |
| ------------ | ----------------------------- |
| Language     | TypeScript                    |
| Runtime      | Node.js 22+                   |
| Framework    | discord.js v14                |
| Voice        | @discordjs/voice, prism-media |
| Database     | SQLite (better-sqlite3)       |
| Testing      | Vitest                        |
| Code Quality | ESLint, Prettier              |
| Build Tool   | TypeScript Compiler           |
| Development  | tsx (hot-reload)              |
| Scheduling   | node-cron                     |
| Deployment   | Railway                       |
| CI/CD        | GitHub Actions                |

## Requirements

- Node.js 22.12.0 or higher
- Discord Bot Token
- Discord Application Client ID

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Create a `.env` file in the project root (you can copy from `.env.example`):

```bash
cp .env.example .env
```

Required variables:

```env
DISCORD_TOKEN=your_discord_bot_token
DISCORD_CLIENT_ID=your_discord_client_id
```

For **production** (`NODE_ENV=production`), also set at least one bot owner ID (needed for `/owner` and operational control):

```env
BOT_OWNER_IDS=your_discord_user_id
```

See [.env.example](.env.example) for all configuration options and [docs/deployment.md](docs/deployment.md) for the full environment variable reference.

### 3. Get Discord Credentials

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application or select existing one
3. Go to "Bot" section and copy the token
4. **Enable Privileged Intents**: Go to "Bot" > Enable `SERVER MEMBERS INTENT`.
   If you set `VOICEVOX_URL` (text-to-speech), also enable
   `MESSAGE CONTENT INTENT`: the bot then requests it, and Discord refuses the
   login (so the whole bot fails to start) when it is not enabled
5. Go to "OAuth2" > "General" and copy the Client ID
6. Go to "OAuth2" > "URL Generator":
   - Select scopes: `bot`, `applications.commands`
   - Select bot permissions: `View Channels`, `Send Messages`, `Embed Links`,
     `Attach Files` (recordings), `Read Message History` (`/community poll
end`), `Connect` (voice), `Manage Roles` (`/admin role`), and `Speak` if
     you use `/tts`
   - Optional: `Set Voice Channel Status` lets the bot show "🔴 keeping
     audio" on the voice channel it buffers (only when the status is empty),
     and `Manage Channels` lets it clear a status it left behind after a crash
     without rejoining
   - Use the generated URL to invite the bot to your server. On joining, the
     bot posts a short welcome in the server's language explaining what it
     does, how to turn voice auto-join off, and any permission it is missing

## Usage

### Development

Run the bot with hot-reload:

```bash
npm run dev
```

### Production

Build and run:

```bash
npm run build
npm start
```

## Commands

### General

| Command                            | Description                                                     |
| ---------------------------------- | --------------------------------------------------------------- |
| `/general ping`                    | Check bot latency                                               |
| `/general help [command] [public]` | Show the commands you can use, or one command's page            |
| `/general about`                   | What the bot does in this server, including what audio it keeps |

`/general help` lists only the commands you are allowed to run. `command`
autocompletes and searches names, descriptions and keywords in Japanese or
English (`録音`, `投票`, `tts`); a close typo gets a "did you mean". Replies are
private unless you set `public` (`みんなに表示`).

### Cooldowns and refusals

Cooldowns are per user and per subcommand, so `/voice status` never holds up
`/voice record`: 3 s for `/general`, `/voice` and `/community poll`, 10 s for
`/voice record`, 5 s for `/community roulette` and 2 s for `/tts`; the
settings commands (`/admin`, `/notification`, `/owner`) have none. A request
turned down before any work (not in a VC, invalid input) gives the cooldown
back. Being asked to wait or lacking a permission is shown as a private
warning that names the command or the permission, and unexpected errors show a
short error ID that matches the bot's log.

### Notification (`/notification`)

| Command                               | Description                            |
| ------------------------------------- | -------------------------------------- |
| `/notification voice set <channel>`   | Set VC join/leave notification channel |
| `/notification voice disable`         | Disable VC join/leave notifications    |
| `/notification welcome set <channel>` | Set member join notification channel   |
| `/notification welcome disable`       | Disable member join notifications      |
| `/notification status`                | Show current notification settings     |
| `/notification stats [period]`        | Show your VC time statistics           |

`/notification status` opens a panel where both channels can be picked or
switched off (switching one off asks first). Every channel is checked before
it is saved: the bot needs View Channel, Send Messages and Embed Links there,
and a refusal names what is missing.

VC notifications are throttled: the first change is posted right away, then
anything happening in the next 30 seconds is collapsed into one summary. A
channel filling up costs two messages instead of ten, moving between channels
reads as a single line, and someone who drops in and out inside the window is
not announced at all. A join into an empty VC, which starts a call, is always
posted at once, together with anything still waiting in the window. Moving
into the server's AFK channel is posted as leaving VC, and AFK time does not
count toward stats.

The welcome message mentions (pings) the new member, says which member number
they are, and points to the rules channel when the server has one.

Posts in channels (VC notifications, welcome, recording notices, audit log,
announcements) use the server language set with `/admin settings language`.
When that is `auto`, they use the server's Discord language on Community
servers and Japanese otherwise.

`/notification stats` periods are whole calendar days in `STATS_TIMEZONE`
(default: `TZ`, else `Asia/Tokyo`): 今日 / 過去7日間 / 過去30日間 / 全期間
(Today / Last 7 days / Last 30 days / All time). A visit that crosses midnight
is split across the days it covers, and a visit in progress is included.

### Admin (`/admin`)

Available in servers only. Discord shows it to members with **Manage Server**
(its default permission); `/admin settings` needs Manage Server and
`/admin role` needs Manage Roles. To let a moderator with only Manage Roles use
`/admin role`, allow `/admin` for them under Server Settings → Integrations.

| Command                                   | Description                                                    |
| ----------------------------------------- | -------------------------------------------------------------- |
| `/admin settings view`                    | View current settings                                          |
| `/admin settings language <lang>`         | Set server language (`ja` / `en` / `auto`)                     |
| `/admin settings audit [channel]`         | Set audit log channel                                          |
| `/admin settings announcements [channel]` | Set the channel for bot owner announcements (empty to opt out) |
| `/admin settings logs`                    | View recent audit logs                                         |
| `/admin role add`                         | Add a role to a member (audit logged)                          |
| `/admin role remove`                      | Remove a role from a member (audit logged)                     |

`language` sets the language the bot replies in for everyone in the server.
`auto` follows each user's own Discord client language, which is how the bot
behaves when nothing is configured.

`/admin settings view` opens a panel with tabs for the overview (including
VC auto-join and notification channels), language, audit channel,
announcements and the audit log.

### Bot owner (`/owner`)

Only users listed in `BOT_OWNER_IDS` can run these commands. In servers,
Discord hides `/owner` from everyone but administrators; in a DM with the bot
it is always available to the owner. Broadcasts and manual backups ask for
confirmation first.

| Command                             | Description                                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `/owner system stats`               | View bot statistics                                                                                  |
| `/owner system db`                  | View database statistics                                                                             |
| `/owner system guilds`              | List servers the bot is in                                                                           |
| `/owner system broadcast <message>` | Post a message in each server's announcement channel (capped batch; servers without one are skipped) |
| `/owner system health`              | View system health status                                                                            |
| `/owner system metrics`             | View bot metrics                                                                                     |
| `/owner backup list`                | List database backups                                                                                |
| `/owner backup run`                 | Run a manual database backup                                                                         |

### Community (`/community`)

Available in servers only (not in DMs).

| Command                                           | Description                                                           |
| ------------------------------------------------- | --------------------------------------------------------------------- |
| `/community poll create <question> [option1..10]` | Create a native Discord poll (2-10 options; with fewer, a form opens) |
| `/community poll end [poll]`                      | Close one of your polls early, from any channel of the server         |
| `/community roulette member`                      | Pick one member of your VC                                            |
| `/community roulette team <count>`                | Split your VC into 2-6 teams                                          |

**Options:**

- `question`: Poll question, up to 300 characters (required)
- `option1` to `option10`: Choices, up to 55 characters each (optional). With
  fewer than two, a form takes the options one per line (2-10; blank lines and
  repeats are dropped), plus duration and multi-select. A rejected form offers
  「入力し直す」, which reopens it with what was typed
- `duration`: How long the poll stays open — 1h, 4h, 8h, 24h, 3d, or 7d (default: 24h)
- `multi`: Let people pick more than one option (default: false)
- `poll` (`poll end`): an autocompleted list of your open polls in this server
  (`#channel · time left`). The default is your newest poll in this channel,
  else your newest in the server. Ending asks for confirmation first

Roulette results keep 🎲 もう一度 / 🙅 当選者を除いて再抽選 (member) or
🔀 チームを組み直す (team) buttons for 5 idle minutes, up to about 14 minutes
after the command. Anyone in the VC can press them, and each press re-reads
who is in the VC.

Polls use Discord's own poll feature, so voting, the running tally, and closing
are handled by Discord itself: results survive a bot restart, and everyone sees
the same native UI on desktop and mobile. The bot only stores which message a
poll is in, so `/community poll end` can close it before its deadline.

Discord's minimum poll duration is one hour, so the old 5/10/30-minute options
are gone — use `/community poll end` to close a short poll when you are done.

### Voice (`/voice`)

Available in servers only, and hidden from members without **Manage Server**.

| Command                             | Description                                                                   |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| `/voice record <duration>`          | Save past audio from your voice channel                                       |
| `/voice status`                     | Whether your VC is kept and why not; panel to toggle auto-join and exclusions |
| `/voice autojoin enable`            | Allow the bot to join occupied voice channels                                 |
| `/voice autojoin disable`           | Stop auto-joining and buffering in this server                                |
| `/voice autojoin exclude <channel>` | Stop auto-joining and buffering one channel                                   |
| `/voice autojoin include <channel>` | Remove a channel from the exclusion list                                      |

Every auto-join change (command, status panel or the notice's button) is
written to the audit log in the server language.

**Options:**

- `duration`: Recording duration (e.g., `30s`, `1m`, `5m`, max 5 minutes). A
  recording cannot be longer than `AUDIO_BUFFER_DURATION`, which is why raising
  that setting above `MAX_RECORDING_DURATION` only costs memory.

**Features:**

- Auto-join: Bot automatically joins voice channels when users enter, and keeps
  a rolling window of that channel's audio so `/voice record` can reach backwards
  in time
- Disclosure: on joining, the bot posts once into the voice channel's own text
  chat saying audio is being kept and how to turn it off, with a button
  (Manage Server only) that excludes that channel; a newer notice replaces the
  previous one
- Opt-out: `/voice autojoin disable` (whole server) or
  `/voice autojoin exclude <channel>` (one channel). Both also drop any
  connection already buffering. `/tts start` can still bring the bot in, but
  deafened and without keeping audio, and the opt-outs leave such a reading
  join alone
- In-memory ring buffer of `AUDIO_BUFFER_DURATION` seconds (default: 300 = 5
  minutes), about **82MB per voice channel**, allocated the first time someone
  actually speaks — a channel the bot sits in silently costs nothing. Multiply
  by `MAX_CONCURRENT_VC_CONNECTIONS` for the worst case when sizing your host
- WAV format output at 48kHz/16bit/mono (~27.5MB for 5 minutes). Only what
  was actually heard is saved; a recording over the server's upload limit is
  split into the fewest equal parts, each labelled with its time range
- Private delivery: Recording responses and files are sent ephemerally, and
  the progress message becomes the result
- When a channel is not being kept, `/voice record` and `/voice status` say
  why (auto-join off, channel excluded, bot busy in another VC, reading-only)
  and what to do
- Automatic file cleanup after `RECORDING_RETENTION_HOURS` (default: 24 hours)
- Memory monitoring against `MEMORY_LIMIT_MB` (RSS): when usage passes 85% of
  the budget, connections holding audio buffers are disconnected first (oldest
  first), and text-to-speech-only joins last

**Notes:**

- Requires `Manage Server`
- Bot must be in the same voice channel
- Maximum concurrent VC connections: 5 (configurable)
- Opus decoding uses **`opusscript`** (pure JS, decoded to mono) instead of `@discordjs/opus` so installs stay free of vulnerable native prebuild chains; it supports about 29 simultaneous speakers per process, and CPU use can be higher than a native Opus build under heavy voice load. See [`docs/quality.md`](docs/quality.md) for dependency overrides.

### Text-to-speech (`/tts`)

Reads chat aloud in a voice channel using [VOICEVOX](https://voicevox.hiroshiba.jp/).
Available when the bot operator sets `VOICEVOX_URL` (see
[docs/deployment.md](docs/deployment.md#text-to-speech-optional)).

| Command                          | Description                                          |
| -------------------------------- | ---------------------------------------------------- |
| `/tts start`                     | Start reading this channel in your voice channel     |
| `/tts stop`                      | Stop reading                                         |
| `/tts skip`                      | Skip the message being read                          |
| `/tts voice [speaker] [speed]`   | Show or change your own voice (searchable) and speed |
| `/tts dict add <word> <reading>` | Teach the server how to read a word                  |
| `/tts dict remove <word>`        | Remove a reading                                     |
| `/tts dict list`                 | Show the server's dictionary                         |

**How it reads:**

- Messages from members **in the voice channel being read** are spoken, from
  the channel where `/tts start` was run and from the voice channel's own chat
- Start a message with `;` to keep it silent
- The speaker's name is announced when the speaker changes (or after a minute
  of quiet), so listeners know who is talking. Names are spoken on their own
  and remembered, so they play instantly
- A speaker's messages that are still waiting are read together as one
  sentence, with one name, when they fit in 100 characters
- A message still waiting 25 seconds after it was posted is skipped, so
  reading never falls far behind the chat
- URLs, code blocks, spoilers, and long messages are summarised (`URL省略`,
  `コード省略`, `ネタバレ`, `以下略`); mentions and custom emoji are read as
  names, other emoji are dropped, and trailing `www` is read as laughter.
  Fullwidth and halfwidth forms are read as their plain form (`ＡＢＣ` as ABC,
  `ｶﾀｶﾅ` as カタカナ)
- Dictionary words match however they are typed: `alice`, `ALICE` and
  `ａｌｉｃｅ` are one word, with one owner
- Each member picks their own voice; it follows them across servers
- Anyone can start reading or add dictionary words; only members in the
  channel being read (or with Manage Server) can stop or skip, and only the
  member who added a word (or Manage Server) can change or remove it
- If the server has turned auto-join off, the bot joins deafened and keeps no
  audio; it is unmuted only while a reading session is running. If auto-join
  is turned back on during the session, `/tts stop` hands the channel back to
  auto-join (and posts the buffering notice) instead of leaving
- Stage channels are not supported: the bot would join as a listener and could
  not be heard. In a text channel the bot cannot view, only the voice
  channel's own chat is read, and `/tts start` says so
- Credits: the public `/tts start` message names the VOICEVOX voices of the
  people in the channel (for example `VOICEVOX:ずんだもん`, the default). Any
  other character - someone who joins later, or switches voice, even from
  another server - is credited in the voice channel's chat the first time it
  is read in that session. Each character's own terms apply

### Captions (`/caption`)

Shows what people say in a voice channel as text in its chat, transcribed by a
self-hosted [Whisper](https://github.com/openai/whisper) engine. Available when
the bot operator sets `WHISPER_URL` (see
[docs/deployment.md](docs/deployment.md#captions-optional)).

| Command                    | Description                                                        |
| -------------------------- | ------------------------------------------------------------------ |
| `/caption start`           | Start captions in your voice channel                               |
| `/caption stop`            | Stop captions                                                      |
| `/caption consent [allow]` | Show, give or withdraw your consent to be captioned in this server |

**How it works:**

- **Only members who consented are captioned.** Everyone else's audio never
  reaches the engine. Consent is per server, given with `/caption consent` or
  the button on the public `/caption start` message, and can be withdrawn at
  any time; withdrawing also drops anything of yours not yet posted
- Each line is `**name**: text`, posted silently (no notification, no
  mentions) a few seconds after the speaker pauses; lines that arrive close
  together share one message, under Discord's rate limit
- Near-silent audio is not transcribed, and Whisper's well-known phantom lines
  (`ご視聴ありがとうございました`, `(音楽)` …) are dropped rather than posted
- Captions are only useful while the conversation is going on: when the engine
  falls behind, the oldest waiting speech is dropped, and speech still waiting
  after 20 seconds is skipped. If the engine keeps failing, the channel is told
  once
- One engine serves every server; servers take turns, as with text-to-speech
- Audio is never kept for captions. Where the server lets auto-join keep audio,
  the bot joins as auto-join would; where it does not, it joins listening only
  and keeps nothing for `/voice record`. Turning auto-join off later drops a
  connection that keeps audio, which ends captions through it (the channel is
  told how to resume without keeping audio)
- Anyone in a voice channel can start captions there; only members in that
  channel (or with Manage Server) can stop them. They end on their own when the
  channel empties

### Memory

A voice channel holds a ring buffer in memory once it has carried audio:
roughly `AUDIO_BUFFER_DURATION × 0.27 MB` (about 82MB at the 300s default).
The buffer is allocated on the first decoded chunk, so connections that never
hear anything stay free, and it is released on disconnect. With
`MAX_CONCURRENT_VC_CONNECTIONS=5` the worst case is about 410MB on top of the
bot's baseline, so `MEMORY_LIMIT_MB` (default 512) should match what your host
actually grants the container.

### Data Retention

The bot keeps operational data for limited periods and cleans it up automatically.

- `RECORDING_RETENTION_HOURS`: recording files in `data/recordings/` (default: 24 hours)
- `VOICE_SESSION_RETENTION_DAYS`: completed VC session rows (default: 30 days).
  `/notification stats` is not affected: durations are rolled up per day into
  `voice_daily_stats`, which is kept indefinitely
- `AUDIT_LOG_RETENTION_DAYS`: audit log rows (default: 90 days)
- `BACKUP_RETENTION_DAYS`: database backup files (default: 7 days)

See [`docs/database.md`](docs/database.md) for schema details and retention behavior.

## Available Scripts

| Script                     | Description                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------- |
| `npm run dev`              | Start with hot-reload (development)                                                 |
| `npm run build`            | Compile TypeScript to JavaScript                                                    |
| `npm start`                | Run compiled JavaScript locally (Railway runs `node dist/index.js` directly)        |
| `npm run lint`             | Check code with ESLint                                                              |
| `npm run lint:fix`         | Fix ESLint errors automatically                                                     |
| `npm run format`           | Format code with Prettier                                                           |
| `npm run format:check`     | Check code formatting                                                               |
| `npm run type-check`       | Check TypeScript types (source and tests)                                           |
| `npm test`                 | Run unit tests                                                                      |
| `npm run test:watch`       | Run tests in watch mode                                                             |
| `npm run test:coverage`    | Run tests with coverage report and enforce the coverage floors (what CI runs)       |
| `npm run audit:all`        | Run full + production-scoped `npm audit` (see [`docs/quality.md`](docs/quality.md)) |
| `npm run cleanup-commands` | Remove registered Discord commands                                                  |

## Project Structure

Feature-based architecture: each feature lives under `src/features/` and exports a lifecycle module from `index.ts`.

- `src/features/index.ts` is the single registry for feature startup and shutdown.
- `src/features/<feature>/commands/` contains only public slash command definitions.
- `src/features/<feature>/application/` is the internal command/application layer.
- `src/features/<feature>/repositories/` contains feature-specific persistence access.
- Feature runtime code should prefer explicit folders such as `integrations/`, `jobs/`, `recording/`, and `tracking/` over a generic `services/`.
- `src/infrastructure/` contains shared runtime infrastructure such as database bootstrap, backup, health, and metrics.
- `src/shared/` contains cross-feature utilities, shared types, and the shared help catalog.
- `src/app-scripts/` contains TypeScript maintenance scripts, while root `scripts/` contains repo workflow shell scripts.
- Dependency direction (features never import each other; lower layers never import features) is enforced by `src/__tests__/architecture.test.ts`.

See [`docs/architecture.md`](docs/architecture.md) for diagrams, the full directory tree and lifecycle rules.

## Documentation

- [`docs/architecture.md`](docs/architecture.md): system, runtime and dependency diagrams, directory structure, lifecycle
- [`docs/operations.md`](docs/operations.md): staging (`develop`) and production (`main`) environments, releases, hotfixes, rollbacks
- [`docs/development.md`](docs/development.md): command development, middleware, and local workflow scripts
- [`docs/database.md`](docs/database.md): SQLite tables and persistence notes
- [`docs/deployment.md`](docs/deployment.md): Railway deployment and CI/CD flow
- [`docs/quality.md`](docs/quality.md): quality standards and best practices

## License

MIT
