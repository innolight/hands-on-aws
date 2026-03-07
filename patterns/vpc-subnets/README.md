# VPC Subnets (3-Tier)

## Pattern Description

- [Amazon VPC](https://docs.aws.amazon.com/vpc/latest/userguide/what-is-amazon-vpc.html) with a 3-tier subnet layout across 3 [Availability Zones](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/using-regions-availability-zones.html)
- **Public** subnets — route `0.0.0.0/0` to an [Internet Gateway](https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Internet_Gateway.html); for load balancers, NAT Gateways, Bastion hosts
- **Private** subnets — route `0.0.0.0/0` to a [NAT Gateway](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html) (outbound-only); for app servers, Lambda, ECS tasks
- **Isolated** subnets — no internet route in either direction; for databases and caches
- NAT Gateway count controlled via `-c natGateways=N` (default: `0`)

### Subnet CIDR layout (`/16` VPC, `/20` subnets = 4,096 IPs each)

```
VPC: 10.0.0.0/16
├── Public AZ-a    10.0.0.0/20
├── Public AZ-b    10.0.16.0/20
├── Public AZ-c    10.0.32.0/20
├── Private AZ-a   10.0.64.0/20
├── Private AZ-b   10.0.80.0/20
├── Private AZ-c   10.0.96.0/20
├── Isolated AZ-a  10.0.128.0/20
├── Isolated AZ-b  10.0.144.0/20
└── Isolated AZ-c  10.0.160.0/20
```

AWS reserves 5 IPs per subnet, leaving 4,091 usable per subnet.

## Cost

Region: `eu-central-1`. Assumes 24/7 idle.

| Resource | Idle (`natGateways=0`) | Idle (`natGateways=1`) | Idle (`natGateways=3`) | Cost driver |
|---|---|---|---|---|
| VPC | $0 | $0 | $0 | Free |
| Internet Gateway | $0 | $0 | $0 | Free (data transfer charged separately) |
| NAT Gateway | $0 | ~$35/mo | ~$105/mo | Hourly fee ($0.048/hr each) |
| Data through NAT | $0 | $0.048/GB | $0.048/GB | Per-GB processed |

Dominant cost when `natGateways>0`: NAT Gateway hourly fee (~$35/gateway/month).

**Alternative to NAT Gateway:** Add [VPC Gateway Endpoints](https://docs.aws.amazon.com/vpc/latest/userguide/vpce-gateway.html) (free) for S3 and DynamoDB, and [Interface Endpoints](https://docs.aws.amazon.com/vpc/latest/userguide/vpce-interface.html) (~$7/mo each) for other AWS services — eliminating the need for a NAT Gateway in many workloads.

## Notes

- **NAT Gateway per AZ**: `natGateways=1` places one NAT GW in the first AZ. Traffic from AZ-b and AZ-c crosses AZ boundaries to reach it (charged at $0.01/GB). `natGateways=3` places one per AZ, eliminating cross-AZ NAT costs — preferred for production.
- **Private subnets with `natGateways=0`**: CDK creates the subnets but adds no default route. They behave identically to isolated subnets. This is intentional — the pattern demonstrates the full 3-tier layout regardless of NAT configuration.
- **Security Groups vs NACLs**: Security Groups (stateful, instance-level) are the primary access control. NACLs (stateless, subnet-level) are a blunt backstop — use them only to block ranges of IPs across an entire subnet.
- **VPC DNS**: CDK enables `enableDnsHostnames` and `enableDnsSupport` by default — required for VPC Endpoints and Route 53 private hosted zones.
- **CIDR sizing**: `/20` per subnet leaves room for ~4,000 resources per tier per AZ. Size down to `/24` (251 usable) for tightly scoped environments.

## Commands

### Deploy

```bash
# No NAT Gateway ($0 idle) — use VPC Endpoints for AWS service access
npx cdk deploy VpcSubnets

# Single NAT Gateway (~$35/mo) — outbound internet from private subnets
npx cdk deploy VpcSubnets -c natGateways=1

# One NAT Gateway per AZ (~$105/mo) — production HA
npx cdk deploy VpcSubnets -c natGateways=3
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
npx cdk synth VpcSubnets > patterns/vpc-subnets/cloud_formation.yaml
```
