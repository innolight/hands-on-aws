import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

export const dynamodbGlobalDatabaseStackName = 'DynamodbGlobalDatabase';

// write to any region → DynamoDB Global Table replicates to all replicas → read locally from any region
export class DynamodbGlobalDatabaseStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // TableV2 (not legacy Table) is required for Global Tables in CDK v2.
    // The legacy Table construct does not support the replicas property.
    //
    // Single table design: generic key names (pk, sk) decouple the physical
    // schema from entity semantics, allowing multiple entity types to coexist
    // in one table. Only Post is stored here.
    //
    // Schema: pk=USER#<userId> | sk=POST#<postId> | entityType | title | body | origin | updatedAt
    const table = new dynamodb.TableV2(this, 'GlobalTable', {
      tableName: 'global-content',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      // onDemand avoids capacity planning for a demo with unpredictable traffic.
      billing: dynamodb.Billing.onDemand(),
      // !! Change the following in production.
      // removalPolicy: DESTROY destroys the global table AND all its replicas
      // when the stack is deleted.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      replicas: [
        // Two regions is the minimum for a valid global table. A second replica
        // suffices to demonstrate cross-region replication and LWW conflict resolution.
        { region: 'us-east-1' },
      ],
      // TableV2 (Global Tables v2019.11.21) uses last-writer-wins conflict
      // resolution based on DynamoDB's internal timestamp (_aws_ddb_lsn).
      // This is the only supported conflict resolution strategy — DynamoDB
      // does not expose configurable merge functions.
      globalSecondaryIndexes: [
        {
          // byOrigin GSI: query "all posts written from region X".
          // GSIs defined on TableV2 are automatically replicated to all replicas —
          // no per-replica GSI configuration is needed.
          indexName: 'byOrigin',
          partitionKey: { name: 'origin', type: dynamodb.AttributeType.STRING },
        },
      ],
    });

    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
    // Expose both region names so demo_server.ts can discover them via getStackOutputs.
    new cdk.CfnOutput(this, 'RegionEU', { value: cdk.Aws.REGION });
    new cdk.CfnOutput(this, 'RegionUS', { value: 'us-east-1' });
  }
}
