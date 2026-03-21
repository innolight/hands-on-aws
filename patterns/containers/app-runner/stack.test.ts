import * as cdk from 'aws-cdk-lib';
import {Template} from 'aws-cdk-lib/assertions';
import {AppRunnerStack, appRunnerStackName} from './stack';

describe('AppRunnerStack', () => {
  const app = new cdk.App();
  const stack = new AppRunnerStack(app, appRunnerStackName);
  const template = Template.fromStack(stack);

  test('creates an App Runner service with correct CPU and memory', () => {
    template.hasResourceProperties('AWS::AppRunner::Service', {
      InstanceConfiguration: {
        Cpu: '0.25 vCPU',
        Memory: '0.5 GB',
      },
    });
  });

  test('service uses port 3000', () => {
    template.hasResourceProperties('AWS::AppRunner::Service', {
      SourceConfiguration: {
        ImageRepository: {
          ImageConfiguration: {
            Port: '3000',
          },
        },
      },
    });
  });

  test('health check is HTTP on /health', () => {
    template.hasResourceProperties('AWS::AppRunner::Service', {
      HealthCheckConfiguration: {
        Protocol: 'HTTP',
        Path: '/health',
      },
    });
  });

  test('creates auto-scaling configuration with min 1, max 3, concurrency 100', () => {
    template.hasResourceProperties('AWS::AppRunner::AutoScalingConfiguration', {
      MinSize: 1,
      MaxSize: 3,
      MaxConcurrency: 100,
    });
  });

  test('creates two IAM roles (access role + instance role)', () => {
    template.resourceCountIs('AWS::IAM::Role', 2);
  });
});
