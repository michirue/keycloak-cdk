import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { KeycloakStack } from '../lib/stack';

function synth(props: Partial<{ albPrefixListId: string }> = {}) {
  const app = new cdk.App();
  const stack = new KeycloakStack(app, 'TestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
    hostedZoneName: 'example.com',
    domainName: 'keycloak.example.com',
    ...props,
  });
  return Template.fromStack(stack);
}

test('Stack creates ECS Service and Aurora cluster', () => {
  const template = synth();

  template.hasResourceProperties('AWS::ECS::Service', {
    LaunchType: 'FARGATE',
  });

  template.hasResourceProperties('AWS::RDS::DBCluster', {
    Engine: 'aurora-postgresql',
    ServerlessV2ScalingConfiguration: {
      MinCapacity: 0.5,
      MaxCapacity: 1,
    },
  });

  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
    Scheme: 'internet-facing',
  });
});

test('NAT gateway uses an allocated Elastic IP', () => {
  const template = synth();

  template.resourceCountIs('AWS::EC2::EIP', 1);
  template.hasResourceProperties('AWS::EC2::NatGateway', {
    AllocationId: Match.objectLike({
      'Fn::GetAtt': ['NatEip', 'AllocationId'],
    }),
  });
});

test('ALB security group always allows the NAT gateway egress IP on 443', () => {
  const template = synth();

  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    SecurityGroupIngress: Match.arrayWith([
      Match.objectLike({
        FromPort: 443,
        ToPort: 443,
        IpProtocol: 'tcp',
        CidrIp: Match.objectLike({
          'Fn::Join': Match.arrayWith([
            Match.arrayWith([
              Match.objectLike({ 'Fn::GetAtt': ['NatEip', 'PublicIp'] }),
            ]),
          ]),
        }),
      }),
    ]),
  });
});

test('ALB security group restricts inbound to the prefix list when provided', () => {
  const template = synth({ albPrefixListId: 'pl-0123456789abcdef0' });

  // A prefix-list peer is emitted as a standalone ingress resource.
  template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
    FromPort: 443,
    ToPort: 443,
    IpProtocol: 'tcp',
    SourcePrefixListId: 'pl-0123456789abcdef0',
  });
});

test('ALB security group opens to the world when no prefix list is provided', () => {
  const template = synth();

  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    SecurityGroupIngress: Match.arrayWith([
      Match.objectLike({
        FromPort: 443,
        ToPort: 443,
        IpProtocol: 'tcp',
        CidrIp: '0.0.0.0/0',
      }),
    ]),
  });
});
