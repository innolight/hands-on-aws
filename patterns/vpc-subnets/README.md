# VPC Subnets (3-Tier)

## Pattern Description

- [Amazon VPC](https://docs.aws.amazon.com/vpc/latest/userguide/what-is-amazon-vpc.html) with a 3-tier subnet layout across 3 [Availability Zones](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/using-regions-availability-zones.html)
- **Public** subnets — route `0.0.0.0/0` to an [Internet Gateway](https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Internet_Gateway.html); for load balancers, NAT Gateways, Bastion hosts
- **Private** subnets — route `0.0.0.0/0` to a [NAT Gateway](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html) (outbound-only); for app servers, Lambda, ECS tasks
- **Isolated** subnets — no internet route in either direction; for databases and caches
- NAT Gateway count controlled via `-c natGateways=N` (default: `0`)
- NAT provider type controlled via `natProviderType` prop: `'self-managed'` (default, EC2 NAT instance) or `'aws-managed'` (NAT Gateway)

### AWS containment hierarchy

```
AWS Account
└── Region (e.g. eu-central-1)
    │
    ├── VPC (spans the entire region, e.g. 10.0.0.0/16)
    │   │
    │   ├── Availability Zone A (eu-central-1a)
    │   │   ├── Public Subnet    10.0.0.0/20
    │   │   ├── Private Subnet   10.0.64.0/20
    │   │   └── Isolated Subnet  10.0.128.0/20
    │   │
    │   ├── Availability Zone B (eu-central-1b)
    │   │   ├── Public Subnet    10.0.16.0/20
    │   │   ├── Private Subnet   10.0.80.0/20
    │   │   └── Isolated Subnet  10.0.144.0/20
    │   │
    │   └── Availability Zone C (eu-central-1c)
    │       ├── Public Subnet    10.0.32.0/20
    │       ├── Private Subnet   10.0.96.0/20
    │       └── Isolated Subnet  10.0.160.0/20
    │
    └── (another VPC — e.g. for a different environment)

Region (e.g. us-east-1)         ← a second region; VPCs don't span regions
└── VPC ...
```

Notes:
- `/20` subnets = 4,096 IPs each. AWS reserves 5 IPs per subnet, leaving 4,091 usable.

| Boundary | Spans |
|---|---|
| AWS Account | Multiple regions |
| Region | Multiple AZs (usually 3+); VPCs live here |
| VPC | All AZs in its region; one CIDR block |
| Subnet | Exactly **one** AZ; one CIDR sub-block of the VPC |
| Resource (EC2, RDS…) | Exactly one subnet → one AZ |

What crosses boundaries:
- A VPC spans AZs, but subnets don't — that's why you create one subnet per tier per AZ
- [Security Groups](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-security-groups.html) are VPC-scoped (span AZs); [NACLs](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-network-acls.html) are subnet-scoped
- [VPC Peering](https://docs.aws.amazon.com/vpc/latest/peering/what-is-vpc-peering.html) / [Transit Gateway](https://docs.aws.amazon.com/vpc/latest/tgw/what-is-transit-gateway.html) connect VPCs (same or different accounts/regions)
- **Route Tables are subnet-scoped** — that's what makes Public/Private/Isolated different from each other, not the subnet type itself


## Cost

Region: `eu-central-1`. Assumes 24/7 idle.

| Resource | Idle (`natGateways=0`) | `natGateways=1` aws-managed | `natGateways=1` self-managed | Cost driver |
|---|---|---|---|---|
| VPC | $0 | $0 | $0 | Free |
| Internet Gateway | $0 | $0 | $0 | Free (data transfer charged separately) |
| NAT Gateway | $0 | ~$35/mo | $0 | Hourly fee ($0.048/hr each) |
| NAT Instance (t4g.nano) | $0 | $0 | ~$3.40/mo | EC2 instance-hours |
| Data through NAT | $0 | $0.048/GB | $0 (EC2 egress rates apply) | Per-GB processed |

Dominant cost when `natGateways>0`:
- `aws-managed`: NAT Gateway hourly fee (~$35/gateway/month)
- `self-managed`: EC2 t4g.nano instance (~$3.40/month, ~90% cheaper)

**Alternative to NAT Gateway:** Add [VPC Gateway Endpoints](https://docs.aws.amazon.com/vpc/latest/userguide/vpce-gateway.html) (free) for S3 and DynamoDB, and [Interface Endpoints](https://docs.aws.amazon.com/vpc/latest/userguide/vpce-interface.html) (~$7/mo each) for other AWS services — eliminating the need for a NAT Gateway in many workloads.

## Notes

- **NAT Instance vs NAT Gateway**: The default `natProviderType='self-managed'` uses a t4g.nano EC2 instance running Amazon Linux 2023; CDK injects user data that installs iptables and configures MASQUERADE NAT. Cost: ~$3.40/mo vs ~$35/mo (~90% cheaper). Trade-offs: single point of failure per instance (no built-in HA), max bandwidth ~5 Gbps on t4g.nano (NAT GW scales to 100 Gbps), requires OS patching. For production, use `natProviderType='aws-managed'`.
- **NAT Gateway per AZ**: `natGateways=1` places one NAT GW/instance in the first AZ. Traffic from AZ-b and AZ-c crosses AZ boundaries to reach it (charged at $0.01/GB for aws-managed). `natGateways=3` places one per AZ, eliminating cross-AZ NAT costs — preferred for production.
- **Private subnets with `natGateways=0`**: CDK creates the subnets but adds no default route. They behave identically to isolated subnets. This is intentional — the pattern demonstrates the full 3-tier layout regardless of NAT configuration.
- **Security Groups vs NACLs**: Security Groups (stateful, instance-level) are the primary access control. NACLs (stateless, subnet-level) are a blunt backstop — use them only to block ranges of IPs across an entire subnet.
- **VPC DNS**: CDK enables `enableDnsHostnames` and `enableDnsSupport` by default — required for VPC Endpoints and Route 53 private hosted zones.
- **CIDR sizing**: `/20` per subnet leaves room for ~4,000 resources per tier per AZ. Size down to `/24` (251 usable) for tightly scoped environments.

## Commands

### Deploy

```bash
# No NAT ($0 idle) — use VPC Endpoints for AWS service access
npx cdk deploy VpcSubnets

# NAT Instance on t4g.nano (~$3.40/mo) — default self-managed provider
npx cdk deploy VpcSubnets -c natGateways=1

# Managed NAT Gateway (~$35/mo) — fully managed, no instance ops
npx cdk deploy VpcSubnets -c natGateways=1  # then pass natProviderType='aws-managed' via props in bin/cdk.ts

# One NAT Gateway per AZ (~$105/mo) — production HA (aws-managed)
npx cdk deploy VpcSubnets -c natGateways=3  # set natProviderType='aws-managed' in bin/cdk.ts
```

### Inspect

```bash
# Show all stack outputs (VPC ID, subnet IDs, AZs)
aws cloudformation describe-stacks --stack-name VpcSubnets \
  --query "Stacks[0].Outputs" --output table

# List all subnets in the VPC
VPC_ID=$(aws cloudformation describe-stacks --stack-name VpcSubnets \
  --query "Stacks[0].Outputs[?OutputKey=='VpcId'].OutputValue" --output text)

aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" \
  --query "Subnets[*].{AZ:AvailabilityZone,CIDR:CidrBlock,Id:SubnetId,Public:MapPublicIpOnLaunch}" \
  --output table
```

### Destroy

```bash
npx cdk destroy VpcSubnets
```

### Capture CloudFormation YAML

```bash
npx cdk synth -c natGateways=1 VpcSubnets > patterns/vpc-subnets/cloud_formation.yaml
```
