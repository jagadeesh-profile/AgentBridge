# Thin delegation to the pnpm scripts, which are the single source of truth for
# what each target runs. `make` is the documented interface (CLAUDE.md §3) and is
# what CI uses; on a dev box without make, `pnpm run <target>` is identical.
.PHONY: setup dev contracts lint test test-e2e test-container conformance check

setup:
	pnpm install --frozen-lockfile

dev:
	pnpm run dev

contracts:
	pnpm run contracts

lint:
	pnpm run lint

test:
	pnpm run test

test-e2e:
	pnpm run test-e2e

test-container:
	pnpm run test-container

conformance:
	pnpm run conformance

check:
	pnpm run check
