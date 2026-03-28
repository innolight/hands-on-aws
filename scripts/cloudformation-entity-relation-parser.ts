/**
 * cloudformation-entity-relation-parser.ts
 *
 * Parses CloudFormation YAML files in a pattern directory and outputs entity
 * relationships as plain text. Output is designed as input for a diagram agent.
 *
 * Usage:
 *   npx ts-node scripts/cloudformation-entity-relation-parser.ts <pattern-dir>
 *
 * Output format:
 *   [StackName] AWS::Type (ConstructName) -> label -> [StackName] AWS::Type (ConstructName)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CfTemplate {
  Resources?: Record<string, CfResource>;
  Parameters?: Record<string, unknown>;
}

interface CfResource {
  Type: string;
  Properties?: Record<string, unknown>;
  Metadata?: Record<string, unknown>;
}

interface ResourceEntry {
  logicalId: string;
  type: string;
  constructName: string;
  properties: Record<string, unknown>;
  stackName: string;
}

interface Relationship {
  sourceStack: string;
  sourceLogicalId: string;
  targetStack: string;
  targetLogicalId: string; // logicalId for same-stack; importKey for cross-stack
  targetType: string;
  propertyPath: string[];
  refType: 'Ref' | 'Fn::GetAtt' | 'Fn::ImportValue';
  getAttribute?: string;
  label: string;
}

interface ImportedEntity {
  sourceStack: string;
  type: string;
  qualifier: string; // 'public' | 'private' | 'isolated' | ''
  exportNames: Set<string>;
}

// Key: sourceStack::type::qualifier
type ImportMap = Map<string, ImportedEntity>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CF_PSEUDO_PARAMS = new Set([
  'AWS::StackName',
  'AWS::AccountId',
  'AWS::Region',
  'AWS::Partition',
  'AWS::URLSuffix',
  'AWS::NoValue',
  'AWS::NotificationARNs',
  'AWS::StackId',
]);

// ---------------------------------------------------------------------------
// Phase 1: Parse YAML files
// ---------------------------------------------------------------------------

export function findCfFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => /^cloud_formation.*\.yaml$/.test(f))
    .map((f) => path.join(dir, f))
    .sort();
}

export function loadTemplate(filePath: string): CfTemplate {
  const content = fs.readFileSync(filePath, 'utf-8');
  return yaml.load(content) as CfTemplate;
}

// ---------------------------------------------------------------------------
// Phase 2: Extract resources
// ---------------------------------------------------------------------------

export function isCdkScaffolding(type: string, cdkPath: string): boolean {
  if (type === 'AWS::CDK::Metadata') return true;
  if (type.startsWith('Custom::')) return true;
  if (cdkPath.includes('Custom::') || cdkPath.includes('BucketNotificationsHandler')) return true;
  // CDK AwsCustomResource backing Lambda/Role/Policy:
  //   - path segment is a hex hash like AWS679f53fac002430cb0da5b7982bd2287
  //   - or path contains CustomResourcePolicy
  if (/AWS[0-9a-f]{20,}/.test(cdkPath)) return true;
  if (cdkPath.includes('CustomResourcePolicy')) return true;
  return false;
}

export function deriveStackName(template: CfTemplate): string {
  const resources = template.Resources ?? {};
  for (const res of Object.values(resources)) {
    const cdkPath = (res.Metadata?.['aws:cdk:path'] as string) ?? '';
    if (cdkPath) return cdkPath.split('/')[0];
  }
  return 'UnknownStack';
}

export function deriveConstructName(cdkPath: string): string {
  if (!cdkPath) return '';
  // e.g. "MyStack/DbSG/Resource" -> "DbSG"
  // e.g. "MyStack/Instance/Secret/Resource" -> "Secret"
  // e.g. "MyStack/Instance/SubnetGroup/Default" -> "SubnetGroup"
  const parts = cdkPath.split('/');
  // Remove the stack name (first) and trailing "Resource"/"Default" segments
  const meaningful = parts.slice(1).filter((p) => p !== 'Resource' && p !== 'Default');
  return meaningful[meaningful.length - 1] ?? parts[parts.length - 1];
}

export function extractResources(
  template: CfTemplate,
  stackName: string,
  globalMap: Map<string, ResourceEntry>,
): ResourceEntry[] {
  const entries: ResourceEntry[] = [];
  for (const [logicalId, res] of Object.entries(template.Resources ?? {})) {
    const cdkPath = (res.Metadata?.['aws:cdk:path'] as string) ?? '';
    if (isCdkScaffolding(res.Type, cdkPath)) continue;

    const entry: ResourceEntry = {
      logicalId,
      type: res.Type,
      constructName: deriveConstructName(cdkPath),
      properties: res.Properties ?? {},
      stackName,
    };
    entries.push(entry);
    globalMap.set(`${stackName}::${logicalId}`, entry);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Phase 3: Extract relationships
// ---------------------------------------------------------------------------

export function extractRelationships(
  source: ResourceEntry,
  stackResources: Set<string>,
  paramNames: Set<string>,
  globalMap: Map<string, ResourceEntry>,
  importMap: ImportMap,
): Relationship[] {
  const rels: Relationship[] = [];

  function walk(value: unknown, propPath: string[]): void {
    if (value === null || value === undefined) return;

    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, [...propPath, String(i)]));
      return;
    }

    if (typeof value !== 'object') return;

    const obj = value as Record<string, unknown>;

    // Handle Ref
    if ('Ref' in obj && typeof obj['Ref'] === 'string') {
      const target = obj['Ref'] as string;
      if (!CF_PSEUDO_PARAMS.has(target) && !paramNames.has(target) && stackResources.has(target)) {
        const targetEntry = globalMap.get(`${source.stackName}::${target}`);
        const rel: Relationship = {
          sourceStack: source.stackName,
          sourceLogicalId: source.logicalId,
          targetStack: source.stackName,
          targetLogicalId: target,
          targetType: targetEntry?.type ?? 'unknown',
          propertyPath: propPath,
          refType: 'Ref',
          label: '',
        };
        rel.label = resolveLabel(rel, source.type, targetEntry?.type ?? '');
        rels.push(rel);
      }
      return;
    }

    // Handle Fn::GetAtt
    if ('Fn::GetAtt' in obj) {
      const ga = obj['Fn::GetAtt'];
      if (Array.isArray(ga) && ga.length === 2) {
        const [logicalId, attribute] = ga as [string, string];
        if (stackResources.has(logicalId)) {
          const targetEntry = globalMap.get(`${source.stackName}::${logicalId}`);
          const rel: Relationship = {
            sourceStack: source.stackName,
            sourceLogicalId: source.logicalId,
            targetStack: source.stackName,
            targetLogicalId: logicalId,
            targetType: targetEntry?.type ?? 'unknown',
            propertyPath: propPath,
            refType: 'Fn::GetAtt',
            getAttribute: attribute,
            label: '',
          };
          rel.label = resolveLabel(rel, source.type, targetEntry?.type ?? '');
          rels.push(rel);
        }
      }
      return;
    }

    // Handle Fn::ImportValue
    if ('Fn::ImportValue' in obj && typeof obj['Fn::ImportValue'] === 'string') {
      const exportName = obj['Fn::ImportValue'] as string;
      const imported = inferImportedResource(exportName);
      const importKey = `${imported.sourceStack}::${imported.type}::${imported.qualifier}`;
      if (!importMap.has(importKey)) {
        importMap.set(importKey, {
          sourceStack: imported.sourceStack,
          type: imported.type,
          qualifier: imported.qualifier,
          exportNames: new Set(),
        });
      }
      importMap.get(importKey)!.exportNames.add(exportName);

      const rel: Relationship = {
        sourceStack: source.stackName,
        sourceLogicalId: source.logicalId,
        targetStack: `${imported.sourceStack} (imported)`,
        targetLogicalId: importKey,
        targetType: imported.type,
        propertyPath: propPath,
        refType: 'Fn::ImportValue',
        label: '',
      };
      rel.label = resolveLabel(rel, source.type, imported.type);
      rels.push(rel);
      return;
    }

    // Recurse into plain objects (including Fn::Join, Fn::Sub arrays, etc.)
    for (const [key, val] of Object.entries(obj)) {
      walk(val, [...propPath, key]);
    }
  }

  walk(source.properties, []);
  return rels;
}

// ---------------------------------------------------------------------------
// Label resolution
// ---------------------------------------------------------------------------

export function findRelevantProp(path: string[]): string {
  // Walk backward, skip numeric indices and generic container keys
  const skip = new Set([
    '0',
    '1',
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
    '8',
    '9',
    'Properties',
    'Statement',
    'Resource',
    'Fn::Join',
    'Fn::Sub',
    'Fn::Select',
    'Fn::Split',
    'Fn::If',
    'Fn::GetAtt',
    'Ref',
  ]);
  for (let i = path.length - 1; i >= 0; i--) {
    const p = path[i];
    if (!skip.has(p) && !/^\d+$/.test(p)) return p;
  }
  return path[path.length - 1] ?? '';
}

export function isInPolicyStatementResource(propPath: string[]): boolean {
  // Path contains PolicyDocument -> Statement -> N -> Resource
  const joined = propPath.join('/');
  return joined.includes('PolicyDocument') && joined.includes('Statement');
}

export function resolveIamLabel(targetType: string): string {
  if (targetType.includes('DynamoDB')) return 'allows stream read from';
  if (targetType.includes('SQS')) return 'allows send to';
  if (targetType.includes('S3::Bucket')) return 'allows access to';
  if (targetType.includes('Lambda')) return 'allows invoke of';
  if (targetType.includes('Logs')) return 'allows write to';
  return 'allows access to';
}

export function resolveLabel(rel: Relationship, sourceType: string, targetType: string): string {
  const prop = findRelevantProp(rel.propertyPath);
  const attr = rel.getAttribute ?? '';

  switch (prop) {
    case 'VpcId':
      return 'in';
    case 'SecurityGroups':
    case 'SecurityGroupIds':
    case 'VPCSecurityGroups':
      return 'secured by';
    case 'SubnetIds':
    case 'Subnets':
      return 'placed in';
    case 'VPCZoneIdentifier':
      return 'places instances in';
    case 'Cluster':
      if (sourceType.includes('CapacityProviderAssociations')) return 'associates';
      if (sourceType.includes('Service')) return 'runs in';
      return 'in';
    case 'TaskDefinition':
      return 'deploys';
    case 'TaskRoleArn':
      return 'app runs as';
    case 'ExecutionRoleArn':
      return 'pulls image via';
    case 'awslogs-group':
      return 'sends logs to';
    case 'Roles':
      if (sourceType.includes('InstanceProfile')) return 'wraps';
      return 'grants permissions to';
    case 'Role':
      return 'runs as';
    case 'IamInstanceProfile':
      return 'assumes';
    case 'LoadBalancerArn':
      return ':80 on';
    case 'TargetGroupArn':
    case 'TargetGroupARNs':
      if (sourceType.includes('ListenerRule')) return 'routes to';
      return 'registers targets with';
    case 'ListenerArn':
      return 'attached to';
    case 'LaunchTemplateId':
      return 'launches from';
    case 'AutoScalingGroupArn':
      return 'scales';
    case 'CapacityProviders':
      return 'registers';
    case 'ScalingTargetId':
      return 'drives';
    case 'ResourceId':
      if (sourceType.includes('ScalableTarget')) return 'scales';
      return 'references';
    case 'SourceSecurityGroupId':
      return 'allows traffic from';
    case 'GroupId':
      if (sourceType.includes('SecurityGroupIngress')) return 'added to';
      return 'secured by';
    case 'EventSourceArn':
      return 'streams from';
    case 'FunctionName':
    case 'FunctionArn':
      return 'invokes';
    case 'ReplicationConfiguration':
      return 'replicates via';
    case 'DestinationBucketArn':
      return 'replicates to';
    case 'Bucket':
    case 'BucketName':
      if (sourceType.includes('BucketPolicy')) return 'policy for';
      return 'references';
    case 'DBClusterIdentifier':
      return 'member of';
    case 'SecretId':
      return 'links';
    case 'TargetId':
      return 'links to';
    case 'ClusterSubnetGroupName':
    case 'DBSubnetGroupName':
      return 'placed in';
    case 'ClusterParameterGroupName':
    case 'DBParameterGroupName':
    case 'DBClusterParameterGroupName':
      return 'uses';
    case 'SourceArn':
      if (attr.includes('StreamArn') || targetType.includes('DynamoDB')) return 'streams from';
      if (targetType.includes('RDS') || targetType.includes('Aurora')) return 'replicates from';
      return 'triggered by';
    case 'TargetArn':
      if (targetType.includes('Redshift')) return 'replicates to';
      return 'targets';
    case 'IntegrationUri':
      return 'forwards to';
    case 'VpcLinkId':
      return 'routes via';
    case 'Origins':
      return 'serves from';
    case 'OriginAccessControlId':
      return 'uses';
    default:
      break;
  }

  // IAM Policy statement resources
  if (isInPolicyStatementResource(rel.propertyPath)) {
    return resolveIamLabel(targetType);
  }

  return 'references';
}

// ---------------------------------------------------------------------------
// Cross-stack import inference
// ---------------------------------------------------------------------------

export function inferImportedResource(exportName: string): { sourceStack: string; type: string; qualifier: string } {
  const colonIdx = exportName.indexOf(':');
  const sourceStack = colonIdx >= 0 ? exportName.slice(0, colonIdx) : 'unknown';
  const fragment = colonIdx >= 0 ? exportName.slice(colonIdx + 1) : exportName;

  if (/IsolatedSubnet/i.test(fragment)) return { sourceStack, type: 'AWS::EC2::Subnet', qualifier: 'isolated' };
  if (/PrivateSubnet/i.test(fragment)) return { sourceStack, type: 'AWS::EC2::Subnet', qualifier: 'private' };
  if (/PublicSubnet/i.test(fragment)) return { sourceStack, type: 'AWS::EC2::Subnet', qualifier: 'public' };
  if (/Subnet/i.test(fragment)) return { sourceStack, type: 'AWS::EC2::Subnet', qualifier: '' };
  if (/Vpc(?!Link)/i.test(fragment) && !/Subnet/.test(fragment))
    return { sourceStack, type: 'AWS::EC2::VPC', qualifier: '' };
  if (/BastionSG|BastionSecurityGroup/i.test(fragment))
    return { sourceStack, type: 'AWS::EC2::SecurityGroup', qualifier: 'Bastion' };
  if (/(?:Alb|Elb|LoadBalancer)SG|AlbSecurityGroup/i.test(fragment))
    return { sourceStack, type: 'AWS::EC2::SecurityGroup', qualifier: 'ALB' };
  if (/SecurityGroup/i.test(fragment)) return { sourceStack, type: 'AWS::EC2::SecurityGroup', qualifier: '' };
  if (/ElastiCache|ReplicationGroup/i.test(fragment))
    return { sourceStack, type: 'AWS::ElastiCache::ReplicationGroup', qualifier: '' };
  if (/EcsCluster|Cluster/i.test(fragment)) return { sourceStack, type: 'AWS::ECS::Cluster', qualifier: '' };
  if (/Listener/i.test(fragment)) return { sourceStack, type: 'AWS::ElasticLoadBalancingV2::Listener', qualifier: '' };
  if (/LoadBalancer|Alb/i.test(fragment))
    return { sourceStack, type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', qualifier: '' };
  if (/Namespace/i.test(fragment))
    return { sourceStack, type: 'AWS::ServiceDiscovery::PrivateDnsNamespace', qualifier: '' };
  if (/CapacityProvider/i.test(fragment)) return { sourceStack, type: 'AWS::ECS::CapacityProvider', qualifier: '' };
  if (/Instance/i.test(fragment)) return { sourceStack, type: 'AWS::RDS::DBInstance', qualifier: '' };
  if (/OpenSearch|Domain/i.test(fragment))
    return { sourceStack, type: 'AWS::OpenSearchService::Domain', qualifier: '' };

  return { sourceStack, type: 'unknown', qualifier: fragment.slice(0, 30) };
}

// ---------------------------------------------------------------------------
// Phase 4: Format output
// ---------------------------------------------------------------------------

export function entityLabel(entry: ResourceEntry): string {
  const name = entry.constructName ? ` (${entry.constructName})` : '';
  return `[${entry.stackName}] ${entry.type}${name}`;
}

export function importedEntityLabel(entity: ImportedEntity): string {
  const count = entity.exportNames.size;
  const qualifier = entity.qualifier ? ` (${count > 1 ? `${count}x ` : ''}${entity.qualifier})` : '';
  return `[${entity.sourceStack} (imported)] ${entity.type}${qualifier}`;
}

export function deduplicateRelationships(rels: Relationship[]): Relationship[] {
  const seen = new Set<string>();
  return rels.filter((r) => {
    const key = `${r.sourceStack}::${r.sourceLogicalId}::${r.targetStack}::${r.targetLogicalId}::${r.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function formatOutput(
  stackGroups: Map<string, ResourceEntry[]>,
  relationships: Relationship[],
  globalMap: Map<string, ResourceEntry>,
  importMap: ImportMap,
): string {
  const lines: string[] = [];
  const deduped = deduplicateRelationships(relationships);

  // Emit imported entity VPC-contains-Subnet relationships
  const importedByStack = new Map<string, ImportedEntity[]>();
  for (const entity of importMap.values()) {
    const arr = importedByStack.get(entity.sourceStack) ?? [];
    arr.push(entity);
    importedByStack.set(entity.sourceStack, arr);
  }

  for (const [srcStack, entities] of importedByStack) {
    const vpcEntity = entities.find((e) => e.type === 'AWS::EC2::VPC');
    const subnetEntities = entities.filter((e) => e.type === 'AWS::EC2::Subnet');
    if (vpcEntity && subnetEntities.length > 0) {
      lines.push(`# Imported: ${srcStack}`);
      for (const subnet of subnetEntities) {
        lines.push(`${importedEntityLabel(vpcEntity)} -> contains -> ${importedEntityLabel(subnet)}`);
      }
      lines.push('');
    }
  }

  // Emit per-stack relationships
  for (const [stackName] of stackGroups) {
    const stackRels = deduped.filter((r) => r.sourceStack === stackName);
    if (stackRels.length === 0) continue;

    lines.push(`# Stack: ${stackName}`);
    for (const rel of stackRels) {
      const srcEntry = globalMap.get(`${rel.sourceStack}::${rel.sourceLogicalId}`);
      if (!srcEntry) continue;

      let targetLabel: string;
      if (rel.refType === 'Fn::ImportValue') {
        const importedEntity = importMap.get(rel.targetLogicalId);
        targetLabel = importedEntity ? importedEntityLabel(importedEntity) : rel.targetLogicalId;
      } else {
        const targetEntry = globalMap.get(`${rel.targetStack}::${rel.targetLogicalId}`);
        targetLabel = targetEntry
          ? entityLabel(targetEntry)
          : `[${rel.targetStack}] ${rel.targetType} (${rel.targetLogicalId})`;
      }

      lines.push(`${entityLabel(srcEntry)} -> ${rel.label} -> ${targetLabel}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export function runPipeline(patternDir: string): string {
  const globalMap = new Map<string, ResourceEntry>();
  const importMap: ImportMap = new Map();
  const stackGroups = new Map<string, ResourceEntry[]>();
  const allRelationships: Relationship[] = [];
  const stackTemplates: Array<{ template: CfTemplate; entries: ResourceEntry[] }> = [];

  for (const filePath of findCfFiles(patternDir)) {
    const template = loadTemplate(filePath);
    const stackName = deriveStackName(template);
    const entries = extractResources(template, stackName, globalMap);
    stackGroups.set(stackName, entries);
    stackTemplates.push({ template, entries });
  }

  for (const { template, entries } of stackTemplates) {
    const paramNames = new Set(Object.keys(template.Parameters ?? {}));
    for (const entry of entries) {
      const stackResourceIds = new Set(stackGroups.get(entry.stackName)!.map((e) => e.logicalId));
      allRelationships.push(...extractRelationships(entry, stackResourceIds, paramNames, globalMap, importMap));
    }
  }

  return formatOutput(stackGroups, allRelationships, globalMap, importMap);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: npx ts-node scripts/cloudformation-entity-relation-parser.ts <pattern-dir>');
    process.exit(1);
  }

  const patternDir = path.resolve(arg);
  if (!fs.existsSync(patternDir)) {
    console.error(`Directory not found: ${patternDir}`);
    process.exit(1);
  }

  const cfFiles = findCfFiles(patternDir);
  if (cfFiles.length === 0) {
    console.error(`No cloud_formation*.yaml files found in ${patternDir}`);
    console.error('Run: cdk synth <StackName> > <file>.yaml first');
    process.exit(1);
  }

  process.stdout.write(runPipeline(patternDir));
}

if (require.main === module) {
  main();
}
