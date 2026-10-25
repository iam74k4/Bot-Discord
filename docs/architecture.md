# Architecture

The bot is one Node.js process built as a **modular monolith**: features are
self-contained folders under `src/features/`, assembled by a single
composition root, and kept apart by dependency rules that a test enforces
(`src/__tests__/architecture.test.ts`). This page goes from the outside in:
the system around the bot, the process, a feature, and the files on disk.

How the bot is deployed, released and run in staging and production is in
[operations.md](operations.md).

## System context

```mermaid
flowchart LR
  members(["Server members"])

  subgraph discord["Discord"]
    gateway["Gateway (WebSocket events)"]
    rest["REST API (replies, command registration)"]
    voice["Voice servers (UDP, DAVE end-to-end encryption)"]
  end

  subgraph railway["Railway project (one environment)"]
    bot["Bot service (Node.js 22)"]
    volume[("Volume /app/data: SQLite, backups, recordings")]
    voicevox["VOICEVOX engine (optional, private network only)"]
  end

  webhook["Alert webhook (a Discord channel)"]

  members <--> discord
  gateway -- "events" --> bot
  bot -- "responses" --> rest
  bot <-- "Opus audio" --> voice
  bot <--> volume
  bot -- "HTTP: audio_query / synthesis" --> voicevox
  bot -- "crashes, memory pressure" --> webhook
```

- **Gateway intents**: `Guilds`, `GuildVoiceStates`, `GuildMembers`
  (privileged), and - only when `VOICEVOX_URL` is set - `GuildMessages` and
  `MessageContent` (privileged) for text-to-speech.
- **State** lives in one SQLite file on the volume. There is no other database,
  cache server, or queue: one process owns everything, which keeps shutdown,
  backups and migrations simple. It also means one replica per environment -
  see [Scaling limits](#scaling-limits).
- **VOICEVOX** is reachable only over Railway private networking and is never
  exposed to the internet.

## Inside the process

Every Discord event enters through the auto-loaded event listeners. Slash
commands then pass one router and one middleware pipeline before reaching a
feature; feature events (voice state, messages) go straight to the feature
that registered them.

```mermaid
flowchart TD
  gw["Discord Gateway"] --> loader["handlers/eventHandler (auto-loaded listeners)"]

  loader --> core["events/ (core)"]
  loader --> fevents["features/*/events/"]

  core --> ready["client/ready: presence, command registration, allowlist report"]
  core --> join["client/guildCreate: leave servers outside ALLOWED_GUILD_IDS"]
  core --> ic["interaction/interactionCreate"]

  ic --> router["app/interactions/interactionRouter"]
  router --> allow{"server allowed?"}
  allow -- "no" --> refuse["ephemeral refusal"]
  allow -- "yes" --> mw["middleware: permissions, cooldown"]
  mw --> cmd["features/*/commands"]
  cmd --> appl["features/*/application"]

  fevents --> appl
  appl --> repo["features/*/repositories (SQL)"]
  appl --> runtime["features/*/recording, tts, tracking, jobs"]
  appl --> infra["infrastructure: guildSettings, audit, metrics"]
  repo --> db[("infrastructure/database: SQLite")]
  infra --> db
```

Buttons, select menus and modals never reach the router: each panel collects
the components on the message it sent (`runComponentPanel()` in
`src/shared/utils/panel.ts`), so the router cannot answer an interaction a
panel is about to handle.

## Layers

```mermaid
flowchart LR
  subgraph Entry
    commands["commands"]
    events["events"]
  end
  subgraph Logic
    application["application"]
  end
  subgraph Data
    repositories["repositories"]
    runtimeFolders["recording / tts / tracking / jobs / poll"]
  end
  subgraph Infrastructure
    database["database (connection, migrations)"]
    sharedInfra["guildSettings / audit / backup / metrics / health"]
  end

  commands --> application
  events --> application
  application --> repositories
  application --> runtimeFolders
  application --> sharedInfra
  repositories --> database
  sharedInfra --> database
```

- **commands**: Slash command definitions. They delegate to `application/` and
  never import `repositories/` or `infrastructure/`.
- **events**: Gateway listeners a feature owns (for example
  `voiceStateUpdate`). They call into `application/` too.
- **application**: The use cases - what a command or event does. Orchestrates
  repositories and the feature's runtime folders.
- **repositories**: Real SQL against the feature's own tables. Multi-table
  writes go through `runTransaction()`.
- **runtime folders**: Stateful, feature-owned machinery with explicit names -
  `recording/`, `tts/`, `tracking/`, `jobs/`, `poll/` - rather than a generic
  `services/`.
- **shared infrastructure**: State and services several features use, with
  their own tables - `guildSettings` owns `guild_settings`, `audit` owns
  `audit_logs`. Features use them; they never depend on a feature.
- **database**: Connection, pragmas, transactions and migrations only. No
  feature queries.

### Dependency rules

```mermaid
flowchart BT
  shared["shared / locales / config"]
  infra["infrastructure"]
  mw["middleware / handlers"]
  features["features/* (never each other)"]
  registry["features/index.ts (registry)"]
  app["app (composition root, router)"]
  entry["index.ts (process)"]

  infra --> shared
  mw --> shared
  features --> infra
  features --> shared
  registry --> features
  app --> registry
  app --> mw
  app --> infra
  entry --> app
```

Arrows point from the importer to what it may import. Each rule below is a
test case in `src/__tests__/architecture.test.ts`, so breaking one fails CI:

- `infrastructure`, `shared`, `locales`, `middleware`, `config` and `handlers`
  never import a feature.
- `app` reaches features only through the registry (`features/index.ts`).
- Features never import each other. Anything two features need moves down to
  `infrastructure/` or `shared/`.
- `src/index.ts` gets the bot only from `app/composition.ts`.
- `commands/` never import `repositories/` or `infrastructure/`.
- Only `infrastructure/guildSettings` (and the database layer) writes SQL for
  `guild_settings`.
- Test files live in `__tests__/` directories, so none is compiled into
  `dist/`.

## Features

| Feature        | Commands           | Owns                                                                    |
| -------------- | ------------------ | ----------------------------------------------------------------------- |
| `admin`        | `/admin`, `/owner` | Server settings panel, role tools, owner system panel, DB statistics    |
| `community`    | `/community`       | Native Discord polls (`poll/`), VC roulette                             |
| `general`      | `/general`         | Help (built from the shared help catalog), ping                         |
| `notification` | `/notification`    | VC join/leave and member-join notices, VC time tracking and daily stats |
| `voice`        | `/voice`, `/tts`   | The voice connection, past-audio recording, auto-join, text-to-speech   |

Every feature exports `name`, `start(context)` and `stop()` from its
`index.ts`, and is discovered automatically:

- `loadFeatures()` scans `src/features/*/index.ts`; there is no manual
  registration.
- `startAllFeatures({ client, config })` runs after the gateway is ready, so a
  feature's `start` may rely on warmed guild caches. A feature that fails to
  start is isolated and reported in health status; the others still start.
- Features receive configuration through `FeatureContext` and must not import
  `env` to start themselves. Nothing is constructed at import time.
- `commands/` holds only the public slash command files the command handler
  auto-loads; internal logic lives in `application/`.

### Why text-to-speech lives inside `voice`

Discord lets a bot hold **one voice connection per server**. Recording,
auto-join and text-to-speech all need that connection, so exactly one module
must own it - `voice/recording/connectionManager.ts` - and arbitrate between
them: whether a join may buffer audio, who may disconnect, which connection
to shed under memory pressure.

```mermaid
flowchart LR
  subgraph voice["features/voice"]
    record["application/record.ts (/voice record)"]
    autojoin["application/autojoin.ts + events/voiceStateUpdate"]
    tts["application/tts.ts + events/ttsMessage"]
    cm["recording/connectionManager (one connection per server)"]
    ring["recording/channelMixRing (past-audio buffer)"]
    tsm["tts/sessionManager (queue, playback)"]
    vv["tts/voicevoxClient"]
    mem["jobs/memoryMonitor"]
  end

  record --> cm
  autojoin --> cm
  tts --> tsm
  tsm --> cm
  tsm --> vv
  cm --> ring
  mem -- "shed oldest connection" --> cm
```

A separate `tts` feature would have to import `connectionManager` from
`voice`, which "features never import each other" forbids for good reason:
the two would change in lockstep anyway. Keeping them together is the honest
boundary. If a third, unrelated consumer of the connection appears, move the
connection manager to `infrastructure/voice/` and split the features along it.

## Lifecycle

```mermaid
flowchart TD
  main["src/index.ts: loadConfig, installProcessHandlers"] --> createApp["createApp(config)"]
  createApp --> initDb["initializeDatabase(): run migrations"]
  initDb --> loadFeatures["loadFeatures()"]
  loadFeatures --> loadDiscord["loadCommands() + loadEvents()"]
  loadDiscord --> login["client.login()"]
  login --> ready["ClientReady"]
  ready --> featureStart["startAllFeatures({ client, config })"]
  featureStart --> backupStart["backupService.start() + startAuditRetention()"]
  backupStart --> running["running"]
  running -- "SIGTERM / SIGINT / uncaught error" --> shutdown["app.stop()"]
  shutdown --> finalBackup["runBackup() if SHUTDOWN_FINAL_BACKUP"]
  finalBackup --> backupStop["backupService.stop() + stopAuditRetention()"]
  backupStop --> featureStop["stopAllFeatures() in reverse order"]
  featureStop --> cooldowns["cooldownStore.clearAll()"]
  cooldowns --> closeDb["closeDatabase()"]
  closeDb --> destroyClient["client.destroy()"]
```

Every shutdown step runs even if an earlier one throws, so a feature that
hangs cannot leave the database open. `app/processHandlers.ts` bounds the
whole shutdown by `SHUTDOWN_TIMEOUT_MS` and exits non-zero after a crash so
Railway's `ON_FAILURE` policy restarts the bot.

## Composition root

`src/app/composition.ts` is the single place the running bot is assembled.
`createApp(config, deps)` builds the object graph and returns `start()` and
`stop()`; `src/index.ts` keeps only what belongs to the process - reading
configuration, signal handlers, and last-resort crash reporting.

`deps` defaults to the real collaborators and can be replaced wholesale, so
`src/app/__tests__/composition.test.ts` drives the real startup and shutdown
sequence with fakes instead of mocking module paths. Order is a correctness
property here - the database opens before anything queries it, features start
only after the gateway is ready, and the final backup runs while the
connection is still open - so it is asserted, not assumed.

**What is deliberately not injected:** `config` and the database connection.
Both are process-wide resources with an explicit lifecycle (`loadConfig`,
`closeDatabase`), and their consumers are reached through Discord interaction
handlers whose signature the library fixes. Threading them down would mean a
module-level context holder set during startup - the same global with extra
steps and a temporal coupling on top. Tests override both by mocking
`config/index.js` and `database/connection.js`.

## Database

- `infrastructure/database/` is pure infrastructure: connection management,
  `runTransaction()`, and migrations. All feature SQL lives in that feature's
  `repositories/` (or its runtime folder, such as `community/poll/`).
- Migrations are numbered files (`001_steam.ts` … `011_tts.ts`) applied by
  `initializeDatabase()` on **every boot**, so each one must be safe to re-run
  against a database it has already migrated: a column is added only after
  checking `PRAGMA table_info`, and a migration never rewrites a table that a
  later migration replaced. `migrationsReboot.test.ts` applies the full set
  three times to one database to keep that true.
- Migrations 001 and 002 are kept untouched for a clean upgrade path from the
  removed Steam feature; `005_drop_steam.ts` drops those tables.

See [database.md](database.md) for the schema.

## Scaling limits

The design trades horizontal scale for simplicity, on purpose:

- **One replica per environment.** Two processes with the same token would
  both answer every interaction and fight over voice connections, and SQLite
  on a volume has a single writer. Keep Railway replicas at 1.
- **No sharding.** Discord requires sharding from 2,500 servers. Before the
  bot gets close, the in-memory state (cooldowns, voice sessions, metrics)
  has to move out of the process.
- **Voice memory scales per connection** (`AUDIO_BUFFER_DURATION × 0.27MB` per
  channel), capped by `MAX_CONCURRENT_VC_CONNECTIONS` and shed by the memory
  monitor. See [deployment.md](deployment.md).

## Directory structure

```text
.
├── .github/
│   ├── workflows/                # ci, codeql, dependency-audit, release
│   ├── pull_request_template.md  # Default PR checklist
│   ├── PULL_REQUEST_TEMPLATE/
│   │   └── release.md            # develop → main release PR
│   └── dependabot.yml
├── docs/                         # architecture, operations, deployment, database, development, quality
├── scripts/                      # validate.sh (CI parity), pre-push.sh (git hook), audit-all.sh
├── railway.toml                  # Start command, draining, restart policy
├── nixpacks.toml                 # Native build deps (libopus, python for node-gyp)
├── tsconfig.json                 # Build (excludes tests)
├── tsconfig.test.json            # Type-checks tests too
├── vitest.config.ts              # Tests + coverage floors
└── src/
    ├── index.ts                  # Process entry: config, signals, crash reporting
    ├── client.ts                 # Discord client: intents, cache limits
    ├── app/
    │   ├── composition.ts        # Composition root: what the bot is made of, in order
    │   ├── processHandlers.ts    # Signals, uncaught errors, bounded graceful shutdown
    │   ├── guildAllowlist.ts     # ALLOWED_GUILD_IDS check
    │   └── interactions/
    │       ├── commandRegistry.ts    # Command discovery + registration payload
    │       └── interactionRouter.ts  # Slash commands and autocomplete
    ├── app-scripts/
    │   └── cleanup-commands.ts   # npm run cleanup-commands
    ├── config/
    │   ├── schema.ts             # Pure parsing + validation of the environment
    │   ├── env.ts                # loadConfig(), lazy `env`
    │   ├── constants.ts          # Non-configurable constants (audio format, limits)
    │   └── index.ts
    ├── events/                   # Core gateway listeners
    │   ├── client/
    │   │   ├── ready.ts          # Presence, command registration, allowlist report
    │   │   └── guildCreate.ts    # Leave servers outside ALLOWED_GUILD_IDS
    │   └── interaction/
    │       └── interactionCreate.ts  # Hands interactions to the router
    ├── handlers/
    │   ├── commandHandler.ts     # Load commands, register them with Discord
    │   └── eventHandler.ts       # Load core + feature events
    ├── middleware/
    │   ├── index.ts              # runMiddleware() pipeline
    │   ├── permissions.ts
    │   └── cooldown/             # Cooldown middleware + store
    ├── features/
    │   ├── index.ts              # Registry: discovery, FeatureContext, start/stop all
    │   ├── admin/
    │   │   ├── commands/         # admin.ts (/admin), owner.ts (/owner)
    │   │   ├── application/      # settings, settingsPanel, role, owner, systemPanel
    │   │   └── repositories/     # databaseStatsRepository
    │   ├── community/
    │   │   ├── commands/         # roulette.ts (/community)
    │   │   ├── application/      # roulette
    │   │   └── poll/             # Native polls: application + pollRepository
    │   ├── general/
    │   │   ├── commands/         # general.ts (/general)
    │   │   └── application/      # help, ping
    │   ├── notification/
    │   │   ├── commands/         # notification.ts (/notification)
    │   │   ├── application/      # panel, stats, voiceDigest
    │   │   ├── events/           # voiceNotification, memberJoinNotification
    │   │   ├── repositories/     # notificationChannel, voiceSession
    │   │   └── tracking/         # voiceTracker
    │   └── voice/
    │       ├── commands/         # record.ts (/voice), tts.ts (/tts)
    │       ├── application/      # record, autojoin, reconcile, status, announce, tts
    │       ├── events/           # voiceStateUpdate, ttsMessage
    │       ├── recording/        # connectionManager, channelMixRing, recordingService
    │       ├── tts/              # voicevoxClient, sessionManager, textNormalizer, wav
    │       ├── repositories/     # voiceSettings, tts
    │       └── jobs/             # fileCleanup, memoryMonitor
    ├── infrastructure/
    │   ├── database/
    │   │   ├── connection.ts     # Connection, pragmas, close
    │   │   ├── transaction.ts    # runTransaction()
    │   │   └── migrations/       # 001_steam … 011_tts; index.ts = initializeDatabase()
    │   ├── guildSettings/        # Sole owner of guild_settings
    │   ├── audit/                # audit_logs: repository, format, retention
    │   ├── backup/               # Scheduled SQLite backups (storage/)
    │   ├── health/               # Health status (memory, per-feature)
    │   └── metrics/              # In-memory counters
    ├── shared/
    │   ├── help/catalog.ts       # Help catalog built from command definitions
    │   ├── types/                # Command, Event, middleware, voice types
    │   └── utils/                # logger, embed, panel, confirm, retry, alert, cleanup …
    └── locales/                  # en, ja, per-server locale resolution
```

Each feature also has an `index.ts` (its lifecycle) and a `__tests__/`
directory. Shared test helpers and cross-cutting tests - the architecture
rules, the all-commands smoke harness - live in `src/__tests__/`.

## Known debts

Not wrong enough to block work, but recorded so they get fixed on purpose
rather than copied:

- **Some command files are named after an old command.**
  `voice/commands/record.ts` defines `/voice` and
  `community/commands/roulette.ts` defines `/community`; both predate their
  commands growing subcommands. Rename them (`voice.ts`, `community.ts`) in a
  change of their own, when no other branch is editing them.
- **`voice` is the largest feature.** That is the cost of the single
  connection owner described above, not an accident; split it only along the
  connection manager.

## Scripts

- `src/app-scripts/`: TypeScript scripts that operate on the application or
  Discord state (`npm run cleanup-commands`).
- `scripts/`: shell scripts for repository workflow - `validate.sh` mirrors CI,
  `pre-push.sh` is the git hook that runs it.

[← Back to README](../README.md)
