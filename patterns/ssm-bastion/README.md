# SSM Bastion

## Pattern Description

- EC2 bastion accessible exclusively via [SSM Session Manager](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-sessions-start.html) — no SSH, no inbound security group rules
- Placed in a public subnet so the SSM agent reaches AWS endpoints over the internet without a NAT gateway
- Designed for reuse: accepts a `vpc` prop from another stack (e.g. `vpc-subnets`) and exposes `bastion` and `bastionSG` for downstream stacks to reference
- Common use case: SSM port forwarding to privately-networked resources (ElastiCache, RDS) — the target stack allows ingress only from `bastionSG`

## Cost

Region: `eu-central-1`. Assumes 24/7 idle.

| Resource | Idle | ~1 unit/mo | Cost driver |
|---|---|---|---|
| EC2 t4g.nano | ~$3/mo | — | Instance uptime |
| SSM Session Manager | $0 | — | Free for EC2 instances |

Dominant cost: instance uptime (~$3/mo). Stop the instance when not in use.

## Notes

- No key pair attached — SSH is intentionally disabled. All access is via SSM.
- `AmazonSSMManagedInstanceCore` is the minimum managed policy for SSM; it allows the agent to register, receive commands, and stream session data.
- The bastion exposes no ports. The downstream stack (e.g. ElastiCache) opens port 6379 from `bastionSG` — traffic flows through the SSM tunnel, not a VPN.

## Commands

### Deploy

```bash
# Deploy VpcSubnets first (shared dependency), then SsmBastion
npx cdk deploy VpcSubnets SsmBastion
```

### Start SSM Session (interactive shell)

```bash
BASTION=$(aws cloudformation describe-stacks --stack-name SsmBastion \
  --query "Stacks[0].Outputs[?OutputKey=='BastionInstanceId'].OutputValue" --output text)

aws ssm start-session --target "$BASTION"
```

### Port Forwarding Example (to ElastiCache)

```bash
BASTION=$(aws cloudformation describe-stacks --stack-name SsmBastion \
  --query "Stacks[0].Outputs[?OutputKey=='BastionInstanceId'].OutputValue" --output text)
TARGET_HOST=<elasticache-endpoint>

aws ssm start-session \
  --target "$BASTION" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "{\"host\":[\"$TARGET_HOST\"],\"portNumber\":[\"6379\"],\"localPortNumber\":[\"6379\"]}"
```

### Destroy

```bash
npx cdk destroy SsmBastion
```

### Capture CloudFormation YAML

```bash
npx cdk synth SsmBastion > patterns/ssm-bastion/cloud_formation.yaml
```
