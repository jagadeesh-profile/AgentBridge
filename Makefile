# Thin delegation to the pnpm scripts, which are the single source of truth for
# what each target runs. `make` is the documented interface (CLAUDE.md §3) and is
# what CI uses; on a dev box without make, `pnpm run <target>` is identical.
.PHONY: setup dev contracts lint test test-e2e test-container conformance check \
	test-python test-aws localstack-up localstack-down infra-synth \
	test-otel test-otel-collector

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

test-python:
	pnpm run test-python

# Spans actually leaving the hub over OTLP/HTTP, against a receiver started in
# process. No Docker, so this one belongs in CI's main job.
test-otel:
	pnpm run test-otel

# The same export against the REAL OpenTelemetry Collector, which is the only
# way to find out whether a real collector accepts our payload — a stub
# receiver accepts whatever the exporter sends. Needs Docker; the script
# refuses to run rather than skipping if the collector is absent.
test-otel-collector:
	pnpm run test-otel-collector

# Phase 1 adapters against LocalStack. Deliberately NOT part of `check`: it
# needs Docker, and `check` must pass on a machine without it.
#
# The curl guard is the point of this target. The conformance suite skips its S3
# half when no endpoint answers, which keeps `check` green but would also let
# "the S3 adapter passes" be claimed when nothing ran. Failing here first makes
# that impossible.
test-aws: localstack-up
	@curl -fsS --max-time 30 --retry 10 --retry-delay 2 --retry-connrefused \
		http://localhost:4566/_localstack/health > /dev/null \
		|| { echo "FAIL: no LocalStack at :4566 — the S3 suite would have skipped, not passed."; exit 1; }
	pnpm --filter @agentbridge/hub exec vitest run --dir src ports/blob-conformance

localstack-up:
	@docker ps --filter name=ab-localstack --format '{{.Names}}' | grep -q ab-localstack \
		|| docker run -d --rm --name ab-localstack -p 4566:4566 -e SERVICES=s3 localstack/localstack:4

localstack-down:
	-docker stop ab-localstack

# `synth` ONLY. `cdk deploy`, `cdk bootstrap` and `cdk diff` against a live
# stack all touch a real AWS account, which CLAUDE.md §7 forbids without human
# approval — there is deliberately no target for them.
infra-synth:
	pnpm run infra-synth

check:
	pnpm run check
