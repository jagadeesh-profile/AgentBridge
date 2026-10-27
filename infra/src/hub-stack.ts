import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

/**
 * Phase 1 deployment: the hub as a **single-writer** Fargate service, with
 * SQLite on EFS and artifacts in S3 (ADR 0010).
 *
 * Why single-writer: the `Store` port is synchronous in all 45 of its methods,
 * which no networked database can implement in Node, so the choice of embedded
 * storage is not incidental — it is what gives §1.9's audit-chain atomicity a
 * transaction with no await point (ADR 0003, ADR 0009). The owner's decision
 * was to keep that and defer horizontal scale until something needs it.
 *
 * Everything unusual in this file follows from that one sentence. A second
 * concurrent task writing the same SQLite file is not a performance problem,
 * it is corruption, so the ways ECS would ordinarily give you a second task
 * are each disabled explicitly below rather than left at their defaults.
 *
 * Nothing here is deployed by CI. `CLAUDE.md` §7 forbids touching a real AWS
 * account, so this is verified by `cdk synth` plus assertions on the resulting
 * template — see `hub-stack.test.ts`.
 */
export interface HubStackProps extends StackProps {
  /** Base64 Ed25519 owner public key. A public key, so not a secret (§1.6). */
  ownerPublicKey: string;
  /** Container image tag to run. */
  imageTag?: string;
  /** Hosted artifact retention. */
  artifactRetentionDays?: number;
}

/** The container's own contract, from the Dockerfile and delivery/src/main.ts. */
const CONTAINER_PORT = 8080;
const DATA_MOUNT = '/data';

export class HubStack extends Stack {
  constructor(scope: Construct, id: string, props: HubStackProps) {
    super(scope, id, props);

    // ---------------------------------------------------------------- network
    //
    // Public subnets with no NAT gateway, deliberately. A NAT gateway is about
    // $32/month on its own, and with an ALB at roughly $18 that alone would put
    // this stack past the $50/month that CLAUDE.md §7 says needs human
    // approval. The task gets a public IP and egress through the internet
    // gateway instead; it is still unreachable inbound except via the ALB
    // security group.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    });

    // ------------------------------------------------------------- artifacts
    const artifacts = new s3.Bucket(this, 'Artifacts', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // Artifacts are versioned in the hub's own data model (one row per
      // version), so object versioning would duplicate that rather than add to
      // it. Lifecycle expiry is the useful knob.
      versioned: false,
      lifecycleRules:
        props.artifactRetentionDays === undefined
          ? []
          : [{ expiration: Duration.days(props.artifactRetentionDays) }],
      // Retained on stack deletion: these are the owner's task outputs, and
      // §7 treats deleting data as needing a human.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ------------------------------------------------------------ sqlite state
    //
    // EFS rather than an EBS volume because a Fargate task cannot attach EBS,
    // and because EFS survives the task being replaced. SQLite over NFS is
    // only safe with exactly one writer, which is the whole premise here.
    const fileSystem = new efs.FileSystem(this, 'State', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      encrypted: true,
      // Bursting is right for a single small database; Elastic bills per
      // request and would cost more for this access pattern.
      throughputMode: efs.ThroughputMode.BURSTING,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const accessPoint = fileSystem.addAccessPoint('StateAccessPoint', {
      path: '/agentbridge',
      // The image runs as the `node` user, uid 1000. The access point owns the
      // directory as that uid so the container can write without running root.
      createAcl: { ownerUid: '1000', ownerGid: '1000', permissions: '755' },
      posixUser: { uid: '1000', gid: '1000' },
    });

    // ------------------------------------------------------------------ compute
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc, containerInsights: true });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'HubTask', {
      cpu: 256,
      memoryLimitMiB: 512,
      volumes: [
        {
          name: 'state',
          efsVolumeConfiguration: {
            fileSystemId: fileSystem.fileSystemId,
            transitEncryption: 'ENABLED',
            authorizationConfig: { accessPointId: accessPoint.accessPointId, iam: 'ENABLED' },
          },
        },
      ],
    });

    const container = taskDefinition.addContainer('hub', {
      image: ecs.ContainerImage.fromRegistry(`agentbridge/hub:${props.imageTag ?? 'latest'}`),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'hub',
        logRetention: logs.RetentionDays.ONE_MONTH,
      }),
      environment: {
        // Not secrets: a public key, a path and a bucket name. The hub stores
        // no credentials at all (§1.6), which is why this stack creates no
        // Secrets Manager entry and no KMS signing key.
        AGENTBRIDGE_OWNER_PUBLIC_KEY: props.ownerPublicKey,
        AGENTBRIDGE_DB: `${DATA_MOUNT}/agentbridge.sqlite`,
        AGENTBRIDGE_ARTIFACT_BUCKET: artifacts.bucketName,
        PORT: String(CONTAINER_PORT),
        LOG_LEVEL: 'info',
      },
      portMappings: [{ containerPort: CONTAINER_PORT }],
      healthCheck: {
        command: [
          'CMD-SHELL',
          `node -e "fetch('http://127.0.0.1:${CONTAINER_PORT}/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`,
        ],
        interval: Duration.seconds(15),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(30),
      },
    });

    container.addMountPoints({
      containerPath: DATA_MOUNT,
      sourceVolume: 'state',
      readOnly: false,
    });

    // Access to the bucket comes from the task role, so no key material is
    // ever placed in the environment.
    artifacts.grantReadWrite(taskDefinition.taskRole);
    fileSystem.grantRootAccess(taskDefinition.taskRole);

    const service = new ecs.FargateService(this, 'HubService', {
      cluster,
      taskDefinition,
      // ---- the three single-writer guarantees ----
      //
      // 1. Exactly one task.
      desiredCount: 1,
      // 2. Stop the old task BEFORE starting the new one. This is the subtle
      //    one and the default is wrong for us: ECS's normal rolling update
      //    (min 100%, max 200%) deliberately runs the new task alongside the
      //    old for a while, which here means two processes writing one SQLite
      //    file over NFS. Allowing 0% healthy during a deploy buys a few
      //    seconds of downtime and is the only correct choice while the Store
      //    is single-writer.
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      // 3. No second task from a failed deployment lingering: roll back rather
      //    than leave two revisions in play.
      circuitBreaker: { rollback: true },
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      healthCheckGracePeriod: Duration.seconds(60),
    });
    // Note there is deliberately NO `service.autoScaleTaskCount(...)` here.
    // Autoscaling is the obvious thing to add and would silently corrupt the
    // database. The test suite asserts no scalable target exists, so adding one
    // fails the build rather than production.

    service.connections.allowTo(fileSystem, ec2.Port.tcp(2049), 'SQLite state over NFS');

    // -------------------------------------------------------------- front door
    const lb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
    });

    // The A2A Agent Card publishes this as the address remote agents should
    // reach, so it must be the load balancer rather than the task. Left unset
    // it defaults to localhost:8080, which no remote agent can reach — the
    // A2A conformance suite caught that, and this is where a deployed stack
    // would have shipped it.
    container.addEnvironment('AGENTBRIDGE_PUBLIC_URL', `http://${lb.loadBalancerDnsName}`);

    const listener = lb.addListener('Http', {
      port: 80,
      open: true,
    });

    listener.addTargets('HubTarget', {
      port: CONTAINER_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      // `/healthz` is the hub's own liveness route, already exercised by the
      // container suite.
      healthCheck: {
        path: '/healthz',
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      // One task means draining is quick; a long deregistration delay would
      // just extend the deploy gap that minHealthyPercent: 0 already creates.
      deregistrationDelay: Duration.seconds(10),
    });

    new CfnOutput(this, 'HubUrl', { value: `http://${lb.loadBalancerDnsName}` });
    new CfnOutput(this, 'ArtifactBucket', { value: artifacts.bucketName });
  }
}
