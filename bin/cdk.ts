#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import {S3EventsNotification, s3EventsNotificationStackName} from '../patterns/s3-events-notification/stack';
import {S3CrossRegionReplicationStackStep1} from "../patterns/s3-cross-region-replication/stack_step1_destination_bucket";
import {
  S3CrossRegionReplicationStackStep2
} from "../patterns/s3-cross-region-replication/stack_step2_source_bucket";
import {S3PolishedConfigurationStack} from "../patterns/s3-polished-configuration/stack";

const app = new cdk.App();

new S3EventsNotification(app, s3EventsNotificationStackName, {
  /* If you don't specify 'env', this stack will be environment-agnostic.
   * Account/Region-dependent features and context lookups will not work,
   * but a single synthesized template can be deployed anywhere. */

  /* Uncomment the next line to specialize this stack for the AWS Account
   * and Region that are implied by the current CLI configuration. */
  env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION},

  /* Uncomment the next line if you know exactly what Account and Region you
   * want to deploy the stack to. */
  // env: { account: '123456789012', region: 'us-east-1' },

  /* For more information, see https://docs.aws.amazon.com/cdk/latest/guide/environments.html */
});

new S3CrossRegionReplicationStackStep1(app, 'S3CrossRegionReplicationStackStep1', {
  // destination bucket is set to Ireland
  env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: 'eu-west-1'},
})
new S3CrossRegionReplicationStackStep2(app, 'S3CrossRegionReplicationStackStep2', {
  env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION},
})

new S3PolishedConfigurationStack(app, 'S3PolishedConfigurationStack', {
  env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION},
})
