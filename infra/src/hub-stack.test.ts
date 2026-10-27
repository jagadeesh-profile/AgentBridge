import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { HubStack } from './hub-stack.js';

/**
 * Assertions on the synthesised CloudFormation template.
 *
 * `CLAUDE.md` §7 forbids touching a real AWS account, so this stack can never
 * be deployed from here and "it works" is not available as evidence. What *is*
 * available is the template, and the properties that matter for correctness are
 * all visible in it.
 *
 * The single-writer cases are the point. ADR 0010 keeps the hub to one task
 * because the `Store` port is synchronous and SQLite over NFS tolerates exactly
 * one writer; a second concurrent task is data corruption, not slow service.
 * Every ordinary ECS convenience that would produce a second task is therefore
 * disabled in `hub-stack.ts`, and each of those is asserted here — so a future
 * change that adds autoscaling because it seemed obviously good fails the build
 * instead of the database.
 */
describe('HubStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new App();
    const stack = new HubStack(app, 'TestHub', {
      ownerPublicKey: 'A'.repeat(43) + '=',
      imageTag: 'test-tag',
      artifactRetentionDays: 90,
    });
    template = Template.fromStack(stack);
  });

  describe('single-writer guarantees (ADR 0010)', () => {
    it('runs EXACTLY one task', () => {
      template.hasResourceProperties('AWS::ECS::Service', { DesiredCount: 1 });
    });

    it('stops the old task BEFORE starting the new one on deploy', () => {
      // The ECS default is min 100% / max 200%, which runs the new task
      // alongside the old — two writers on one SQLite file. This is the single
      // most important line in the stack and the easiest to lose to a refactor.
      template.hasResourceProperties('AWS::ECS::Service', {
        DeploymentConfiguration: Match.objectLike({
          MinimumHealthyPercent: 0,
          MaximumPercent: 100,
        }),
      });
    });

    it('rolls a failed deployment back rather than leaving two revisions', () => {
      template.hasResourceProperties('AWS::ECS::Service', {
        DeploymentConfiguration: Match.objectLike({
          DeploymentCircuitBreaker: { Enable: true, Rollback: true },
        }),
      });
    });

    it('has NO autoscaling target — adding one would corrupt the database', () => {
      expect(
        Object.keys(template.findResources('AWS::ApplicationAutoScaling::ScalableTarget')),
      ).toEqual([]);
    });

    it('has NO scaling policy', () => {
      expect(
        Object.keys(template.findResources('AWS::ApplicationAutoScaling::ScalingPolicy')),
      ).toEqual([]);
    });

    it('declares only one ECS service, so a second writer cannot arrive sideways', () => {
      expect(Object.keys(template.findResources('AWS::ECS::Service'))).toHaveLength(1);
    });
  });

  describe('state', () => {
    it('keeps SQLite on an encrypted EFS filesystem', () => {
      template.hasResourceProperties('AWS::EFS::FileSystem', { Encrypted: true });
    });

    it('mounts the volume where the container expects it', () => {
      // Must match the Dockerfile's AGENTBRIDGE_DB default directory, or the
      // hub writes its database into the container's ephemeral layer and loses
      // it on every restart — which would look like it was working.
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            MountPoints: Match.arrayWith([
              Match.objectLike({ ContainerPath: '/data', ReadOnly: false }),
            ]),
          }),
        ]),
      });
    });

    it('encrypts EFS traffic in transit and authorises with IAM', () => {
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        Volumes: Match.arrayWith([
          Match.objectLike({
            EFSVolumeConfiguration: Match.objectLike({
              TransitEncryption: 'ENABLED',
              AuthorizationConfig: Match.objectLike({ IAM: 'ENABLED' }),
            }),
          }),
        ]),
      });
    });

    it('retains EFS and the bucket when the stack is destroyed', () => {
      // §7 treats deleting the owner's data as needing a human.
      template.hasResource('AWS::EFS::FileSystem', { DeletionPolicy: 'Retain' });
      template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
    });
  });

  describe('artifacts', () => {
    it('blocks all public access', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      });
    });

    it('encrypts at rest', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketEncryption: Match.objectLike({
          ServerSideEncryptionConfiguration: Match.arrayWith([
            Match.objectLike({
              ServerSideEncryptionByDefault: Match.objectLike({ SSEAlgorithm: 'AES256' }),
            }),
          ]),
        }),
      });
    });

    it('refuses plaintext requests', () => {
      template.hasResourceProperties('AWS::S3::BucketPolicy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Deny',
              Condition: { Bool: { 'aws:SecureTransport': 'false' } },
            }),
          ]),
        }),
      });
    });

    it('passes the bucket name to the hub so the S3 adapter is actually used', () => {
      // Without this the composition root falls back to the filesystem store
      // and artifacts land on EFS — working, but not what this stack is for.
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Environment: Match.arrayWith([
              Match.objectLike({ Name: 'AGENTBRIDGE_ARTIFACT_BUCKET' }),
            ]),
          }),
        ]),
      });
    });
  });

  describe('the hub stores no secrets (§1.6)', () => {
    it('creates no Secrets Manager secret', () => {
      expect(Object.keys(template.findResources('AWS::SecretsManager::Secret'))).toEqual([]);
    });

    it('creates no KMS key for signing', () => {
      // ADR 0009 withdrew the KMS line entirely: nothing in the hub signs, and
      // KMS has no Ed25519 to offer §1.2 regardless.
      expect(Object.keys(template.findResources('AWS::KMS::Key'))).toEqual([]);
    });

    it('wires no `secrets` block into the container', () => {
      const tasks = template.findResources('AWS::ECS::TaskDefinition');
      for (const task of Object.values(tasks)) {
        const containers = task.Properties?.ContainerDefinitions ?? [];
        for (const c of containers) {
          expect(c.Secrets ?? []).toEqual([]);
        }
      }
    });

    it('passes the owner PUBLIC key as plain environment, which is correct', () => {
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Environment: Match.arrayWith([
              Match.objectLike({ Name: 'AGENTBRIDGE_OWNER_PUBLIC_KEY' }),
            ]),
          }),
        ]),
      });
    });
  });

  describe('cost shape (§7: >$50/month needs a human)', () => {
    it('provisions NO NAT gateway', () => {
      // A NAT gateway is ~$32/month by itself; with the ALB at ~$18 this stack
      // would cross the §7 threshold on infrastructure that serves no request.
      expect(Object.keys(template.findResources('AWS::EC2::NatGateway'))).toEqual([]);
    });

    it('keeps the task small', () => {
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        Cpu: '256',
        Memory: '512',
      });
    });

    it('provisions exactly one load balancer', () => {
      expect(
        Object.keys(template.findResources('AWS::ElasticLoadBalancingV2::LoadBalancer')),
      ).toHaveLength(1);
    });
  });

  describe('health checking', () => {
    it("targets the hub's own /healthz route", () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
        HealthCheckPath: '/healthz',
      });
    });
  });
});
