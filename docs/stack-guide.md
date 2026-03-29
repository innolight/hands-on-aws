# Stack Guide

How to write CDK stacks for patterns in this repo.
Primary reference: [`patterns/rds/rds-redshift-zero-etl/`](../patterns/rds/rds-redshift-zero-etl/).

---

## Principles

These patterns exist to explore AWS for real-world, production-ready applications. Every stack should teach the reader how to operate it successfully.

1. **Comment decisions, not syntax** Explain best practices, alternatives, and trade-offs for as many decisions as possible.
2. **Make configuration explicit** Spell out all relevant configuration knobs — even when using the default value — if understanding them matters for production. Explain gotchas and trade-offs of each knob.
3. **Group configuration by theme** Within a construct, order properties by theme: security & IAM, networking, compute/resource sizing, observability, reliability. This makes it easy to audit one concern at a time.
4. **Keep comments concise** Short phrases over long sentences. If three words suffice, don't write ten.

---

## Section Order

| #   | Topic                                                             |
| --- | ----------------------------------------------------------------- |
| 1   | [Pattern Structure](#1-pattern-structure)                         |
| 2   | [Stack Naming](#2-stack-naming)                                   |
| 3   | [Commenting Conventions](#3-commenting-conventions)               |
| 4   | [Stack Splitting](#4-stack-splitting)                             |
| 5   | [Cross-Stack Resource Sharing](#5-cross-stack-resource-sharing)   |
| 6   | [Removal Policies](#6-removal-policies)                           |
| 7   | [Stack Outputs](#7-stack-outputs)                                 |
| 8   | [L1 vs L2 Constructs](#8-l1-vs-l2-constructs)                     |
| 9   | [Capturing CloudFormation YAML](#9-capturing-cloudformation-yaml) |

---

## 1. Pattern Structure

Each pattern lives in `patterns/<pattern-name>/` and typically contains:

| File                                                   | Purpose                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `stack.ts`                                             | CDK Stack class (single-stack patterns)                                         |
| `stack_<role>.ts`                                      | One file per stack, named after its role (multi-stack patterns)                 |
| `stack_step*.ts`                                       | Ordered deployment across regions (multi-step patterns)                         |
| `stack.test.ts`                                        | Unit test — assert resource existence and critical properties only              |
| `README.md`                                            | Pattern-specific notes (see [pattern-readme-guide.md](pattern-readme-guide.md)) |
| `cloud_formation.yaml` / `cloud_formation_<role>.yaml` | Synthesized CloudFormation output                                               |
| `demo_server.ts`                                       | Optional Express server to demo the pattern                                     |

---

## 2. Stack Naming

Each stack file exports a `const <camelCase>StackName = '<PascalCase>'` string used as both the CDK construct id and the CloudFormation stack name.

### Single-stack patterns

The constant name matches the file. The value is PascalCase with no separators:

```typescript
// stack.ts
export const rdsAuroraProvisionedStackName = 'RdsAuroraProvisioned';
```

### Multi-stack patterns

Use a shared `PatternName-Role` prefix with a hyphen separator so all stacks group together alphabetically in the AWS Console:

```typescript
// stack_rds.ts
export const rdsRedshiftZeroEtlRdsStackName = 'RdsRedshiftZeroEtl-Rds';

// stack_redshift_provisioned.ts
export const rdsRedshiftProvisionedStackName = 'RdsRedshiftZeroEtl-RedshiftProvisioned';

// stack_integration.ts
export const rdsRedshiftIntegrationStackName = 'RdsRedshiftZeroEtl-Integration';
```

The constant is imported by consumers (demo servers, other stacks) for runtime output discovery:

```typescript
import { rdsRedshiftZeroEtlRdsStackName } from './stack_rds';
const outputs = await getStackOutputs(rdsRedshiftZeroEtlRdsStackName);
```

---

## 3. Commenting Conventions

Comments are educational, not decorative. Each comment should teach something a reader couldn't immediately infer from the code.

### Class-level comment

One line describing the data flow:

```typescript
// upload image to S3 -> Lambda -> Rekognition detectLabels -> DynamoDB
```

For complex patterns, use ASCII flow diagrams:

```typescript
// Demo Server -> SSM tunnel -> Bastion (eu-central-1) -> Aurora Global Primary Writer
//                                                        <-> storage-level replication (<1s)
//                                                 Aurora Global Secondary (us-east-1)
```

### Construct comments — explain _why_, not _what_

```typescript
// PAY_PER_REQUEST avoids provisioned capacity costs for sporadic workloads
billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,

// r6g.large is the smallest supported option for Aurora Global (~$0.28/hr).
// Burstable (t-class) instances are not supported for global databases.
instanceType: ec2.InstanceType.of(ec2.InstanceClass.R6G, ec2.InstanceSize.LARGE),
```

### Alternative comments

State a real alternative and the tradeoff, when one exists:

```typescript
// Alternative: EventBridge — more flexible fan-out, but adds latency
// (~seconds vs ~milliseconds) for a single-consumer case
```

### Production caveats

Flag non-production settings inline with `// !!`:

```typescript
// !! Change the following in production.
removalPolicy: cdk.RemovalPolicy.DESTROY,
deletionProtection: false,
```

### IAM comments

Explain _why_ a permission is needed, especially non-obvious ones:

```typescript
// Rekognition accesses S3 directly using the Lambda role — role needs GetObject
// Rekognition does not support resource-level permissions, so '*' is required

// DescribeStream and ListShards are needed for DMS to verify the stream
// before starting the task.
dmsKinesisRole.addToPolicy(
  new iam.PolicyStatement({
    actions: ['kinesis:DescribeStream', 'kinesis:ListShards'],
    resources: [this.stream.streamArn],
  }),
);
```

### Don't comment

Self-evident code (`// create bucket`, `// outputs`).

---

## 4. Stack Splitting

Split stacks along lifecycle and ownership boundaries. Group resources that change at the same frequency and share the same blast radius.

**Blast radius test:** "If I redeploy this stack, what's the blast radius?" If the answer includes resources unrelated to the change, split.

### Typical layers

| Layer                     | Examples                                        | Change frequency |
| ------------------------- | ----------------------------------------------- | ---------------- |
| **Shared infrastructure** | VPC, ECS cluster, Cloud Map namespace           | Rarely           |
| **Platform/datastore**    | RDS, OpenSearch, ElastiCache, Redshift          | Occasionally     |
| **Compute**               | Lambda, Fargate services, task definitions      | Every deploy     |
| **Networking**            | API Gateway, VPC Link, routes, SG ingress rules | Wired up last    |

### When to use a single stack

When components are tightly coupled and share the same lifecycle. Example: Aurora cluster + parameter group + custom endpoints all in one stack (`rds-aurora-provisioned/stack.ts`).

### When to split

- **Different failure modes:** RDS source, DMS replication, Lambda consumer each fail independently (`rds-cdc-streaming/` — 3 stacks).
- **Blast radius isolation:** Keep the integration resource separate so failures don't roll back the Redshift cluster (`rds-redshift-zero-etl/stack_integration.ts`).
- **Circular dependency avoidance:** RDS Proxy in a separate stack to avoid L2 auto-wiring SG mutations (`rds-read-replicas/stack_proxy.ts`).

### Datastore stacks

Datastore stacks must not assume how they will be consumed. They expose security groups and resource identifiers as `public readonly` properties. Consumer stacks wire up access separately.

Deploy order: shared infra -> datastore -> consumer/app stacks.

---

## 5. Cross-Stack Resource Sharing

### Pass concrete objects via props interfaces

```typescript
interface RdsCdcStreamingDmsStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  rdsInstance: rds.DatabaseInstance;
  rdsSecret: secretsmanager.ISecret;
  rdsSG: ec2.SecurityGroup;
}
```

### Export resources as `public readonly`

```typescript
export class RdsCdcStreamingRdsStack extends cdk.Stack {
  public readonly instance: rds.DatabaseInstance;
  public readonly secret: secretsmanager.ISecret;
  public readonly dbSG: ec2.SecurityGroup;
  // ...
}
```

### Use L1 `CfnSecurityGroupIngress` for cross-stack SG rules

Avoids mutating a security group owned by another stack (the cross-stack mutation anti-pattern that creates implicit deploy-order dependencies):

```typescript
// L1 ingress rule avoids mutating the bastionSG from this stack
new ec2.CfnSecurityGroupIngress(this, 'BastionToDb', {
  groupId: dbSG.securityGroupId,
  ipProtocol: 'tcp',
  fromPort: 5432,
  toPort: 5432,
  sourceSecurityGroupId: props.bastionSG.securityGroupId,
  description: 'PostgreSQL from bastion (SSM tunnel)',
});
```

### Cross-region references

CDK stack references don't work across regions. Use exported string constants instead:

```typescript
// stack_primary.ts
export const globalClusterIdentifier = 'aurora-global-demo';

// stack_secondary.ts (different region)
import { globalClusterIdentifier } from './stack_primary';
```

---

## 6. Removal Policies

All demo stacks use `removalPolicy: DESTROY` and `autoDeleteObjects: true` for easy cleanup. Always flag these as non-production settings:

```typescript
// !! Change the following in production.
removalPolicy: cdk.RemovalPolicy.DESTROY,
deletionProtection: false,
```

For L1 constructs that don't accept `removalPolicy` in the constructor, use `applyRemovalPolicy`:

```typescript
cluster.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
```

Apply consistently to all stateful resources: databases, KMS keys, DynamoDB tables, SQS queues, Kinesis streams.

---

## 7. Stack Outputs

`CfnOutput` is the mechanism for passing resource info to demo servers via `getStackOutputs(stackName)` from `utils/stackoutput.ts`.

### What to output

- **Database endpoints:** writer, reader, custom endpoints
- **Ports:** especially when non-default
- **Secret ARNs:** for secure credential retrieval at runtime
- **Database/resource names:** so demo servers don't hardcode them
- **Proxy endpoints:** when fronting the database with RDS Proxy

```typescript
new cdk.CfnOutput(this, 'WriterEndpoint', { value: cluster.clusterEndpoint.hostname });
new cdk.CfnOutput(this, 'ReaderEndpoint', { value: cluster.clusterReadEndpoint.hostname });
new cdk.CfnOutput(this, 'SecretArn', { value: cluster.secret!.secretArn });
new cdk.CfnOutput(this, 'DatabaseName', { value: 'demo' });
```

---

## 8. L1 vs L2 Constructs

Prefer L2 constructs when available. Use L1 when L2 has limitations — and always document why inline.

### When to use L1

| Scenario                             | Example                              | Reason                                                                                     |
| ------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------ |
| L2 forces unwanted properties        | Aurora Global secondary cluster      | L2 `DatabaseCluster` always generates `masterUsername`; secondary clusters must not set it |
| L2 auto-wires SG rules across stacks | RDS Proxy                            | L2 injects `CfnSecurityGroupIngress` into the RDS stack, creating circular deps            |
| L2 doesn't exist for the resource    | DMS, Redshift, Multi-AZ RDS clusters | Only L1 `CfnReplicationInstance`, `CfnCluster`, `CfnDBCluster` available                   |
| Cross-stack SG ownership             | All patterns                         | L1 `CfnSecurityGroupIngress` keeps ownership in the consuming stack                        |

Always comment why you chose L1:

```typescript
// Why all L1 constructs?
// CDK's L2 DatabaseCluster always generates masterUsername + masterUserPassword.
// Secondary clusters must NOT set these — they are inherited from the primary.
// Until fixed upstream (https://github.com/aws/aws-cdk/issues/29880), use CfnDBCluster.
```

### Grant methods for IAM

Prefer L2 grant methods over manual policy statements when the L2 construct supports them:

```typescript
props.primary.secret!.grantRead(proxyRole);
dedupTable.grantReadWriteData(processor);
this.stream.grantWrite(dmsKinesisRole);
```

Add manual policy statements only for permissions that grant methods don't cover, and comment why:

```typescript
// DescribeStream and ListShards are needed for DMS to verify the stream
// before starting the task — not covered by grantWrite.
dmsKinesisRole.addToPolicy(
  new iam.PolicyStatement({
    actions: ['kinesis:DescribeStream', 'kinesis:ListShards'],
    resources: [this.stream.streamArn],
  }),
);
```

---

## 9. Capturing CloudFormation YAML

```bash
cdk synth RdsRedshiftZeroEtl-Rds --output .temp > patterns/rds/rds-redshift-zero-etl/cloud_formation_rds.yaml
```

Rules:

- Use `cdk` directly, not `npx cdk`
- **Never** append `2>&1` — CDK writes logs and warnings to stderr; redirecting stderr into stdout corrupts the YAML
- stdout-only redirection (`>`) is always correct
