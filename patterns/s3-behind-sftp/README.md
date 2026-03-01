# s3-behind-sftp

## Pattern Description

Exposes an S3 bucket as an SFTP server using [AWS Transfer Family](https://docs.aws.amazon.com/transfer/latest/userguide/what-is-aws-transfer-family.html). Useful for integrating with legacy systems or partners that only speak [SFTP](https://en.wikipedia.org/wiki/SSH_File_Transfer_Protocol) — no EC2 instance or custom server to manage.

- Transfer Family terminates the [SFTP protocol](https://docs.aws.amazon.com/transfer/latest/userguide/create-server-sftp.html) and translates each file operation into S3 API calls transparently
- Two users (`alice`, `bob`) each get an isolated prefix via [LOGICAL home directory mappings](https://docs.aws.amazon.com/transfer/latest/userguide/logical-dir-mappings.html) — each sees `/` but lands in `/bucket/alice` or `/bucket/bob` in S3
- [SERVICE_MANAGED identity provider](https://docs.aws.amazon.com/transfer/latest/userguide/service-managed-users.html) stores SSH public keys inside Transfer Family — no Lambda or Secrets Manager required
- [S3 backend](https://docs.aws.amazon.com/transfer/latest/userguide/create-server-sftp.html#sftp-backing-store) — Transfer Family calls `GetObject`, `PutObject`, `DeleteObject`, and `ListObjectsV2` using the user's IAM role

Data flow: `SFTP client → Transfer Family public endpoint → IAM role → S3 bucket`

## Cost

> eu-central-1, assuming ~10 GB uploaded and downloaded per month.
> **Warning**: Transfer Family charges $0.30/hr per protocol endpoint regardless of connections. Destroy promptly after experimenting.

| Resource | Idle | ~10 GB/month | Cost driver |
|---|---|---|---|
| Transfer Family server | ~$216/mo | ~$216/mo | $0.30/hr per protocol endpoint |
| Data transfer | $0.00 | ~$0.30 | $0.04/GB uploaded or downloaded |
| S3 storage | $0.00 | ~$0.24 | $0.0245/GB stored |
| S3 requests | $0.00 | ~$0.01 | $0.0054/1K PUTs |
| CloudWatch Logs | $0.00 | ~$0.00 | Minimal access log output |

**Dominant cost driver**: the Transfer Family server endpoint at ~$216/month idle. Data transfer and S3 costs are negligible by comparison.

## Notes

- **LOGICAL mapping = virtual chroot**: the S3 bucket name and full path are hidden from the SFTP client. The user only sees the directory tree rooted at their prefix.
- **`s3:ListBucket` on bucket ARN**: IAM does not support prefix-level `ListBucket`. Granting it on a prefix silently returns empty directory listings instead of an error — a common misconfiguration.
- **Server startup latency**: Transfer Family takes ~60 seconds to reach `ONLINE` state after first deploy. The sftp command will fail with a connection error until then.
- **Production consideration**:
  - `endpointType: 'VPC'` with `VpcEndpointDetails` — private traffic, Elastic IPs for stable DNS, security groups for IP allowlisting
  - Custom hostname via Route53 CNAME pointing at the Transfer Family endpoint
  - `identityProviderType: 'AWS_LAMBDA'` with Secrets Manager for password-based auth or LDAP/AD integration
- **Limitations of this implementation**:
  1. **No stable hostname** — the AWS-assigned name changes on every redeploy. Fix: Route53 CNAME or VPC endpoint with Elastic IPs.
  2. **Public endpoint** — no IP allowlisting; traffic goes over the internet. Fix: `endpointType: 'VPC'` with security groups.
  3. **Shared IAM role** — prefix isolation relies solely on the LOGICAL mapping. A misconfigured mapping gives a user access to the entire bucket.
  4. **SSH key rotation requires redeploy** — keys are CloudFormation parameters; updating one means running `cdk deploy` again.
  5. **100-user limit** — `SERVICE_MANAGED` caps at 100 users per server. Fix: `identityProviderType: 'AWS_LAMBDA'` backed by Secrets Manager.

## Commands to play with stack

- **Generate SSH key pairs** (stored in gitignored `secrets/` folder):

```bash
mkdir -p secrets
ssh-keygen -t ed25519 -f secrets/sftp_alice -N ""
ssh-keygen -t ed25519 -f secrets/sftp_bob -N ""
```

- **Deploy**:

```bash
npx cdk deploy S3BehindSftp \
  --parameters SshPublicKeyAlice="$(cat secrets/sftp_alice.pub)" \
  --parameters SshPublicKeyBob="$(cat secrets/sftp_bob.pub)"
```

- **Get endpoint** (from stack outputs):

```bash
aws cloudformation describe-stacks \
  --stack-name S3BehindSftp \
  --query 'Stacks[0].Outputs'
# or: npx ts-node -e "const {getStackOutputs} = require('./utils/stackoutput'); getStackOutputs('S3BehindSftp').then(console.log)"
```

- **Tail access logs**: `aws logs tail /aws/transfer/s3-sftp --follow`


- **Connect as alice, bob  and upload a file**:

```bash
ENDPOINT=<SftpEndpoint from outputs>

sftp -i secrets/sftp_alice alice@$ENDPOINT
sftp -i secrets/sftp_bob bob@$ENDPOINT
# sftp> put somefile.txt
# sftp> ls
# sftp> exit
```

- **Inspect S3 directly**:

```bash
BUCKET=<BucketName from outputs>
aws s3 ls s3://$BUCKET/alice/
aws s3 ls s3://$BUCKET/bob/
```


- **Capture CloudFormation template**: `npx cdk synth S3BehindSftp > patterns/s3-behind-sftp/cloud_formation.yaml`

- **Destroy** (important — $0.30/hr idle): `npx cdk destroy S3BehindSftp`
