import * as cr from 'aws-cdk-lib/custom-resources';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';

// AWS::RDS::DBClusterEndpoint is not a supported CloudFormation resource type.
// AwsCustomResource calls the RDS API directly to create/delete the endpoint.
export interface AuroraCustomEndpointProps {
  cluster: rds.DatabaseCluster;
  endpointIdentifier: string;
  staticMembers: string[];
}

export class AuroraCustomEndpoint extends Construct {
  readonly hostname: string;

  constructor(scope: Construct, id: string, props: AuroraCustomEndpointProps) {
    super(scope, id);

    const resource = new cr.AwsCustomResource(this, 'Resource', {
      onCreate: {
        service: 'RDS',
        action: 'createDBClusterEndpoint',
        parameters: {
          DBClusterIdentifier: props.cluster.clusterIdentifier,
          DBClusterEndpointIdentifier: props.endpointIdentifier,
          EndpointType: 'READER',
          StaticMembers: props.staticMembers,
        },
        physicalResourceId: cr.PhysicalResourceId.of(props.endpointIdentifier),
      },
      onDelete: {
        service: 'RDS',
        action: 'deleteDBClusterEndpoint',
        parameters: { DBClusterEndpointIdentifier: props.endpointIdentifier },
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE }),
    });
    resource.node.addDependency(props.cluster);

    this.hostname = resource.getResponseField('Endpoint');
  }
}
