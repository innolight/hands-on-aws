import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { DynamoDBLambdaStack } from './stack';

describe('DynamoDBLambdaStack', () => {
  const app = new cdk.App();
  const stack = new DynamoDBLambdaStack(app, 'TestStack');
  const template = Template.fromStack(stack);

  test('DynamoDB table has stream enabled with NEW_AND_OLD_IMAGES', () => {
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      TableName: 'orders-cdc-demo',
      StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
    });
  });

  test('Lambda function exists with Node 20 runtime', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'orders-stream-processor',
      Runtime: 'nodejs20.x',
    });
  });

  test('EventSourceMapping routes failed batches to SQS DLQ', () => {
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BisectBatchOnFunctionError: true,
      MaximumRetryAttempts: 3,
      DestinationConfig: {
        OnFailure: {
          Destination: { 'Fn::GetAtt': [Match.stringLikeRegexp('StreamDeadLetterQueue'), 'Arn'] },
        },
      },
    });
  });
});
