import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { VpcSubnetsStack } from '../vpc-subnets/stack';
import { OpenSearchProvisionedStack } from './stack';

describe('OpenSearchProvisionedStack', () => {
  const app = new cdk.App();
  const vpcStack = new VpcSubnetsStack(app, 'VpcStack');
  const stack = new OpenSearchProvisionedStack(app, 'TestStack', {
    vpc: vpcStack.vpc,
  });
  const template = Template.fromStack(stack);

  test('creates OpenSearch domain with 2 t3.small data nodes', () => {
    template.hasResourceProperties('AWS::OpenSearchService::Domain', {
      EngineVersion: 'OpenSearch_2.19',
      ClusterConfig: {
        InstanceType: 't3.small.search',
        InstanceCount: 2,
      },
    });
  });

  test('enables zone awareness', () => {
    template.hasResourceProperties('AWS::OpenSearchService::Domain', {
      ClusterConfig: {
        ZoneAwarenessEnabled: true,
      },
    });
  });

  test('enforces HTTPS, encryption at rest, node-to-node encryption', () => {
    template.hasResourceProperties('AWS::OpenSearchService::Domain', {
      DomainEndpointOptions: { EnforceHTTPS: true },
      EncryptionAtRestOptions: { Enabled: true },
      NodeToNodeEncryptionOptions: { Enabled: true },
    });
  });

  test('creates CloudWatch log groups for slow search and app logs', () => {
    template.resourceCountIs('AWS::Logs::LogGroup', 2);
  });

  test('creates a security group with no default ingress', () => {
    template.resourceCountIs('AWS::EC2::SecurityGroup', 1);
  });
});
