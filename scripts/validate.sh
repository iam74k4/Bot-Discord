#!/usr/bin/env bash
set -e

echo "Running validation (format, lint, type-check, test, audit, build)..."
npm run format:check
npm run lint
npm run type-check
npm run test:coverage
npm audit --omit=dev --audit-level=high
npm run build
echo "Validation passed."
