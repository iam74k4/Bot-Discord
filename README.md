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

- Slash command support with automatic registration
- **Voice channel recording** (restricted past-audio recording with `/voice record`)
- VC join/leave and member-join notifications, plus per-user VC time stats
- Community features (native Discord polls, VC roulette)
- Admin system (`/admin` server settings, `/owner` bot-owner tools)
- Audit logging for role changes, notification setup, and settings changes
- Middleware system (permissions, cooldown)
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
4. **Enable Privileged Intents**: Go to "Bot" > Enable `SERVER MEMBERS INTENT`
5. Go to "OAuth2" > "General" and copy the Client ID
6. Go to "OAuth2" > "URL Generator":
   - Select scopes: `bot`, `applications.commands`
   - Select bot permissions: `Send Messages`, `Use Slash Commands`, `Embed Links`
   - Use the generated URL to invite the bot to your server

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

| Command          | Description                |
| ---------------- | -------------------------- |
| `/general ping`  | Check bot latency          |
| `/general help`  | Show command list and help |
| `/general about` | Show bot overview          |

### Notification (`/notification`)

| Command                               | Description                            |
| ------------------------------------- | -------------------------------------- |
| `/notification voice set <channel>`   | Set VC join/leave notification channel |
| `/notification voice disable`         | Disable VC join/leave notifications    |
| `/notification welcome set <channel>` | Set member join notification channel   |
| `/notification welcome disable`       | Disable member join notifications      |
| `/notification status`                | Show current notification settings     |
| `/notification stats [period]`        | Show your VC time statistics           |

VC notifications are throttled: the first change is posted right away, then
anything happening in the next 30 seconds is collapsed into one summary. A
channel filling up costs two messages instead of ten, moving between channels
reads as a single line, and someone who drops in and out inside the window is
not announced at all.

### Admin (`/admin`)

Requires **Manage Server** in the guild (slash command default permission).

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

### Bot owner (`/owner`)

Only users listed in `BOT_OWNER_IDS` can run these commands (can be used in DMs with the bot).

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

| Command                                          | Description                                 |
| ------------------------------------------------ | ------------------------------------------- |
| `/community poll create <question> <options...>` | Create a native Discord poll (2-10 options) |
| `/community poll end`                            | Close your poll early                       |
| `/community roulette member`                     | Randomly select one member from VC          |
| `/community roulette team <count>`               | Divide voice channel members into teams     |

**Options:**

- `question`: Poll question, up to 300 characters (required)
- `option1` to `option10`: Choices, up to 55 characters each (at least 2 required, up to 10)
- `duration`: How long the poll stays open — 1h, 4h, 8h, 24h, 3d, or 7d (default: 24h)
- `multi`: Let people pick more than one option (default: false)

Polls use Discord's own poll feature, so voting, the running tally, and closing
are handled by Discord itself: results survive a bot restart, and everyone sees
the same native UI on desktop and mobile. The bot only stores which message a
poll is in, so `/community poll end` can close it before its deadline.

Discord's minimum poll duration is one hour, so the old 5/10/30-minute options
are gone — use `/community poll end` to close a short poll when you are done.

### Voice (`/voice`)

| Command                             | Description                                   |
| ----------------------------------- | --------------------------------------------- |
| `/voice record <duration>`          | Record past audio from your voice channel     |
| `/voice status`                     | Show buffer window, auto-join state, capacity |
| `/voice autojoin enable`            | Allow the bot to join occupied voice channels |
| `/voice autojoin disable`           | Stop joining and buffering in this server     |
| `/voice autojoin exclude <channel>` | Keep the bot out of one voice channel         |
| `/voice autojoin include <channel>` | Remove a channel from the exclusion list      |

**Options:**

- `duration`: Recording duration (e.g., `30s`, `1m`, `5m`, max 5 minutes). A
  recording cannot be longer than `AUDIO_BUFFER_DURATION`, which is why raising
  that setting above `MAX_RECORDING_DURATION` only costs memory.

**Features:**

- Auto-join: Bot automatically joins voice channels when users enter, and keeps
  a rolling window of that channel's audio so `/voice record` can reach backwards
  in time
- Disclosure: on joining, the bot posts once into the voice channel's own text
  chat saying audio is being kept and how to turn it off
- Opt-out: `/voice autojoin disable` (whole server) or
  `/voice autojoin exclude <channel>` (one channel). Both also drop any
  connection already buffering
- In-memory ring buffer of `AUDIO_BUFFER_DURATION` seconds (default: 300 = 5
  minutes), about **82MB per voice channel**, allocated the first time someone
  actually speaks — a channel the bot sits in silently costs nothing. Multiply
  by `MAX_CONCURRENT_VC_CONNECTIONS` for the worst case when sizing your host
- WAV format output at 48kHz/16bit/mono (~27.5MB for 5 minutes)
- Private delivery: Recording responses and files are sent ephemerally
- Automatic file cleanup after `RECORDING_RETENTION_HOURS` (default: 24 hours)
- Memory monitoring against `MEMORY_LIMIT_MB` (RSS), disconnecting the oldest
  connections when usage passes 85% of the budget

**Notes:**

- Requires `Manage Server`
- Bot must be in the same voice channel
- Maximum concurrent VC connections: 5 (configurable)
- Opus decoding uses **`opusscript`** (pure JS) instead of `@discordjs/opus` so installs stay free of vulnerable native prebuild chains; CPU use can be higher than a native Opus build under heavy voice load. See [`docs/quality.md`](docs/quality.md) for dependency overrides.

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
| `npm start`                | Run compiled JavaScript (production)                                                |
| `npm run lint`             | Check code with ESLint                                                              |
| `npm run lint:fix`         | Fix ESLint errors automatically                                                     |
| `npm run format`           | Format code with Prettier                                                           |
| `npm run format:check`     | Check code formatting                                                               |
| `npm run type-check`       | Check TypeScript types                                                              |
| `npm test`                 | Run unit tests                                                                      |
| `npm run test:watch`       | Run tests in watch mode                                                             |
| `npm run test:coverage`    | Run tests with coverage report                                                      |
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

See [`docs/architecture.md`](docs/architecture.md) for the full structure and lifecycle rules.

## Documentation

- [`docs/architecture.md`](docs/architecture.md): project structure and lifecycle
- [`docs/development.md`](docs/development.md): command development, middleware, and local workflow scripts
- [`docs/database.md`](docs/database.md): SQLite tables and persistence notes
- [`docs/deployment.md`](docs/deployment.md): Railway deployment and CI/CD flow
- [`docs/quality.md`](docs/quality.md): quality standards and best practices

## License

MIT
