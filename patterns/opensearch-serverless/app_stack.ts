import * as cdk from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

export const opensearchServerlessAppStackName = 'OpenSearchServerlessApp';

interface OpenSearchServerlessAppStackProps extends cdk.StackProps {
  bastionSG: ec2.SecurityGroup;
  vpcEndpointSG: ec2.SecurityGroup;
}

// Wires bastion access to the OpenSearch Serverless VPC endpoint SG.
export class OpenSearchServerlessAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: OpenSearchServerlessAppStackProps) {
    super(scope, id, props);

    // Standalone ingress rule owned by this stack rather than inline on the datastore SG.
    // Avoids cross-stack mutation: the CfnSecurityGroupIngress resource lives here and
    // references props.vpcEndpointSG.securityGroupId via Fn::ImportValue (app → datastore dependency).
    new ec2.CfnSecurityGroupIngress(this, 'VpceAccessPort443', {
      groupId: props.vpcEndpointSG.securityGroupId,
      sourceSecurityGroupId: props.bastionSG.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 443,
      toPort: 443,
      description: 'HTTPS from bastion (SSM tunnel)',
    });
  }
}
