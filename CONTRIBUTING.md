# Contributing

## Getting Started

1. Fork the repository
2. Clone your fork and install dependencies: `npm install`
3. Copy `.env.example` to `.env` and fill in required values
4. Run the bot in development mode: `npm run dev`

## Branch Naming

- `feature/<name>` or `feat/<name>` — new features
- `fix/<name>` or `bugfix/<name>` — bug fixes
- `docs/<name>` — documentation changes

Branch from `main`, merge back to `main` when ready.

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): subject
```

- **type**: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`
- **scope**: optional (e.g. `auth`, `notification`, `voice`)
- **subject**: lowercase, imperative, no period, max 50 chars

Examples:

- `feat(community): add profile comparison command`
- `fix(voice): handle disconnect during recording`
- `docs: update database schema documentation`

## Code Style

- TypeScript strict mode is enforced
- **Cursor / AI**: Project conventions and CI order live in [`.cursor/rules/architecture.mdc`](.cursor/rules/architecture.mdc).
- **Prettier**: Run `npm run format` before committing (or `npm run format:check` to verify). CI fails at **Check formatting** if Prettier output does not match—this step runs before ESLint in [`.github/workflows/ci.yml`](.github/workflows/ci.yml).
- Run `npm run lint` and `npm run type-check`
- Use `bash scripts/validate.sh` for full CI parity (format check, lint, type-check, test, audit, build)

## Adding Features

Features are auto-discovered. Create a directory under `src/features/<name>/`:

```
src/features/<name>/
├── index.ts          # Must export { name, start, stop }
├── commands/         # Slash command definitions (auto-loaded)
├── application/      # Business logic handlers
├── repositories/     # Database access (real SQL queries)
├── __tests__/        # Colocated tests
└── ...               # Optional: integrations/, jobs/, tracking/, recording/, or services/
```

No manual registration in `features/index.ts` is needed.

## Testing

- Colocate tests with features: `features/<name>/__tests__/`
- Use shared helpers from `src/__tests__/helpers/discord.ts`
- Shared utility tests may live under `src/shared/**/__tests__/`
- Infrastructure tests may live under `src/infrastructure/**/__tests__/`
- Run tests: `npm test`
- Run with coverage: `npm run test:coverage` (CI runs this and fails below the
  floors in `vitest.config.ts`)
- New slash commands are exercised automatically by
  `src/__tests__/integration/commands/`; still add a test for what the command
  does
- Test files are type-checked by `npm run type-check`
- See [`docs/quality.md`](docs/quality.md#testing) for conventions such as
  `it.fails` markers for known bugs

All PRs should include tests for new functionality.

## Security maintenance

- Run `npm run audit:all` (or `./scripts/audit-all.sh`) before releases; see [`docs/quality.md`](docs/quality.md) for dependency and `overrides` policy.
- **Dependabot**: Review weekly PRs labeled `dependencies` for `npm` and `github-actions`. GitHub Action updates use commit SHA pins—merge security-related bumps promptly.
- **Code scanning**: CodeQL runs on `main` and `develop`; address or triage alerts in the repository **Security** tab.

## Pull Requests

1. Ensure all checks pass: `npm run format:check && npm run lint && npm run type-check && npm test` (or `bash scripts/validate.sh`)
2. Write a clear PR description explaining the change
3. Reference related issues if applicable
4. Keep PRs focused — one logical change per PR
