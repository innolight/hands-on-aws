Guidance to AI Agents (Claude code, Gemini Cli, Codex) when working with code in this repository.

## Behavioural guidelines

1. Think Before Coding: Explicitly state assumptions, surface tradeoffs, and ask questions rather than guessing or hiding confusion.
2. Simplicity First: Write the minimum code needed to solve the problem. Avoid unrequested features, premature abstractions, and speculative flexibility.
3. Surgical Changes: Modify only what is strictly required. Match the existing style, avoid unrelated refactoring, but clean up any dead code your changes create.
4. Goal-Driven Execution: Define clear, verifiable success criteria (like tests) for every task, and outline step-by-step plans to verify progress.

## Commands

```bash
pnpm run build        # compile TypeScript to JS
pnpm run watch        # watch and compile
pnpm run test         # run Jest tests
npx cdk bootstrap     # one-time setup per AWS account/region
npx cdk ls            # list all stacks
npx cdk synth         # emit synthesized CloudFormation template
npx cdk diff          # compare deployed stack with current state
npx cdk deploy        # deploy stack to AWS account/region
npx cdk destroy       # tear down a deployed stack
```

Run a single test file:

```bash
npx jest patterns/<pattern-name>/stack.test.ts
```

Note: `pnpm run test -- --testPathPattern=<pattern>` does not work — pnpm escapes the `=` in `--testPathPattern\=`, causing Jest to find zero matches even when the file exists. Use `npx jest <path>` to target a specific file.

Run the demo server for a pattern (e.g., s3-events-notification):

```bash
AWS_REGION=eu-central-1 npx ts-node patterns/s3-events-notification/demo_server.ts
```

## Architecture

This is an AWS CDK (TypeScript) monorepo for hands-on learning of AWS architectural patterns.

**Entry point:** `bin/cdk.ts` — instantiates all CDK stacks and registers them with the CDK app. Each new pattern stack must be imported and instantiated here.

**Pattern structure:** Each pattern lives in `patterns/<pattern-name>/` and typically contains:

- `stack.ts` — the CDK Stack class (simple single-stack patterns)
- `stack_<role>.ts` — for multi-stack patterns, one file per stack named after its role (e.g., `stack_ecs_cluster.ts`, `stack_compute.ts`, `stack_networking.ts`)
- `stack_step*.ts` — for multi-step patterns requiring ordered deployment across regions
- `stack.test.ts` unit test for stack — keep tests minimal: assert resource existence and the most critical properties per resource type. Avoid exhaustive property coverage which harms readability; that belongs in integration tests.
- `README.md` — pattern-specific notes
- `cloud_formation.yaml` (or `cloud_formation_<role>.yaml`) — synthesized CloudFormation output
- Optionally: `demo_server.ts` (Express server to demo the pattern)

**Stack naming:** Each stack file exports a `const <camelCase>StackName = '<PascalCase>'` string that is used as both the CDK construct id and the CloudFormation stack name. The exported name constant should match the file: `stack_compute.ts` → `ecsFargateComputeStackName = 'EcsFargateComputeStack'`. For multi-stack patterns, use a shared `PatternName-Role` prefix with a hyphen separator so all stacks group together in the AWS Console: `stack_rds.ts` → `rdsRedshiftZeroEtlRdsStackName = 'RdsRedshiftZeroEtl-Rds'`.

**Utils:** `utils/stackoutput.ts` exports `getStackOutputs(stackName)`, which uses the CloudFormation SDK to retrieve stack outputs by name. Demo servers use this to discover resource names/ARNs at runtime without hardcoding them.

**Multi-step patterns:** Some patterns require deploying stacks in a specific order across regions (e.g., `s3-cross-region-replication` deploys a destination bucket to `eu-west-1` first, then a source bucket to the default region).

**README.md structure** — see [docs/pattern-readme-guide.md](docs/pattern-readme-guide.md) for the full guide. In brief: Title → Summary → Architecture diagram → Service links → Cost → Notes → Commands → Entity Relationship Diagram.

**Capturing CloudFormation yaml:** use `cdk synth <StackName> --output .temp > cloud_formation.yaml` — NEVER append `2>&1` and AVOID npx cdk, use cdk directly. CDK prints logs and warnings to stderr; redirecting stderr into stdout with `2>&1` mixes them into the file and produces invalid YAML. stdout-only redirection (`>`) is always correct here.

**stack.ts commenting conventions** — comments are educational, not decorative. Each comment should teach something a reader couldn't immediately infer from the code:

- **Class-level comment**: one line describing the data flow, e.g. `// upload image to S3 → Lambda → Rekognition detectLabels → DynamoDB`
- **Construct comments**: explain _why_ a config option was chosen, not what it does. Examples:
  - `// PAY_PER_REQUEST avoids provisioned capacity costs for sporadic workloads`
  - `// externalModules: ['@aws-sdk/*'] — Lambda Node 20 runtime ships SDK v3; bundling it adds size with no benefit`
- **Alternative comments**: when a real alternative exists and the tradeoff matters, state it. Example:
  - `// Alternative: EventBridge — more flexible fan-out, but adds latency (~seconds vs ~milliseconds) for a single-consumer case`
- **Production caveat comments**: flag non-production settings inline with `// !! Change the following in production.`
- **IAM comments**: explain why a permission is needed, especially non-obvious ones. Example:
  - `// Rekognition accesses S3 directly using the Lambda role — role needs GetObject`
  - `// Rekognition does not support resource-level permissions, so '*' is required`
- **Don't comment** self-evident code (e.g. `// create bucket`, `// outputs`).

**Stack conventions:**

- Stacks use `removalPolicy: DESTROY` and `autoDeleteObjects: true` for easy cleanup — note these as non-production settings when adding new patterns
- Stack outputs (`CfnOutput`) are the mechanism for passing resource info to demo servers via `getStackOutputs`
- Default region is `eu-central-1` (set via `CDK_DEFAULT_REGION`; CDK resolves account/region automatically from the AWS CLI profile)
- Split stacks along lifecycle and ownership boundaries. Group resources that change at the same frequency and share the same blast radius. Typical layers:
  - **Shared infrastructure** (VPC, ECS cluster, Cloud Map namespace) — deployed once, almost never updated, consumed by multiple stacks via `public readonly` exports
  - **Platform/datastore** (OpenSearch domain, ElastiCache cluster, ECR repository) — updated occasionally, exports SGs and identifiers for consumers
  - **Compute** (task definitions, Fargate services, Lambda functions, auto-scaling) — changes on every service deploy; exports Cloud Map service and task SG for the networking layer
  - **Networking** (API Gateway, VPC Link, routes, SG ingress rules) — wired up last; owns the ingress rule via `CfnSecurityGroupIngress` so the compute stack stays self-contained

  A stack should not mix slow-changing shared infrastructure with fast-changing per-service resources. When in doubt, ask: "If I redeploy this stack, what's the blast radius?" If the answer includes resources unrelated to the change, split.

- Datastore stacks (e.g., OpenSearch, ElastiCache) must not assume how they will be consumed. They expose security groups and resource identifiers as `public readonly` properties. Consumer/app stacks wire up access (SG ingress, IAM, etc.) separately using L1 `CfnSecurityGroupIngress` to avoid cross-stack mutation. Deploy order: shared infra → datastore → consumer app stacks.
