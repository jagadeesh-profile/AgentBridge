#!/usr/bin/env node
/**
 * CDK entry point.
 *
 * `cdk synth` is the only command CI or any agent may run against this. §7 of
 * CLAUDE.md requires human approval before anything touches a real AWS
 * account, which includes `cdk deploy`, `cdk bootstrap` and `cdk diff` against
 * a live stack.
 */
import { App } from 'aws-cdk-lib';
import { HubStack } from './hub-stack.js';

const app = new App();

// Read from context rather than the environment so `cdk synth` is reproducible
// and the value is visible in the command that produced a template.
const ownerPublicKey = app.node.tryGetContext('ownerPublicKey');
if (typeof ownerPublicKey !== 'string' || ownerPublicKey === '') {
  // The hub refuses to boot without this (delivery/src/main.ts), so a stack
  // synthesised without it would only fail later, in a container.
  throw new Error(
    'ownerPublicKey context value is required: cdk synth -c ownerPublicKey=<base64 Ed25519 public key>',
  );
}

new HubStack(app, 'AgentBridgeHub', {
  ownerPublicKey,
  imageTag: app.node.tryGetContext('imageTag') ?? 'latest',
  description:
    'AgentBridge hub — single-writer Fargate service, SQLite on EFS, artifacts in S3 (ADR 0010)',
});
