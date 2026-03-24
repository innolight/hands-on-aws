import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { LambdaContainerStack, lambdaContainerStackName } from './stack';

describe('LambdaContainerStack', () => {
  const app = new cdk.App();
  const stack = new LambdaContainerStack(app, lambdaContainerStackName);
  const template = Template.fromStack(stack);

  test('creates a Lambda function with ARM64 architecture', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Architectures: ['arm64'],
    });
  });

  test('creates a Lambda function with 512 MB memory and 30s timeout', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      MemorySize: 512,
      Timeout: 30,
    });
  });

  test('creates a Lambda function with reserved concurrency of 10', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      ReservedConcurrentExecutions: 10,
    });
  });

  test('creates a Function URL with AuthType NONE', () => {
    template.hasResourceProperties('AWS::Lambda::Url', {
      AuthType: 'NONE',
    });
  });

  test('creates a log group with 7-day retention', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      RetentionInDays: 7,
    });
  });
});
