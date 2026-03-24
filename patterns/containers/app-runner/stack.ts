import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as apprunner from 'aws-cdk-lib/aws-apprunner';
import { apiKeyParameterName } from '../elastic-container-registry/stack';

export const appRunnerStackName = 'AppRunnerStack';

// HTTP Client → App Runner (HTTPS) → Express :3000
export class AppRunnerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // fromRepositoryName avoids a cross-stack reference
    const repository = ecr.Repository.fromRepositoryName(this, 'Repo', 'hands-on-containers');

    // App Runner pulls the image from ECR using this role at deploy time (not runtime)
    const accessRole = new iam.Role(this, 'AccessRole', {
      assumedBy: new iam.ServicePrincipal('build.apprunner.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly')],
    });

    // ssm:GetParameters on the specific parameter only — principle of least privilege
    const ssmParameterArn = `arn:aws:ssm:${this.region}:${this.account}:parameter${apiKeyParameterName}`;

    // App Runner attaches this role to running containers for runtime AWS API access
    const instanceRole = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('tasks.apprunner.amazonaws.com'),
      inlinePolicies: {
        SsmReadPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['ssm:GetParameters'],
              resources: [ssmParameterArn],
            }),
          ],
        }),
      },
    });

    // https://docs.aws.amazon.com/apprunner/latest/api/API_CreateAutoScalingConfiguration.html
    const autoScalingConfig = new apprunner.CfnAutoScalingConfiguration(this, 'AutoScaling', {
      autoScalingConfigurationName: 'app-runner-autoscaling',
      minSize: 1, // 1 <= minSize <= 25
      maxSize: 3, // minSize <= maxSize <= 25
      maxConcurrency: 100, // # of concurrent requests per instance before scale-out
    });

    const service = new apprunner.CfnService(this, 'Service', {
      serviceName: 'app-runner-container',
      sourceConfiguration: {
        imageRepository: {
          // App Runner only supports x86_64 — ECR image must include an amd64 manifest
          imageIdentifier: `${repository.repositoryUri}:latest`,
          imageRepositoryType: 'ECR',
          imageConfiguration: {
            port: '3000',
            // runtimeEnvironmentSecrets fetches the SSM value at container startup — the
            // plaintext value is never written to CloudFormation or visible in the console
            runtimeEnvironmentSecrets: [{ name: 'API_KEY', value: ssmParameterArn }],
          },
        },
        authenticationConfiguration: {
          accessRoleArn: accessRole.roleArn,
        },
        // autoDeploymentsEnabled: false — avoids wiring ECR push events; deploy by
        // triggering a new deployment manually after pushing a new image
        autoDeploymentsEnabled: false,
      },
      instanceConfiguration: {
        // 0.25 vCPU / 0.5 GB: cheapest tier (~$2.50/mo idle). No true scale-to-zero —
        // App Runner keeps one instance warm (manual pause to stop billing entirely).
        cpu: '0.25 vCPU',
        memory: '0.5 GB',
        instanceRoleArn: instanceRole.roleArn,
      },
      healthCheckConfiguration: {
        protocol: 'HTTP',
        path: '/health',
        interval: 10,
        timeout: 5,
        // healthyThreshold 1: mark healthy after a single successful check (faster startup)
        healthyThreshold: 1,
        unhealthyThreshold: 5,
      },
      autoScalingConfigurationArn: autoScalingConfig.attrAutoScalingConfigurationArn,
    });

    new cdk.CfnOutput(this, 'ServiceUrl', { value: `https://${service.attrServiceUrl}` });
  }
}
