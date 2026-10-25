# Database

## Overview

The bot uses **SQLite** via [`better-sqlite3`](https://github.com/JoshuaWise/better-sqlite3) for data persistence.

- **Journal mode**: WAL (Write-Ahead Logging) for better concurrent read/write performance
- **Path**: Configurable via `DATABASE_PATH` env var; defaults to `data/bot.db` (relative to `process.cwd()`)
- **Location**: On Railway, the database lives under `/app/data` when `DATABASE_PATH` is `data/bot.db` and the project root is `/app`

Feature code should prefer feature-local repositories under `src/features/<feature>/repositories/` instead of importing shared database modules directly. `src/infrastructure/database/` is reserved for DB bootstrap and shared primitives.

---

## Architecture

```
src/infrastructure/database/
├── connection.ts    # Singleton DB connection, WAL mode, path resolution
├── transaction.ts  # runTransaction(fn) — synchronous transaction wrapper
├── migrations/
│   ├── index.ts             # Runs all migrations in order at startup
│   ├── 001_steam.ts         # Legacy Steam tables (kept for upgrade path; dropped by 005)
│   ├── 002_notifications.ts # Legacy Steam notification tables (dropped by 005)
│   ├── 003_settings.ts
│   ├── 004_notification.ts
│   └── 005_drop_steam.ts    # Drops legacy Steam tables on existing databases
└── index.ts        # Public exports
```

- **connection.ts**: Creates the SQLite connection, ensures the data directory exists, and sets `journal_mode = WAL`. Exports `database` and `closeDatabase()`.
- **transaction.ts**: Provides `runTransaction(fn)` to run a synchronous function inside a transaction. Commits on success, rolls back on error. Note: better-sqlite3 transactions do not support async functions.
- **migrations/**: Each migration file exports an `up()` function. Migrations run in order at startup via `initializeDatabase()`.

---

## Schema

### notification_channels

Per-guild notification channels by type.

| Column     | Type    | Constraints        |
| ---------- | ------- | ------------------ |
| guild_id   | TEXT    | NOT NULL           |
| type       | TEXT    | NOT NULL           |
| channel_id | TEXT    | NOT NULL           |
| enabled    | INTEGER | NOT NULL DEFAULT 1 |
| created_at | INTEGER | NOT NULL           |
| updated_at | INTEGER | NOT NULL           |

**Primary key:**

- `(guild_id, type)`

---

### voice_sessions

Raw per-user VC session history. Deleted after
`VOICE_SESSION_RETENTION_DAYS`; the durable numbers live in
`voice_daily_stats`.

| Column       | Type    | Constraints               |
| ------------ | ------- | ------------------------- |
| id           | INTEGER | PRIMARY KEY AUTOINCREMENT |
| guild_id     | TEXT    | NOT NULL                  |
| user_id      | TEXT    | NOT NULL                  |
| channel_id   | TEXT    | NOT NULL                  |
| channel_name | TEXT    | NOT NULL                  |
| joined_at    | INTEGER | NOT NULL                  |
| left_at      | INTEGER |                           |
| duration_ms  | INTEGER |                           |
| created_at   | INTEGER | NOT NULL                  |

**Indices:**

- `idx_voice_sessions_guild_user` ON `guild_id, user_id`
- `idx_voice_sessions_guild_channel` ON `guild_id, channel_id`
- `idx_voice_sessions_joined_at` ON `joined_at`

---

### voice_daily_stats

Daily rollup of VC time, and the only table `/notification stats` reads.

| Column            | Type    | Constraints                                   |
| ----------------- | ------- | --------------------------------------------- |
| guild_id          | TEXT    | NOT NULL, PK                                  |
| user_id           | TEXT    | NOT NULL, PK                                  |
| channel_id        | TEXT    | NOT NULL, PK                                  |
| channel_name      | TEXT    | NOT NULL                                      |
| day               | TEXT    | NOT NULL, PK (`YYYY-MM-DD`, process timezone) |
| total_duration_ms | INTEGER | NOT NULL                                      |
| session_count     | INTEGER | NOT NULL                                      |
| updated_at        | INTEGER | NOT NULL                                      |

**Indices:**

- `idx_voice_daily_stats_lookup` ON `guild_id, user_id, day`

`voiceSessionRepository.endSession()` folds a closed session into this table in
the same transaction that closes it, so a session is never counted in one place
and missing from the other. Nothing deletes these rows: they are what makes
"all time" mean all time rather than the last `VOICE_SESSION_RETENTION_DAYS`.

Because a day is the finest bucket kept, a `since` cutoff in a stats query is
rounded down to the start of its day.

---

### guild_settings

Per-guild settings (language, audit channel, announcement channel, voice
auto-join).

| Column                  | Type    | Constraints        |
| ----------------------- | ------- | ------------------ |
| guild_id                | TEXT    | PRIMARY KEY        |
| language                | TEXT    | DEFAULT 'ja'       |
| audit_channel_id        | TEXT    |                    |
| announcement_channel_id | TEXT    |                    |
| voice_autojoin_enabled  | INTEGER | NOT NULL DEFAULT 1 |
| created_at              | INTEGER | NOT NULL           |
| updated_at              | INTEGER | NOT NULL           |

`announcement_channel_id` NULL means the guild has not opted in to bot-owner
announcements, so `/owner system broadcast` skips it.

`language` NULL means "follow each viewer's Discord client locale" — the `auto`
choice in `/admin settings language`. Rows inserted for other settings leave it
NULL so a guild is never pinned to a language it did not choose.

---

### polls

Where a user's open poll lives, so `/community poll end` can find it. Discord
owns the poll itself — question, answers, voters, and closing time — so nothing
here is authoritative: losing a row costs the creator the shortcut, not the
poll.

| Column     | Type    | Constraints |
| ---------- | ------- | ----------- |
| message_id | TEXT    | PRIMARY KEY |
| guild_id   | TEXT    | NOT NULL    |
| channel_id | TEXT    | NOT NULL    |
| creator_id | TEXT    | NOT NULL    |
| expires_at | INTEGER | NOT NULL    |
| created_at | INTEGER | NOT NULL    |

**Indices:**

- `idx_polls_creator` ON `creator_id, channel_id`

Rows past `expires_at` are pruned daily by the community feature.

---

### voice_autojoin_exclusions

Voice channels the bot must not join or buffer audio in.

| Column     | Type    | Constraints |
| ---------- | ------- | ----------- |
| guild_id   | TEXT    | NOT NULL    |
| channel_id | TEXT    | NOT NULL    |
| created_at | INTEGER | NOT NULL    |

PRIMARY KEY (`guild_id`, `channel_id`)

---

### tts_user_settings

Each user's text-to-speech voice. Keyed by user alone so a voice follows the
person across servers.

| Column     | Type    | Constraints          |
| ---------- | ------- | -------------------- |
| user_id    | TEXT    | PRIMARY KEY          |
| speaker_id | INTEGER | NOT NULL             |
| speed      | REAL    | NOT NULL DEFAULT 1.0 |
| updated_at | INTEGER | NOT NULL             |

---

### tts_dictionary

A server's reading dictionary for text-to-speech (`/tts dict`). At most 200
entries per guild.

| Column     | Type    | Constraints |
| ---------- | ------- | ----------- |
| guild_id   | TEXT    | NOT NULL    |
| word_key   | TEXT    | NOT NULL    |
| word       | TEXT    | NOT NULL    |
| reading    | TEXT    | NOT NULL    |
| created_by | TEXT    | NOT NULL    |
| created_at | INTEGER | NOT NULL    |

PRIMARY KEY (`guild_id`, `word_key`)

`word_key` is the word folded the way it is matched against chat (NFKC, then
lower case), so case and width variants ("ALICE", "ａｌｉｃｅ", "CAFÉ"/"café")
are one entry with one owner. `word` keeps the latest spelling for display.
`created_by`/`created_at` record who first added the word; updates keep them.

---

### audit_logs

Audit log entries for admin actions.

| Column     | Type    | Constraints               |
| ---------- | ------- | ------------------------- |
| id         | INTEGER | PRIMARY KEY AUTOINCREMENT |
| guild_id   | TEXT    | NOT NULL                  |
| user_id    | TEXT    | NOT NULL                  |
| action     | TEXT    | NOT NULL                  |
| target_id  | TEXT    |                           |
| details    | TEXT    |                           |
| created_at | INTEGER | NOT NULL                  |

**Indices:**

- `idx_audit_logs_guild_id` ON `guild_id`
- `idx_audit_logs_created_at` ON `created_at`

---

## AuditAction Types

The `action` column in `audit_logs` stores one of these values:

| Value             | Description                   |
| ----------------- | ----------------------------- |
| `NOTIFY_SETUP`    | Notification setup            |
| `NOTIFY_ENABLE`   | Notifications enabled         |
| `NOTIFY_DISABLE`  | Notifications disabled        |
| `NOTIFY_REMOVE`   | Notification settings removed |
| `SETTINGS_CHANGE` | Guild settings changed        |
| `AUDIT_SETUP`     | Audit log channel configured  |
| `ROLE_ADD`        | Role granted to a member      |
| `ROLE_REMOVE`     | Role removed from a member    |

Defined in `src/features/admin/repositories/auditRepository.ts`.

---

## Repository Ownership

| Tables                                                   | Feature        | Repositories                                                    |
| -------------------------------------------------------- | -------------- | --------------------------------------------------------------- |
| notification_channels, voice_sessions, voice_daily_stats | notification   | `notificationChannelRepository.ts`, `voiceSessionRepository.ts` |
| guild_settings                                           | infrastructure | `infrastructure/guildSettings/index.ts`                         |
| audit_logs                                               | infrastructure | `infrastructure/audit/auditRepository.ts`                       |
| polls                                                    | community      | `poll/pollRepository.ts`                                        |
| voice_autojoin_exclusions                                | voice          | `repositories/voiceSettingsRepository.ts`                       |
| tts_user_settings, tts_dictionary                        | voice          | `repositories/ttsRepository.ts`                                 |

`guild_settings` and `audit_logs` are owned by infrastructure rather than a
feature because several features read them: locale resolution reads
`language`, the audit service reads `audit_channel_id`, owner broadcasts read
`announcement_channel_id`, and voice reads `voice_autojoin_enabled`. Every write to `guild_settings` goes through
`guildSettingsRepository.update()`, which is enforced by
`src/__tests__/architecture.test.ts`.

All repositories live under `src/features/<feature>/repositories/`.

---

## Migration System

Migrations live in `src/infrastructure/database/migrations/` and are run in order at startup:

1. `001_steam.ts` — Legacy: steam_users, playtime_history (kept for upgrade path; tables are dropped by 005)
2. `002_notifications.ts` — Legacy: notification_settings, user_notification_prefs, game_activity_cache (dropped by 005)
3. `003_settings.ts` — guild_settings, audit_logs
4. `004_notification.ts` — notification_channels, voice_sessions
5. `005_drop_steam.ts` — Drops the legacy Steam tables created by 001 and 002 on existing databases
6. `006_polls.ts` — polls, poll_votes (both superseded by 010)
7. `007_voice_autojoin.ts` — voice_autojoin_exclusions, plus `guild_settings.voice_autojoin_enabled`
8. `008_announcement_channel.ts` — `guild_settings.announcement_channel_id`
9. `009_voice_daily_stats.ts` — voice_daily_stats, backfilled once from existing `voice_sessions`
10. `010_native_polls.ts` — drops poll_votes and the custom `polls` schema, replacing it with the message pointer Discord's native polls need
11. `011_tts.ts` — tts_user_settings, tts_dictionary

`initializeDatabase()` runs all migrations inside a single transaction. It is safe to call multiple times; migrations use `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, and `DROP TABLE IF EXISTS`. Initialization is performed once per process.

SQLite has no `ADD COLUMN IF NOT EXISTS`, so migrations that add a column check `PRAGMA table_info` first (see `007_voice_autojoin.ts`) — every migration re-runs on each boot.

### Rollback Policy

Migrations do not define `down()` functions. To roll back schema changes:

1. Create a new migration that reverses the change (e.g. `DROP TABLE` or `DROP COLUMN`).
2. Or restore from a backup taken before the migration: set `RESTORE_BACKUP` and redeploy (see [operations.md](operations.md#restoring-a-backup)).
3. For development, deleting the database file and re-running the bot will re-apply all migrations from scratch.

---

## ER Diagram

```mermaid
erDiagram
    notification_channels {
        text guild_id PK
        text type PK
        text channel_id
        integer enabled
        integer created_at
        integer updated_at
    }

    voice_sessions {
        integer id PK
        text guild_id
        text user_id
        text channel_id
        text channel_name
        integer joined_at
        integer left_at
        integer duration_ms
        integer created_at
    }

    guild_settings {
        text guild_id PK
        text language
        text audit_channel_id
        text announcement_channel_id
        integer voice_autojoin_enabled
        integer created_at
        integer updated_at
    }

    polls {
        text message_id PK
        text guild_id
        text channel_id
        text creator_id
        integer expires_at
        integer created_at
    }

    voice_autojoin_exclusions {
        text guild_id PK
        text channel_id PK
        integer created_at
    }

    tts_user_settings {
        text user_id PK
        integer speaker_id
        real speed
        integer updated_at
    }

    tts_dictionary {
        text guild_id PK
        text word_key PK
        text word
        text reading
        text created_by
        integer created_at
    }

    audit_logs {
        integer id PK
        text guild_id
        text user_id
        text action
        text target_id
        text details
        integer created_at
    }
```

---

## Retention Policy

Runtime retention is configured with environment variables and enforced by feature cleanup jobs.

- `RECORDING_RETENTION_HOURS` (default: `24`): deletes `.wav` recording files from `data/recordings/`
- `VOICE_SESSION_RETENTION_DAYS` (default: `30`): deletes completed `voice_sessions` rows older than the cutoff. Statistics are unaffected — the durations were already rolled up into `voice_daily_stats`, which retention does not touch
- `AUDIT_LOG_RETENTION_DAYS` (default: `90`): deletes old `audit_logs` rows
- `BACKUP_RETENTION_DAYS` (default: `7`): deletes old backup files

Active or incomplete voice sessions are not deleted by retention cleanup; they are first closed on startup if they were left open by a previous run.

---

## Persistence on Railway

When deploying to Railway, add a **Volume** with Mount Path `/app/data` to prevent data loss on redeployments. This directory may contain:

- The SQLite database
- Backups
- Voice recordings
- Disk buffers

Ensure `DATABASE_PATH` points to a path under `/app/data` (e.g. `data/bot.db` when the project root is `/app`). See [Deployment](deployment.md) for details.

[← Back to README](../README.md)
