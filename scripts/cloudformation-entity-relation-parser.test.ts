jest.mock('fs');

import * as fs from 'fs';
import {
  isCdkScaffolding,
  deriveStackName,
  deriveConstructName,
  extractResources,
  extractRelationships,
  findCfFiles,
  loadTemplate,
  findRelevantProp,
  isInPolicyStatementResource,
  resolveIamLabel,
  resolveLabel,
  inferImportedResource,
  entityLabel,
  importedEntityLabel,
  deduplicateRelationships,
  formatOutput,
} from './cloudformation-entity-relation-parser';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRel(
  propertyPath: string[],
  opts: { getAttribute?: string; sourceType?: string; targetType?: string } = {},
) {
  return {
    sourceStack: 'MyStack',
    sourceLogicalId: 'Source',
    targetStack: 'MyStack',
    targetLogicalId: 'Target',
    targetType: opts.targetType ?? 'AWS::Some::Resource',
    propertyPath,
    refType: 'Ref' as const,
    getAttribute: opts.getAttribute,
    label: '',
  };
}

function makeEntry(
  overrides: Partial<{
    logicalId: string;
    type: string;
    constructName: string;
    stackName: string;
    properties: Record<string, unknown>;
  }> = {},
) {
  return {
    logicalId: overrides.logicalId ?? 'MyResource',
    type: overrides.type ?? 'AWS::S3::Bucket',
    constructName: overrides.constructName ?? 'MyBucket',
    stackName: overrides.stackName ?? 'MyStack',
    properties: overrides.properties ?? {},
  };
}

// ---------------------------------------------------------------------------
// isCdkScaffolding
// ---------------------------------------------------------------------------

describe('isCdkScaffolding', () => {
  it('returns true for AWS::CDK::Metadata', () => {
    expect(isCdkScaffolding('AWS::CDK::Metadata', '')).toBe(true);
  });

  it('returns true for Custom:: types', () => {
    expect(isCdkScaffolding('Custom::S3AutoDeleteObjects', '')).toBe(true);
    expect(isCdkScaffolding('Custom::AWS', '')).toBe(true);
  });

  it('returns true when cdkPath contains Custom::', () => {
    expect(isCdkScaffolding('AWS::IAM::Role', 'MyStack/Custom::LogRetention/Resource')).toBe(true);
  });

  it('returns true when cdkPath contains BucketNotificationsHandler', () => {
    expect(isCdkScaffolding('AWS::Lambda::Function', 'MyStack/BucketNotificationsHandler/Resource')).toBe(true);
  });

  it('returns true when cdkPath contains a hex-hash construct id (AwsCustomResource)', () => {
    expect(isCdkScaffolding('AWS::IAM::Role', 'MyStack/AWS679f53fac002430cb0da5b7982bd2287/ServiceRole/Resource')).toBe(
      true,
    );
  });

  it('returns true when cdkPath contains CustomResourcePolicy', () => {
    expect(isCdkScaffolding('AWS::IAM::Policy', 'MyStack/ClusterResourcePolicy/CustomResourcePolicy/Resource')).toBe(
      true,
    );
  });

  it('returns false for normal resources', () => {
    expect(isCdkScaffolding('AWS::S3::Bucket', 'MyStack/Bucket/Resource')).toBe(false);
    expect(isCdkScaffolding('AWS::EC2::SecurityGroup', 'MyStack/DbSG/Resource')).toBe(false);
    expect(isCdkScaffolding('AWS::RDS::DBInstance', 'MyStack/Instance/Resource')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deriveStackName
// ---------------------------------------------------------------------------

describe('deriveStackName', () => {
  it('extracts the first path segment from a resource cdk:path', () => {
    const template = {
      Resources: {
        Bucket: {
          Type: 'AWS::S3::Bucket',
          Metadata: { 'aws:cdk:path': 'MyAppStack/Bucket/Resource' },
        },
      },
    };
    expect(deriveStackName(template)).toBe('MyAppStack');
  });

  it('returns UnknownStack when template has no resources', () => {
    expect(deriveStackName({})).toBe('UnknownStack');
  });

  it('returns UnknownStack when no resource has a cdk:path', () => {
    const template = {
      Resources: {
        Bucket: { Type: 'AWS::S3::Bucket' },
      },
    };
    expect(deriveStackName(template)).toBe('UnknownStack');
  });
});

// ---------------------------------------------------------------------------
// deriveConstructName
// ---------------------------------------------------------------------------

describe('deriveConstructName', () => {
  it('returns empty string for empty path', () => {
    expect(deriveConstructName('')).toBe('');
  });

  it('strips stack name and trailing Resource segment', () => {
    expect(deriveConstructName('MyStack/DbSG/Resource')).toBe('DbSG');
  });

  it('strips trailing Default segment', () => {
    expect(deriveConstructName('MyStack/Instance/SubnetGroup/Default')).toBe('SubnetGroup');
  });

  it('returns the last meaningful segment for nested paths', () => {
    expect(deriveConstructName('MyStack/Instance/Secret/Resource')).toBe('Secret');
  });

  it('handles single-segment paths after stack name', () => {
    expect(deriveConstructName('MyStack/Cluster')).toBe('Cluster');
  });
});

// ---------------------------------------------------------------------------
// extractResources
// ---------------------------------------------------------------------------

describe('extractResources', () => {
  it('includes normal resources and adds them to globalMap', () => {
    const template = {
      Resources: {
        MyBucket: {
          Type: 'AWS::S3::Bucket',
          Metadata: { 'aws:cdk:path': 'MyStack/MyBucket/Resource' },
          Properties: { BucketName: 'test' },
        },
      },
    };
    const globalMap = new Map();
    const entries = extractResources(template, 'MyStack', globalMap);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ logicalId: 'MyBucket', type: 'AWS::S3::Bucket', constructName: 'MyBucket' });
    expect(globalMap.has('MyStack::MyBucket')).toBe(true);
  });

  it('filters out AWS::CDK::Metadata', () => {
    const template = {
      Resources: {
        CDKMetadata: { Type: 'AWS::CDK::Metadata' },
        MyBucket: { Type: 'AWS::S3::Bucket', Metadata: { 'aws:cdk:path': 'MyStack/MyBucket/Resource' } },
      },
    };
    const entries = extractResources(template, 'MyStack', new Map());
    expect(entries.map((e) => e.logicalId)).toEqual(['MyBucket']);
  });

  it('filters out Custom:: types', () => {
    const template = {
      Resources: {
        AutoDelete: {
          Type: 'Custom::S3AutoDeleteObjects',
          Metadata: { 'aws:cdk:path': 'MyStack/Custom::S3AutoDeleteObjects/Resource' },
        },
        MyBucket: { Type: 'AWS::S3::Bucket', Metadata: { 'aws:cdk:path': 'MyStack/MyBucket/Resource' } },
      },
    };
    const entries = extractResources(template, 'MyStack', new Map());
    expect(entries.map((e) => e.logicalId)).toEqual(['MyBucket']);
  });

  it('handles empty Resources section', () => {
    expect(extractResources({}, 'MyStack', new Map())).toEqual([]);
  });

  it('uses empty properties when resource has no Properties', () => {
    const template = {
      Resources: {
        MyBucket: { Type: 'AWS::S3::Bucket', Metadata: { 'aws:cdk:path': 'MyStack/MyBucket/Resource' } },
      },
    };
    const entries = extractResources(template, 'MyStack', new Map());
    expect(entries[0].properties).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// findRelevantProp
// ---------------------------------------------------------------------------

describe('findRelevantProp', () => {
  it('returns the last non-skipped property name', () => {
    expect(findRelevantProp(['VpcId'])).toBe('VpcId');
    expect(findRelevantProp(['Properties', 'VpcId'])).toBe('VpcId');
  });

  it('skips numeric indices', () => {
    expect(findRelevantProp(['SecurityGroups', '0'])).toBe('SecurityGroups');
    // 'VpcId' is not in the skip set, so it should be returned even with a trailing index
    expect(findRelevantProp(['VpcId', '0'])).toBe('VpcId');
  });

  it('skips multi-digit indices', () => {
    expect(findRelevantProp(['SubnetIds', '12'])).toBe('SubnetIds');
  });

  it('skips generic container keys like Fn::Join and Resource', () => {
    expect(findRelevantProp(['Fn::Join', '1', 'VpcId'])).toBe('VpcId');
    expect(findRelevantProp(['PolicyDocument', 'Statement', '0', 'Resource'])).toBe('PolicyDocument');
  });

  it('returns empty string for empty path', () => {
    expect(findRelevantProp([])).toBe('');
  });

  it('returns last element when all are skippable', () => {
    expect(findRelevantProp(['Resource'])).toBe('Resource');
  });
});

// ---------------------------------------------------------------------------
// isInPolicyStatementResource
// ---------------------------------------------------------------------------

describe('isInPolicyStatementResource', () => {
  it('returns true when path contains both PolicyDocument and Statement', () => {
    expect(isInPolicyStatementResource(['PolicyDocument', 'Statement', '0', 'Resource', '0'])).toBe(true);
  });

  it('returns false with only PolicyDocument', () => {
    expect(isInPolicyStatementResource(['PolicyDocument', 'Version'])).toBe(false);
  });

  it('returns false with only Statement', () => {
    expect(isInPolicyStatementResource(['Statement', '0', 'Resource'])).toBe(false);
  });

  it('returns false for unrelated paths', () => {
    expect(isInPolicyStatementResource(['VpcId'])).toBe(false);
    expect(isInPolicyStatementResource([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveIamLabel
// ---------------------------------------------------------------------------

describe('resolveIamLabel', () => {
  it('returns allows stream read from for DynamoDB', () => {
    expect(resolveIamLabel('AWS::DynamoDB::Table')).toBe('allows stream read from');
  });

  it('returns allows send to for SQS', () => {
    expect(resolveIamLabel('AWS::SQS::Queue')).toBe('allows send to');
  });

  it('returns allows access to for S3 bucket', () => {
    expect(resolveIamLabel('AWS::S3::Bucket')).toBe('allows access to');
  });

  it('returns allows invoke of for Lambda', () => {
    expect(resolveIamLabel('AWS::Lambda::Function')).toBe('allows invoke of');
  });

  it('returns allows write to for Logs', () => {
    expect(resolveIamLabel('AWS::Logs::LogGroup')).toBe('allows write to');
  });

  it('returns allows access to for unknown types', () => {
    expect(resolveIamLabel('AWS::EC2::Instance')).toBe('allows access to');
  });
});

// ---------------------------------------------------------------------------
// resolveLabel
// ---------------------------------------------------------------------------

describe('resolveLabel', () => {
  it.each([
    [['VpcId'], 'in'],
    [['SecurityGroups', '0'], 'secured by'],
    [['SecurityGroupIds', '0'], 'secured by'],
    [['VPCSecurityGroups', '0'], 'secured by'],
    [['SubnetIds', '0'], 'placed in'],
    [['Subnets', '0'], 'placed in'],
    [['VPCZoneIdentifier', '0'], 'places instances in'],
    [['TaskDefinition'], 'deploys'],
    [['TaskRoleArn'], 'app runs as'],
    [['ExecutionRoleArn'], 'pulls image via'],
    [['awslogs-group'], 'sends logs to'],
    [['Role'], 'runs as'],
    [['IamInstanceProfile'], 'assumes'],
    [['LoadBalancerArn'], ':80 on'],
    [['ListenerArn'], 'attached to'],
    [['LaunchTemplateId'], 'launches from'],
    [['AutoScalingGroupArn'], 'scales'],
    [['CapacityProviders', '0'], 'registers'],
    [['ScalingTargetId'], 'drives'],
    [['SourceSecurityGroupId'], 'allows traffic from'],
    [['EventSourceArn'], 'streams from'],
    [['FunctionName'], 'invokes'],
    [['FunctionArn'], 'invokes'],
    [['ReplicationConfiguration'], 'replicates via'],
    [['DestinationBucketArn'], 'replicates to'],
    [['DBClusterIdentifier'], 'member of'],
    [['SecretId'], 'links'],
    [['TargetId'], 'links to'],
    [['ClusterSubnetGroupName'], 'placed in'],
    [['DBSubnetGroupName'], 'placed in'],
    [['ClusterParameterGroupName'], 'uses'],
    [['DBParameterGroupName'], 'uses'],
    [['DBClusterParameterGroupName'], 'uses'],
    [['IntegrationUri'], 'forwards to'],
    [['VpcLinkId'], 'routes via'],
    [['Origins'], 'serves from'],
    [['OriginAccessControlId'], 'uses'],
  ])('path %j → label %s', (propPath, expected) => {
    const rel = makeRel(propPath as string[]);
    expect(resolveLabel(rel, 'AWS::Some::Resource', 'AWS::Other::Resource')).toBe(expected);
  });

  describe('Cluster property', () => {
    it('returns associates for CapacityProviderAssociations source', () => {
      expect(resolveLabel(makeRel(['Cluster']), 'AWS::ECS::ClusterCapacityProviderAssociations', '')).toBe(
        'associates',
      );
    });

    it('returns runs in for Service source', () => {
      expect(resolveLabel(makeRel(['Cluster']), 'AWS::ECS::Service', '')).toBe('runs in');
    });

    it('returns in for other sources', () => {
      expect(resolveLabel(makeRel(['Cluster']), 'AWS::AutoScaling::AutoScalingGroup', '')).toBe('in');
    });
  });

  describe('Roles property', () => {
    it('returns wraps for InstanceProfile source', () => {
      expect(resolveLabel(makeRel(['Roles', '0']), 'AWS::IAM::InstanceProfile', '')).toBe('wraps');
    });

    it('returns grants permissions to for Policy source', () => {
      expect(resolveLabel(makeRel(['Roles', '0']), 'AWS::IAM::Policy', '')).toBe('grants permissions to');
    });
  });

  describe('TargetGroupArn property', () => {
    it('returns routes to for ListenerRule source', () => {
      expect(resolveLabel(makeRel(['TargetGroupArn']), 'AWS::ElasticLoadBalancingV2::ListenerRule', '')).toBe(
        'routes to',
      );
    });

    it('returns registers targets with for Service source', () => {
      expect(resolveLabel(makeRel(['TargetGroupArn']), 'AWS::ECS::Service', '')).toBe('registers targets with');
    });

    it('returns registers targets with for TargetGroupARNs property', () => {
      expect(resolveLabel(makeRel(['TargetGroupARNs', '0']), 'AWS::ECS::Service', '')).toBe('registers targets with');
    });
  });

  describe('ResourceId property', () => {
    it('returns scales for ScalableTarget source', () => {
      expect(resolveLabel(makeRel(['ResourceId']), 'AWS::ApplicationAutoScaling::ScalableTarget', '')).toBe('scales');
    });

    it('returns references for other sources', () => {
      expect(resolveLabel(makeRel(['ResourceId']), 'AWS::Some::Resource', '')).toBe('references');
    });
  });

  describe('GroupId property', () => {
    it('returns added to for SecurityGroupIngress source', () => {
      expect(resolveLabel(makeRel(['GroupId']), 'AWS::EC2::SecurityGroupIngress', '')).toBe('added to');
    });

    it('returns secured by for other sources', () => {
      expect(resolveLabel(makeRel(['GroupId']), 'AWS::EC2::Instance', '')).toBe('secured by');
    });
  });

  describe('Bucket/BucketName property', () => {
    it('returns policy for for BucketPolicy source', () => {
      expect(resolveLabel(makeRel(['Bucket']), 'AWS::S3::BucketPolicy', '')).toBe('policy for');
      expect(resolveLabel(makeRel(['BucketName']), 'AWS::S3::BucketPolicy', '')).toBe('policy for');
    });

    it('returns references for other sources', () => {
      expect(resolveLabel(makeRel(['Bucket']), 'AWS::Lambda::Function', '')).toBe('references');
    });
  });

  describe('SourceArn property', () => {
    it('returns streams from for DynamoDB target', () => {
      expect(resolveLabel(makeRel(['SourceArn']), '', 'AWS::DynamoDB::Table')).toBe('streams from');
    });

    it('returns streams from when getAttribute contains StreamArn', () => {
      expect(resolveLabel(makeRel(['SourceArn'], { getAttribute: 'StreamArn' }), '', '')).toBe('streams from');
    });

    it('returns replicates from for RDS target', () => {
      expect(resolveLabel(makeRel(['SourceArn']), '', 'AWS::RDS::DBInstance')).toBe('replicates from');
    });

    it('returns triggered by for other targets', () => {
      expect(resolveLabel(makeRel(['SourceArn']), '', 'AWS::S3::Bucket')).toBe('triggered by');
    });
  });

  describe('TargetArn property', () => {
    it('returns replicates to for Redshift target', () => {
      expect(resolveLabel(makeRel(['TargetArn']), '', 'AWS::Redshift::Cluster')).toBe('replicates to');
    });

    it('returns targets for other targets', () => {
      expect(resolveLabel(makeRel(['TargetArn']), '', 'AWS::S3::Bucket')).toBe('targets');
    });
  });

  it('returns IAM label for policy statement resource paths', () => {
    const rel = makeRel(['PolicyDocument', 'Statement', '0', 'Resource'], { targetType: 'AWS::DynamoDB::Table' });
    expect(resolveLabel(rel, 'AWS::IAM::Policy', 'AWS::DynamoDB::Table')).toBe('allows stream read from');
  });

  it('returns references as fallback for unknown property', () => {
    expect(resolveLabel(makeRel(['SomeUnknownProp']), '', '')).toBe('references');
  });
});

// ---------------------------------------------------------------------------
// inferImportedResource
// ---------------------------------------------------------------------------

describe('inferImportedResource', () => {
  it('extracts sourceStack from the colon separator', () => {
    expect(inferImportedResource('VpcSubnets:ExportsOutputRefVpc123').sourceStack).toBe('VpcSubnets');
  });

  it('returns unknown sourceStack when no colon present', () => {
    expect(inferImportedResource('NoColonHere').sourceStack).toBe('unknown');
  });

  it.each([
    ['VpcSubnets:ExportsOutputRefVpcIsolatedSubnet1', 'AWS::EC2::Subnet', 'isolated'],
    ['VpcSubnets:ExportsOutputRefVpcPrivateSubnet1', 'AWS::EC2::Subnet', 'private'],
    ['VpcSubnets:ExportsOutputRefVpcPublicSubnet1', 'AWS::EC2::Subnet', 'public'],
    ['VpcSubnets:ExportsOutputRefVpcSubnetGeneric', 'AWS::EC2::Subnet', ''],
    ['VpcSubnets:ExportsOutputRefVpc8378EB38', 'AWS::EC2::VPC', ''],
    ['SsmBastion:ExportsOutputFnGetAttBastionSGGroupId', 'AWS::EC2::SecurityGroup', 'Bastion'],
    ['SsmBastion:ExportsOutputFnGetAttBastionSecurityGroupGroupId', 'AWS::EC2::SecurityGroup', 'Bastion'],
    ['NetStack:ExportsOutputFnGetAttAlbSGGroupId', 'AWS::EC2::SecurityGroup', 'ALB'],
    ['NetStack:ExportsOutputFnGetAttLoadBalancerSGGroupId', 'AWS::EC2::SecurityGroup', 'ALB'],
    ['NetStack:ExportsOutputFnGetAttAlbSecurityGroupGroupId', 'AWS::EC2::SecurityGroup', 'ALB'],
    ['NetStack:ExportsOutputFnGetAttSecurityGroup123', 'AWS::EC2::SecurityGroup', ''],
    ['ClusterStack:ExportsOutputRefEcsCluster123', 'AWS::ECS::Cluster', ''],
    ['ClusterStack:ExportsOutputRefCluster123', 'AWS::ECS::Cluster', ''],
    ['NetStack:ExportsOutputRefListener123', 'AWS::ElasticLoadBalancingV2::Listener', ''],
    ['NetStack:ExportsOutputRefLoadBalancer123', 'AWS::ElasticLoadBalancingV2::LoadBalancer', ''],
    ['NetStack:ExportsOutputRefAlb123', 'AWS::ElasticLoadBalancingV2::LoadBalancer', ''],
    ['InfraStack:ExportsOutputRefNamespace123', 'AWS::ServiceDiscovery::PrivateDnsNamespace', ''],
    ['ClusterStack:ExportsOutputRefCapacityProvider123', 'AWS::ECS::CapacityProvider', ''],
    ['RdsStack:ExportsOutputRefInstance123', 'AWS::RDS::DBInstance', ''],
    ['SearchStack:ExportsOutputRefOpenSearchDomain', 'AWS::OpenSearchService::Domain', ''],
    ['CacheStack:ExportsOutputRefElastiCacheCluster', 'AWS::ElastiCache::ReplicationGroup', ''],
    ['CacheStack:ExportsOutputRefReplicationGroup', 'AWS::ElastiCache::ReplicationGroup', ''],
  ])('%s → type=%s qualifier=%s', (exportName, expectedType, expectedQualifier) => {
    const result = inferImportedResource(exportName);
    expect(result.type).toBe(expectedType);
    expect(result.qualifier).toBe(expectedQualifier);
  });

  it('does not match VpcLink as a VPC', () => {
    // VpcLink should not be classified as AWS::EC2::VPC
    const result = inferImportedResource('ApiStack:ExportsOutputRefVpcLink123');
    expect(result.type).not.toBe('AWS::EC2::VPC');
  });

  it('returns unknown type for unrecognized export names', () => {
    const result = inferImportedResource('SomeStack:ExportsOutputRefSomeRandomThing');
    expect(result.type).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// entityLabel
// ---------------------------------------------------------------------------

describe('entityLabel', () => {
  it('includes construct name when present', () => {
    const entry = makeEntry({ stackName: 'MyStack', type: 'AWS::S3::Bucket', constructName: 'MyBucket' });
    expect(entityLabel(entry)).toBe('[MyStack] AWS::S3::Bucket (MyBucket)');
  });

  it('omits parentheses when constructName is empty', () => {
    const entry = makeEntry({ stackName: 'MyStack', type: 'AWS::S3::Bucket', constructName: '' });
    expect(entityLabel(entry)).toBe('[MyStack] AWS::S3::Bucket');
  });
});

// ---------------------------------------------------------------------------
// importedEntityLabel
// ---------------------------------------------------------------------------

describe('importedEntityLabel', () => {
  it('omits qualifier when empty', () => {
    const entity = { sourceStack: 'VpcSubnets', type: 'AWS::EC2::VPC', qualifier: '', exportNames: new Set(['a']) };
    expect(importedEntityLabel(entity)).toBe('[VpcSubnets (imported)] AWS::EC2::VPC');
  });

  it('shows qualifier without count for single export', () => {
    const entity = {
      sourceStack: 'VpcSubnets',
      type: 'AWS::EC2::Subnet',
      qualifier: 'isolated',
      exportNames: new Set(['a']),
    };
    expect(importedEntityLabel(entity)).toBe('[VpcSubnets (imported)] AWS::EC2::Subnet (isolated)');
  });

  it('shows count prefix for multiple exports', () => {
    const entity = {
      sourceStack: 'VpcSubnets',
      type: 'AWS::EC2::Subnet',
      qualifier: 'private',
      exportNames: new Set(['a', 'b', 'c']),
    };
    expect(importedEntityLabel(entity)).toBe('[VpcSubnets (imported)] AWS::EC2::Subnet (3x private)');
  });
});

// ---------------------------------------------------------------------------
// deduplicateRelationships
// ---------------------------------------------------------------------------

describe('deduplicateRelationships', () => {
  function rel(srcId: string, tgtId: string, label: string) {
    return {
      sourceStack: 'S',
      sourceLogicalId: srcId,
      targetStack: 'S',
      targetLogicalId: tgtId,
      targetType: 'T',
      propertyPath: [],
      refType: 'Ref' as const,
      label,
    };
  }

  it('removes exact duplicates', () => {
    const rels = [rel('A', 'B', 'in'), rel('A', 'B', 'in')];
    expect(deduplicateRelationships(rels)).toHaveLength(1);
  });

  it('keeps relationships with different labels to the same target', () => {
    const rels = [rel('A', 'B', 'in'), rel('A', 'B', 'secured by')];
    expect(deduplicateRelationships(rels)).toHaveLength(2);
  });

  it('keeps relationships to different targets', () => {
    const rels = [rel('A', 'B', 'in'), rel('A', 'C', 'in')];
    expect(deduplicateRelationships(rels)).toHaveLength(2);
  });

  it('returns empty array for empty input', () => {
    expect(deduplicateRelationships([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// extractRelationships
// ---------------------------------------------------------------------------

describe('extractRelationships', () => {
  function makeSource(properties: Record<string, unknown>) {
    return makeEntry({ logicalId: 'Source', type: 'AWS::EC2::SecurityGroup', stackName: 'MyStack', properties });
  }

  function makeGlobalMap(extraEntries: Array<{ logicalId: string; type: string }> = []) {
    const globalMap = new Map();
    globalMap.set('MyStack::Source', makeEntry({ logicalId: 'Source' }));
    for (const e of extraEntries) {
      globalMap.set(`MyStack::${e.logicalId}`, makeEntry({ logicalId: e.logicalId, type: e.type }));
    }
    return globalMap;
  }

  it('extracts a Ref to a same-stack resource', () => {
    const target = { logicalId: 'TargetVpc', type: 'AWS::EC2::VPC' };
    const source = makeSource({ VpcId: { Ref: 'TargetVpc' } });
    const globalMap = makeGlobalMap([target]);
    const stackResources = new Set(['Source', 'TargetVpc']);
    const importMap = new Map();

    const rels = extractRelationships(source, stackResources, new Set(), globalMap, importMap);
    expect(rels).toHaveLength(1);
    expect(rels[0]).toMatchObject({ targetLogicalId: 'TargetVpc', label: 'in', refType: 'Ref' });
  });

  it('skips Ref to CF pseudo-parameter', () => {
    const source = makeSource({ Region: { Ref: 'AWS::Region' } });
    const rels = extractRelationships(source, new Set(['Source']), new Set(), new Map(), new Map());
    expect(rels).toHaveLength(0);
  });

  it('skips Ref to a template parameter', () => {
    const source = makeSource({ Name: { Ref: 'MyParam' } });
    const rels = extractRelationships(
      source,
      new Set(['Source', 'MyParam']),
      new Set(['MyParam']),
      new Map(),
      new Map(),
    );
    expect(rels).toHaveLength(0);
  });

  it('skips Ref to an unknown logical ID not in stackResources', () => {
    const source = makeSource({ VpcId: { Ref: 'NonExistent' } });
    const rels = extractRelationships(source, new Set(['Source']), new Set(), new Map(), new Map());
    expect(rels).toHaveLength(0);
  });

  it('extracts a Fn::GetAtt reference', () => {
    const target = { logicalId: 'MySG', type: 'AWS::EC2::SecurityGroup' };
    const source = makeSource({ GroupId: { 'Fn::GetAtt': ['MySG', 'GroupId'] } });
    const globalMap = makeGlobalMap([target]);
    const stackResources = new Set(['Source', 'MySG']);

    const rels = extractRelationships(source, stackResources, new Set(), globalMap, new Map());
    expect(rels).toHaveLength(1);
    expect(rels[0]).toMatchObject({ targetLogicalId: 'MySG', refType: 'Fn::GetAtt', getAttribute: 'GroupId' });
  });

  it('skips Fn::GetAtt to an unknown logical ID', () => {
    const source = makeSource({ GroupId: { 'Fn::GetAtt': ['Unknown', 'GroupId'] } });
    const rels = extractRelationships(source, new Set(['Source']), new Set(), new Map(), new Map());
    expect(rels).toHaveLength(0);
  });

  it('extracts Fn::ImportValue and populates importMap', () => {
    const source = makeSource({ VpcId: { 'Fn::ImportValue': 'VpcSubnets:ExportsOutputRefVpc123' } });
    const importMap = new Map();
    const rels = extractRelationships(source, new Set(['Source']), new Set(), new Map(), importMap);

    expect(rels).toHaveLength(1);
    expect(rels[0].refType).toBe('Fn::ImportValue');
    expect(rels[0].label).toBe('in');
    expect(importMap.size).toBe(1);
    const [entity] = importMap.values();
    expect(entity.type).toBe('AWS::EC2::VPC');
    expect(entity.sourceStack).toBe('VpcSubnets');
  });

  it('deduplicates importMap entries for the same import type', () => {
    const source = makeSource({
      SubnetIds: [
        { 'Fn::ImportValue': 'VpcSubnets:ExportsOutputRefVpcIsolatedSubnet1' },
        { 'Fn::ImportValue': 'VpcSubnets:ExportsOutputRefVpcIsolatedSubnet2' },
        { 'Fn::ImportValue': 'VpcSubnets:ExportsOutputRefVpcIsolatedSubnet3' },
      ],
    });
    const importMap = new Map();
    const rels = extractRelationships(source, new Set(['Source']), new Set(), new Map(), importMap);

    expect(rels).toHaveLength(3);
    // All 3 map to the same importMap entry
    expect(importMap.size).toBe(1);
    const [entity] = importMap.values();
    expect(entity.exportNames.size).toBe(3);
    expect(entity.qualifier).toBe('isolated');
  });

  it('recurses into nested arrays and objects', () => {
    const target = { logicalId: 'MyTable', type: 'AWS::DynamoDB::Table' };
    const source = makeSource({
      Environment: {
        Variables: {
          TABLE_NAME: { Ref: 'MyTable' },
        },
      },
    });
    const globalMap = makeGlobalMap([target]);
    const stackResources = new Set(['Source', 'MyTable']);

    const rels = extractRelationships(source, stackResources, new Set(), globalMap, new Map());
    expect(rels).toHaveLength(1);
    expect(rels[0].targetLogicalId).toBe('MyTable');
  });

  it('recurses into Fn::Join arrays', () => {
    const target = { logicalId: 'MySecret', type: 'AWS::SecretsManager::Secret' };
    const source = makeSource({
      MasterUserPassword: { 'Fn::Join': ['', ['{{resolve:secretsmanager:', { Ref: 'MySecret' }, ':SecretString::}}']] },
    });
    const globalMap = makeGlobalMap([target]);
    const stackResources = new Set(['Source', 'MySecret']);

    const rels = extractRelationships(source, stackResources, new Set(), globalMap, new Map());
    expect(rels).toHaveLength(1);
    expect(rels[0].targetLogicalId).toBe('MySecret');
  });
});

// ---------------------------------------------------------------------------
// findCfFiles
// ---------------------------------------------------------------------------

describe('findCfFiles', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns sorted paths for matching yaml files', () => {
    (fs.readdirSync as jest.Mock).mockReturnValue([
      'cloud_formation_rds.yaml',
      'cloud_formation.yaml',
      'README.md',
      'stack.ts',
    ]);

    const files = findCfFiles('/some/dir');
    expect(files).toEqual(['/some/dir/cloud_formation.yaml', '/some/dir/cloud_formation_rds.yaml']);
  });

  it('returns empty array when no matching files exist', () => {
    (fs.readdirSync as jest.Mock).mockReturnValue([]);
    expect(findCfFiles('/some/dir')).toEqual([]);
  });

  it('excludes files not matching the pattern', () => {
    (fs.readdirSync as jest.Mock).mockReturnValue([
      'some_cloud_formation.yaml', // does not start with cloud_formation
      'cloud_formation.json', // not .yaml
      'cloud_formation.yaml',
    ]);

    const files = findCfFiles('/some/dir');
    expect(files).toEqual(['/some/dir/cloud_formation.yaml']);
  });
});

// ---------------------------------------------------------------------------
// loadTemplate
// ---------------------------------------------------------------------------

describe('loadTemplate', () => {
  beforeEach(() => jest.clearAllMocks());

  it('parses a YAML file into a CfTemplate object', () => {
    const yamlContent = `
Resources:
  MyBucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: my-bucket
`;
    (fs.readFileSync as jest.Mock).mockReturnValue(yamlContent);
    const template = loadTemplate('/fake/path.yaml');
    expect(template.Resources?.['MyBucket']?.Type).toBe('AWS::S3::Bucket');
    expect((template.Resources?.['MyBucket']?.Properties as any)?.BucketName).toBe('my-bucket');
  });
});

// ---------------------------------------------------------------------------
// formatOutput
// ---------------------------------------------------------------------------

describe('formatOutput', () => {
  function makeImportMap(entities: Array<{ sourceStack: string; type: string; qualifier: string; count: number }>) {
    const m = new Map();
    for (const e of entities) {
      const key = `${e.sourceStack}::${e.type}::${e.qualifier}`;
      m.set(key, {
        sourceStack: e.sourceStack,
        type: e.type,
        qualifier: e.qualifier,
        exportNames: new Set(Array.from({ length: e.count }, (_, i) => `export${i}`)),
      });
    }
    return m;
  }

  it('emits VPC-contains-Subnet section when both are imported', () => {
    const importMap = makeImportMap([
      { sourceStack: 'VpcSubnets', type: 'AWS::EC2::VPC', qualifier: '', count: 1 },
      { sourceStack: 'VpcSubnets', type: 'AWS::EC2::Subnet', qualifier: 'private', count: 3 },
    ]);

    const output = formatOutput(new Map(), [], new Map(), importMap);
    expect(output).toContain('# Imported: VpcSubnets');
    expect(output).toContain(
      '[VpcSubnets (imported)] AWS::EC2::VPC -> contains -> [VpcSubnets (imported)] AWS::EC2::Subnet (3x private)',
    );
  });

  it('skips VPC-contains-Subnet when no subnets imported', () => {
    const importMap = makeImportMap([{ sourceStack: 'VpcSubnets', type: 'AWS::EC2::VPC', qualifier: '', count: 1 }]);
    const output = formatOutput(new Map(), [], new Map(), importMap);
    expect(output).not.toContain('# Imported:');
  });

  it('skips VPC-contains-Subnet when no VPC imported', () => {
    const importMap = makeImportMap([
      { sourceStack: 'VpcSubnets', type: 'AWS::EC2::Subnet', qualifier: 'isolated', count: 3 },
    ]);
    const output = formatOutput(new Map(), [], new Map(), importMap);
    expect(output).not.toContain('# Imported:');
  });

  it('emits stack section with formatted relationships', () => {
    const srcEntry = makeEntry({
      logicalId: 'MyBucket',
      type: 'AWS::S3::Bucket',
      constructName: 'Bucket',
      stackName: 'AppStack',
    });
    const tgtEntry = makeEntry({
      logicalId: 'MyRole',
      type: 'AWS::IAM::Role',
      constructName: 'Role',
      stackName: 'AppStack',
    });
    const globalMap = new Map([
      ['AppStack::MyBucket', srcEntry],
      ['AppStack::MyRole', tgtEntry],
    ]);
    const stackGroups = new Map([['AppStack', [srcEntry, tgtEntry]]]);
    const relationships = [
      {
        sourceStack: 'AppStack',
        sourceLogicalId: 'MyBucket',
        targetStack: 'AppStack',
        targetLogicalId: 'MyRole',
        targetType: 'AWS::IAM::Role',
        propertyPath: ['Role'],
        refType: 'Ref' as const,
        label: 'runs as',
      },
    ];

    const output = formatOutput(stackGroups, relationships, globalMap, new Map());
    expect(output).toContain('# Stack: AppStack');
    expect(output).toContain('[AppStack] AWS::S3::Bucket (Bucket) -> runs as -> [AppStack] AWS::IAM::Role (Role)');
  });

  it('skips stacks with no relationships', () => {
    const entry = makeEntry({ logicalId: 'MyBucket', stackName: 'AppStack' });
    const stackGroups = new Map([['AppStack', [entry]]]);

    const output = formatOutput(stackGroups, [], new Map([['AppStack::MyBucket', entry]]), new Map());
    expect(output).not.toContain('# Stack: AppStack');
  });

  it('deduplicates identical relationships in output', () => {
    const srcEntry = makeEntry({ logicalId: 'Src', type: 'AWS::S3::Bucket', constructName: 'Src', stackName: 'S' });
    const tgtEntry = makeEntry({ logicalId: 'Tgt', type: 'AWS::IAM::Role', constructName: 'Tgt', stackName: 'S' });
    const globalMap = new Map([
      ['S::Src', srcEntry],
      ['S::Tgt', tgtEntry],
    ]);
    const stackGroups = new Map([['S', [srcEntry]]]);
    const dup = {
      sourceStack: 'S',
      sourceLogicalId: 'Src',
      targetStack: 'S',
      targetLogicalId: 'Tgt',
      targetType: 'AWS::IAM::Role',
      propertyPath: [],
      refType: 'Ref' as const,
      label: 'runs as',
    };

    const output = formatOutput(stackGroups, [dup, dup], globalMap, new Map());
    const occurrences = (output.match(/runs as/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it('formats cross-stack (ImportValue) relationships using importedEntityLabel', () => {
    const srcEntry = makeEntry({
      logicalId: 'MySG',
      type: 'AWS::EC2::SecurityGroup',
      constructName: 'DbSG',
      stackName: 'RdsStack',
    });
    const globalMap = new Map([['RdsStack::MySG', srcEntry]]);
    const stackGroups = new Map([['RdsStack', [srcEntry]]]);
    const importKey = 'VpcSubnets::AWS::EC2::VPC::';
    const importMap = new Map([
      [importKey, { sourceStack: 'VpcSubnets', type: 'AWS::EC2::VPC', qualifier: '', exportNames: new Set(['e1']) }],
    ]);
    const rel = {
      sourceStack: 'RdsStack',
      sourceLogicalId: 'MySG',
      targetStack: 'VpcSubnets (imported)',
      targetLogicalId: importKey,
      targetType: 'AWS::EC2::VPC',
      propertyPath: ['VpcId'],
      refType: 'Fn::ImportValue' as const,
      label: 'in',
    };

    const output = formatOutput(stackGroups, [rel], globalMap, importMap);
    expect(output).toContain(
      '[RdsStack] AWS::EC2::SecurityGroup (DbSG) -> in -> [VpcSubnets (imported)] AWS::EC2::VPC',
    );
  });
});
