# AWS Patterns

In this project, I try to gain deep and hands-on knowledge of architecting application in AWS by using CDK to implement
popular architectural patterns in AWS.

## Patterns

Discover AWS patterns in folder [patterns](./patterns):
- [`s3-events-notification`](./patterns/s3-events-notification): S3 → SNS → SQS → SQS (DLQ) 

## Development

* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `npx cdk deploy`  deploy this stack to your default AWS account/region
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template
