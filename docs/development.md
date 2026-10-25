# Development Guide

## Adding a New Feature

The bot uses an **auto-discovery system** for features. You do not need to register features manually.

1. Create a directory under `src/features/<name>/`:

```
src/features/myfeature/
├── index.ts          # Required: exports { name, start, stop }
├── commands/         # Slash commands (auto-loaded)
├── application/      # Business logic
├── repositories/     # Database access
├── __tests__/        # Unit tests (required for new features)
└── ...               # Optional: integrations/, jobs/, tracking/, recording/
```

2. Export the required interface from `index.ts`:

```typescript
import type { FeatureContext } from '../index.js';

export const name = 'myfeature';

export function start({ client, config }: FeatureContext): void {
  // Startup logic (e.g., register event listeners)
}

export function stop(): void {
  // Cleanup logic
}
```

The composition root hands you `client` and the validated `config`; do not
import `env` to start a feature, and do not construct anything at import time.
A feature that needs a long-lived object should build it in `start` and drop it
in `stop`, the way `voice` does with its jobs.

3. **No manual registration** — features are discovered by scanning subdirectories of `src/features/`. Each feature must export `{ name, start, stop }` from its `index.ts`.

4. Add unit tests under `__tests__/` (e.g. `__tests__/index.test.ts`, `__tests__/application/myHandler.test.ts`).

5. Optional subdirectories:
   - `commands/` — Slash command files (auto-loaded by the handler)
   - `application/` — Business logic, separate from command definitions
   - `repositories/` — Database access layer
   - `integrations/`, `jobs/`, `tracking/`, `recording/` — Prefer explicit runtime boundaries when the responsibility is clear
   - `__tests__/` — Feature-specific tests

## Adding New Commands

1. Create a new feature directory `src/features/<name>/commands/` or add to an existing one:

```typescript
import { SlashCommandBuilder } from 'discord.js';
import { Command } from '../../../shared/types/index.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('mycommand')
    .setDescription('My command description'),

  middleware: ['cooldown'], // Optional

  options: {
    cooldown: 5000, // Optional: 5 seconds (default 3 s)
    // Optional, per subcommand path; the longest prefix wins, 0 turns it off.
    // cooldowns: { 'mycommand slow': 10_000 },
  },

  async execute(interaction) {
    await interaction.reply('Hello!');
  },
};
```

2. The command will be automatically loaded from `features/*/commands/` on next restart.

3. Declare who may use it in `COMMAND_POLICY`
   (`src/__tests__/integration/commands/command-smoke.helpers.ts`): its default
   member permissions, contexts, cooldowns and autocomplete options. The
   payload and smoke tests fail until the policy and the command agree, and
   then run every path of the new command automatically.

Guidelines that keep commands consistent:

- Admin-only commands set `setDefaultMemberPermissions(...)` so members do not
  see them, and still check the permission at run time. Server-only commands
  set `setContexts(InteractionContextType.Guild)`.
- Write command names in replies with `commandMention('voice record')`, so
  they become clickable.
- Turn a request down with a private warning; call
  `releaseCooldown(interaction)` when nothing was done yet, so the user can fix
  it and retry at once. Let unexpected errors reach the router, which logs and
  shows an error id.
- Buttons belong to a panel (`runComponentPanel`) or a prompt
  (`awaitConfirmationResult`). A button that must survive a restart is
  registered with `registerComponentHandler(prefix, handler)` in the feature's
  `start()` and removed in `stop()`.
- To show a feature's settings in `/admin settings view`, register a provider
  with `registerSettingsSummary()` in `start()`.

### Command Placement Rules

- Put only public slash command definition files directly under `src/features/<feature>/commands/`.
- Put command-internal logic outside `commands/`, for example in `application/`.
- If a feature needs startup or shutdown logic, expose it from `src/features/<feature>/index.ts`.

## Adding New Middleware

1. Create a new file in `src/middleware/`:

```typescript
import { ChatInputCommandInteraction } from 'discord.js';
import { Command, MiddlewareResult } from '../shared/types/index.js';

export async function myMiddleware(
  interaction: ChatInputCommandInteraction,
  command: Command
): Promise<MiddlewareResult> {
  // Your logic here
  return { success: true };
}
```

2. Register in `src/middleware/index.ts`
3. Add to `MiddlewareName` type in `src/shared/types/middleware.ts`

## Testing

Tests are **colocated with features** and shared code:

- **Feature tests**: `src/features/<name>/__tests__/` — tests for that feature
- **Shared helpers**: `src/__tests__/helpers/` — reusable test utilities (e.g., mock Discord objects)
- **Integration tests**: `src/__tests__/integration/` — end-to-end or cross-module tests
- **Shared code tests**: `src/shared/**/__tests__/` — shared utility and helper tests
- **Infrastructure tests**: `src/infrastructure/**/__tests__/` — shared runtime infrastructure tests
- **Middleware tests**: `src/middleware/**/__tests__/` — middleware and cooldown pipeline tests

### Commands

| Command                 | Description                    |
| ----------------------- | ------------------------------ |
| `npm test`              | Run all tests once             |
| `npm run test:watch`    | Run tests in watch mode        |
| `npm run test:coverage` | Run tests with coverage report |

### Mock Patterns

- Use `vi.mock()` for external services (Discord client, database, APIs)
- Import shared helpers from `__tests__/helpers/discord.ts` for mock Discord objects (`createMockClient`, `createMockInteraction`, `createMockUser`, etc.)

## Database Migrations

1. Add a new migration file in `src/infrastructure/database/migrations/` using the `NNN_name.ts` convention (e.g., `006_my_table.ts`). Migrations are auto-discovered by `migrations/index.ts` and applied in lexical filename order, so the next free prefix is whatever comes after the highest existing number.

```typescript
import { database } from '../connection.js';

export function up(): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS my_table (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_my_table_name ON my_table(name)
  `);
}
```

2. Use `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` for idempotency — migrations can be run multiple times safely. Use `DROP TABLE IF EXISTS` for retiring legacy tables (see `005_drop_steam.ts`).

## Localization

- Add translation keys to both `src/locales/en.ts` and `src/locales/ja.ts`
- Use `t(key, locale, params?)` for user-facing text:

```typescript
import { t, mapDiscordLocale } from '../../../locales/index.js';

// In a command or application handler:
const locale = mapDiscordLocale(interaction.locale);
const message = t('common.success', locale);
const withParams = t('settings.language.changed', locale, {
  language: 'Japanese',
});
```

- Map Discord locales with `mapDiscordLocale(interaction.locale)` — Discord sends locale strings like `en-US` or `ja`, which are mapped to the bot's supported locales (`en`, `ja`).

## Available Scripts

| Script                     | Description                          |
| -------------------------- | ------------------------------------ |
| `npm run dev`              | Start with hot-reload (development)  |
| `npm run build`            | Compile TypeScript to JavaScript     |
| `npm start`                | Run compiled JavaScript (production) |
| `npm run lint`             | Check code with ESLint               |
| `npm run lint:fix`         | Fix ESLint errors automatically      |
| `npm run format`           | Format code with Prettier            |
| `npm run format:check`     | Check code formatting                |
| `npm run type-check`       | Check TypeScript types               |
| `npm test`                 | Run unit tests                       |
| `npm run test:watch`       | Run tests in watch mode              |
| `npm run test:coverage`    | Run tests with coverage report       |
| `npm run cleanup-commands` | Remove registered Discord commands   |

## Repo Workflow Scripts

| Script        | Description                                   |
| ------------- | --------------------------------------------- |
| `validate.sh` | Run format, lint, type-check, test, and build |
| `pre-push.sh` | Validation for git pre-push hook              |

## Develop Branch Cleanup (force-push workflow)

When cleaning noisy history on `develop`, use a safe force-push sequence:

1. Create a safety tag before rewriting:
   - `git tag -a backup/develop-before-cleanup -m "backup before cleanup"`
2. Rewrite commits into logical units (squash/reword/reorder).
3. Verify final history and scope:
   - `git log --oneline --decorate -n 30`
   - `git diff origin/develop...HEAD`
4. Announce and force-push:
   - `git push --force-with-lease origin develop`
   - `git push origin backup/develop-before-cleanup`

Use `--force-with-lease` instead of plain `--force` to avoid clobbering teammates' newer remote work.

Install the optional pre-push hook with:

```bash
cp scripts/pre-push.sh .git/hooks/pre-push && chmod +x .git/hooks/pre-push
```

`pre-push.sh` resolves the repository root with `git rev-parse --show-toplevel` and then runs `scripts/validate.sh`, so the copy-based install works from `.git/hooks/pre-push`.

[← Back to README](../README.md)
