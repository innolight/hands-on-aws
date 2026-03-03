import * as cdk from 'aws-cdk-lib';
import {Template, Match} from 'aws-cdk-lib/assertions';
import {DynamoDBLambdaStack} from './stack';

describe('DynamoDBLambdaStack', () => {
  const app = new cdk.App();
  const stack = new DynamoDBLambdaStack(app, 'TestStack');
  const template = Template.fromStack(stack);

  test('DynamoDB Table should have Stream enabled', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'orders-cdc-demo',
      StreamSpecification: {
        StreamViewType: 'NEW_AND_OLD_IMAGES'
      }
    });
  });

  test('SQS DLQ should be created', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'orders-cdc-dlq'
    });
  });

  test('Lambda Function should be created', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'orders-stream-processor',
      Runtime: 'nodejs20.x',
      Handler: 'index.handler'
    });
  });

  test('Event Source Mapping should have resilience settings', () => {
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 5,
      BisectBatchOnFunctionError: true,
      MaximumRetryAttempts: 3,
      StartingPosition: 'LATEST'
    });
  });

  test('Event Source Mapping should have a Destination for failure', () => {
    // Check that the EventSourceMapping points to a Destination (the SQS DLQ)
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      DestinationConfig: {
        OnFailure: {
          Destination: {
            'Fn::GetAtt': [
              Match.stringLikeRegexp('StreamDeadLetterQueue'),
              'Arn'
            ]
          }
        }
      }
    });
  });
});
