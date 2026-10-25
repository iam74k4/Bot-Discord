# Quality Standards

This document describes the quality standards and practices for this Discord bot.

## Architecture

- **Feature-based layout**: Each feature lives under `src/features/<name>/` with clear boundaries.
- **Layer separation**: `commands` → `application` → `repositories` / supporting runtime folders.
- **Runtime folder naming**: Prefer explicit directories such as `integrations`, `jobs`, `tracking`, or `recording`; keep `services` only when a smaller stateful boundary is clearer.
- **Infrastructure isolation**: Database connection, migrations, and transactions live in `src/infrastructure/database/` only. No business logic there.
- **Shared code isolation**: Cross-feature utilities, shared types, and help catalog state live under `src/shared/`.

## Error Handling

- **Always use `getErrorMessage(error)`** for logging and user-facing error messages. Do not use `error.message` directly; `error` may not be an `Error` instance.
- Always wrap command/event handlers in try-catch.
- An error shown to a user carries a short error id (`createErrorId()` from `src/shared/interactions`), and the same id is logged with the stack (`describeError(error)`), so a report can be matched to the log. Never show raw error messages.
- A refusal the user can fix (missing permission, cooldown, not in a VC) is a private **warning**; reserve error embeds for things that went wrong. Commands that turn a request down before doing any work call `releaseCooldown(interaction)`.
- For Discord interactions: check `interaction.replied` and `interaction.deferred` before calling `reply()` to avoid "Already replied" errors.
- Use `error instanceof Error ? error.message : String(error)` when `getErrorMessage` is not available.

## Input Validation

- Validate all user inputs (modal, options, text).
- Trim strings and enforce length limits (e.g. GitHub title ≤ 256 characters).
- Reject empty required fields with clear error messages.

## API Integration

- Handle JSON parse errors explicitly (don't rely on `response.json()` alone).
- Use retry logic for transient failures (rate limits, 5xx).
- Validate API responses when structure matters.

## Shutdown

- Run final backup before shutdown when `SHUTDOWN_FINAL_BACKUP` is enabled.
- Configurable shutdown timeout via `SHUTDOWN_TIMEOUT_MS`.
- Graceful shutdown order: Component routing off → Live components (open panels and prompts close visibly, budget `min(3 s, SHUTDOWN_TIMEOUT_MS / 5)`) → Backup service → Audit retention → Features → Final backup → Cooldown store → Runtime metrics → Database → Client.

## Security

- Use prepared statements for all SQL.
- Validate backup filenames and paths to prevent traversal.
- Require HTTPS for `ALERT_WEBHOOK_URL`.
- Keep `DATA_DIR`, `DATABASE_PATH`, `RECORDINGS_DIR`, and `BACKUP_DIR` relative to the workspace root. Absolute paths and `../` escapes must fail fast at startup.

## Dependencies and `npm audit`

- Respect `packageManager` in `package.json` and use `npm ci` in CI/release paths so lockfile resolution stays reproducible.
- Run `npm audit` (full tree) and `npm audit --omit=dev --audit-level=high` (matches CI) regularly or before releases.
- **One-shot diagnosis**: `./scripts/audit-all.sh` runs both audits in order; use before releases and paste the terminal output into a PR or issue (do not commit generated audit JSON/HTML reports to the repo).
- **Scheduled visibility**: `.github/workflows/dependency-audit.yml` runs a non-blocking weekly full-tree audit and uploads the JSON report as an artifact for triage.
- **`package.json` overrides**: Some patched versions are pinned via `overrides` (e.g. `undici`, `flatted`) when upstream packages have not yet adopted a fixed release. Revisit after dependency upgrades: try removing an override and run `npm install` + audit; restore the override if advisories return. **Last check**: with overrides removed, `npm audit` reported high-severity `undici` issues via `discord.js` / `@discordjs/rest`; keep both overrides until upstream resolves the nested `undici` version. `undici` is pinned to 6.29.1 for GHSA-xjj6-f33q-929c (high) and GHSA-4qv8-2p9j-2685 (moderate), which affect 6.29.0.
- **Dependabot**: Review weekly PRs for `npm` and `github-actions`. The PR cap is intentionally higher so security updates are less likely to queue behind routine bumps. Action bumps use commit SHA pins—merge security-related updates promptly.
- **Code scanning**: The repository includes a GitHub Actions CodeQL workflow (`javascript-typescript`) on `main` / `develop`; fix or suppress findings per GitHub’s guidance.
- **Native dependencies**: `better-sqlite3` and `sodium-native` are intentional for runtime performance and Discord voice compatibility. Keep them on supported Node.js versions, update them through Dependabot or explicit review, and re-run build/test/audit after every bump because they include platform-specific install/build paths.
- **Voice / Opus**: The bot depends on `opusscript` for Opus decode used by `prism-media` in voice recording. This avoids native `@discordjs/opus` / `node-pre-gyp` / `tar` install paths that previously tripped high-severity audits. Trade-off: higher CPU than native bindings when many users speak simultaneously; acceptable for typical bot workloads. Each speaker is decoded to mono, which lets one process hold about 29 opusscript decoders at once; past that, a new decoder fails, and the connection manager logs a rate-limited warning with the live decoder count. Each speaker's audio is placed in the ring by arrival time, never more than 1 s ahead of the clock: frames beyond that are dropped until the clock catches up, so a fast sender clock cannot overwrite newer audio.
- **`undici`** is also a direct dependency (pinned to the same 6.29.1 as the override): `src/client.ts` gives the REST client a keep-alive `Agent` from it.

## Testing

- Colocate tests with features in `__tests__/`.
- Shared and infrastructure code may also colocate tests under their own `__tests__/` directories.
- Use `getErrorMessage` pattern in mocks.
- Integration tests for backup, admin commands.
- **Every command is smoke-tested once declared.** `src/__tests__/integration/commands/commandPayload.test.ts`
  checks every slash command against Discord's registration limits, and
  `allCommands.smoke.test.ts` executes every command and subcommand path and
  asserts it is acknowledged exactly once. The lists are deliberately
  exhaustive, so a new command or subcommand fails CI until you declare it:
  add an entry to `COMMAND_POLICY` in `command-smoke.helpers.ts`
  (`defaultMemberPermissions`, `contexts`, `cooldownMs`, `autocomplete`, and
  one access level per `/general help` entry), then add each new path to
  `REACHES` (with a `SCENARIOS` entry if it needs prior state) or `READ_ONLY`
  in `allCommands.smoke.test.ts`. Still give the command a dedicated test for
  its behaviour.
- **Coverage is enforced in CI.** CI runs `npm run test:coverage`, which fails
  below the floors in `vitest.config.ts`. Raise the floors when coverage grows;
  do not lower them to make a change pass.
- **Tests are type-checked.** `npm run type-check` also runs
  `tsc -p tsconfig.test.json`, which includes the `__tests__` directories that
  the build config excludes.
- **Known bugs are pinned with `it.fails`.** A test that describes the correct
  behaviour of a reported, not-yet-fixed bug is marked `it.fails` with a
  comment naming the bug. It flips to failing the moment the bug is fixed,
  which is the signal to change it to `it`.
- **Assert behaviour, not wiring.** The suite was hardened with mutation
  testing (deliberately breaking conditions, calls and boundaries in the
  source and checking a test fails); prefer assertions that would catch such a
  change over call-count or call-order checks.
- Test helpers: cross-feature fakes live in `src/__tests__/helpers/`; helpers
  only one feature needs live next to its tests as
  `<feature>/__tests__/<feature>.helpers.ts`. Both are excluded from coverage.
- Database tests use an in-memory SQLite (`new Database(':memory:')`) with the
  real migrations, never `data/*.db`; time-based tests use fake timers.

## Localization

- Use `t(key, locale, params?)` for all user-facing text.
- Add translations to both `en.ts` and `ja.ts` when adding new keys; both must use the same `{placeholders}` (checked by the smoke tests), and unused keys fail `src/locales/__tests__/unusedKeys.test.ts`.
- Japanese is です/ます調 with consistent terms: VC, サーバー, 録音, 読み上げ, 保持, 外す (roles), メニュー, Bot運営者. The glossary at the top of `src/locales/ja.ts` is the reference. Permission names follow Discord's own client (`formatPermissionNames`).
- Replies follow the reader (`resolveLocale(interaction)`); posts in a channel follow the server (`resolveBackgroundLocale(guild)`: the server setting, else the Discord language of a Community server, else Japanese).
- Durations, numbers and lists go through `src/locales/format.ts` (`formatDuration`, `formatNumber`, `formatList`); command names in text go through `commandMention()`.

[← Back to README](../README.md)
