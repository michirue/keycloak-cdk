import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export interface KeycloakProps extends cdk.StackProps {
  hostedZoneName: string;
  domainName: string;
  albPrefixListId?: string;
}

export class KeycloakStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: KeycloakProps) {
    super(scope, id, props);

    // Allocate a stable Elastic IP for the NAT gateway so its egress address
    // is known and can be referenced in the ALB security group. This lets the
    // Keycloak tasks (in private subnets, egressing via NAT) reach the ALB's
    // public endpoint to resolve and connect to their own DNS hostname.
    const natEip = new ec2.CfnEIP(this, 'NatEip', { domain: 'vpc' });

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 3,
      natGateways: 1,
      natGatewayProvider: ec2.NatProvider.gateway({
        eipAllocationIds: [natEip.attrAllocationId],
      }),
    });

    const hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
      domainName: props.hostedZoneName,
    });

    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName: props.domainName,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    const dbCredentials = new secretsmanager.Secret(this, 'DbCredentials', {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'keycloak' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 30,
      },
    });

    const adminCredentials = new secretsmanager.Secret(this, 'AdminCredentials', {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'admin' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 20,
      },
    });

    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
      vpc,
    });

    const dbCluster = new rds.DatabaseCluster(this, 'Database', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_17_9,
      }),
      credentials: rds.Credentials.fromSecret(dbCredentials),
      defaultDatabaseName: 'keycloak',
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 1,
      writer: rds.ClusterInstance.serverlessV2('Writer'),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [dbSecurityGroup],
    });

    const cluster = new ecs.Cluster(this, 'Cluster', { vpc });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    taskDefinition.addContainer('keycloak', {
      image: ecs.ContainerImage.fromRegistry('quay.io/keycloak/keycloak:latest'),
      command: ['start', '--health-enabled=true', '--metrics-enabled=true'],
      environment: {
        KC_DB: 'postgres',
        KC_DB_URL: `jdbc:postgresql://${dbCluster.clusterEndpoint.hostname}:${dbCluster.clusterEndpoint.port}/keycloak`,
        KC_HOSTNAME: props.domainName,
        KC_PROXY_HEADERS: 'xforwarded',
        KC_HTTP_ENABLED: 'true',
      },
      secrets: {
        KC_DB_USERNAME: ecs.Secret.fromSecretsManager(dbCredentials, 'username'),
        KC_DB_PASSWORD: ecs.Secret.fromSecretsManager(dbCredentials, 'password'),
        KC_BOOTSTRAP_ADMIN_USERNAME: ecs.Secret.fromSecretsManager(adminCredentials, 'username'),
        KC_BOOTSTRAP_ADMIN_PASSWORD: ecs.Secret.fromSecretsManager(adminCredentials, 'password'),
      },
      portMappings: [
        { containerPort: 8080 },
        { containerPort: 9000 },
      ],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'keycloak',
        logGroup,
      }),
    });

    const serviceSecurityGroup = new ec2.SecurityGroup(this, 'ServiceSecurityGroup', {
      vpc,
    });

    dbSecurityGroup.addIngressRule(
      serviceSecurityGroup,
      ec2.Port.tcp(5432),
      'Allow ECS tasks to connect to Aurora',
    );

    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition,
      desiredCount: 2,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [serviceSecurityGroup],
      circuitBreaker: { enable: true, rollback: true },
      minHealthyPercent: 100,
      healthCheckGracePeriod: cdk.Duration.seconds(600),
    });

    service.node.addDependency(dbCluster);

    const alb = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
      vpc,
      internetFacing: true,
    });

    const albSg = alb.connections.securityGroups[0] as ec2.SecurityGroup;
    albSg.addIngressRule(
      props.albPrefixListId
        ? ec2.Peer.prefixList(props.albPrefixListId)
        : ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
    );
    // Allow the Keycloak tasks to reach the ALB via the NAT gateway egress IP,
    // so they can resolve and connect to their own public DNS endpoint.
    albSg.addIngressRule(
      ec2.Peer.ipv4(`${natEip.attrPublicIp}/32`),
      ec2.Port.tcp(443),
      'Allow Keycloak tasks to reach the ALB via the NAT gateway',
    );

    const httpsListener = alb.addListener('HttpsListener', {
      port: 443,
      certificates: [certificate],
      open: false,
    });

    httpsListener.addTargets('KeycloakTarget', {
      port: 8080,
      targets: [service],
      healthCheck: {
        path: '/health/ready',
        port: '9000',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 10,
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    service.connections.allowFrom(alb, ec2.Port.tcp(9000), 'Allow ALB health checks on management port');

    new route53.ARecord(this, 'AliasRecord', {
      zone: hostedZone,
      recordName: props.domainName,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.LoadBalancerTarget(alb),
      ),
    });

    new cdk.CfnOutput(this, 'KeycloakUrl', {
      value: `https://${props.domainName}`,
    });
  }
}
