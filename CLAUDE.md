# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
pnpm run test -- --testPathPattern=cdk.test
```

Run the demo server for a pattern (e.g., s3-events-notification):
```bash
AWS_REGION=eu-central-1 npx ts-node patterns/s3-events-notification/demo_server.ts
```

## Architecture

This is an AWS CDK (TypeScript) monorepo for hands-on learning of AWS architectural patterns.

**Entry point:** `bin/cdk.ts` — instantiates all CDK stacks and registers them with the CDK app. Each new pattern stack must be imported and instantiated here.

**Pattern structure:** Each pattern lives in `patterns/<pattern-name>/` and typically contains:
- `stack.ts` (or `stack_step*.ts` for multi-step patterns) — the CDK Stack class
- `README.md` — pattern-specific notes
- `cloud_formation.yaml` (or `cloud_formation_step*.yaml`) — synthesized CloudFormation output
- Optionally: `demo_server.ts` (Express server to demo the pattern) and `demo_requests.http`

**Utils:** `utils/stackoutput.ts` exports `getStackOutputs(stackName)`, which uses the CloudFormation SDK to retrieve stack outputs by name. Demo servers use this to discover resource names/ARNs at runtime without hardcoding them.

**Multi-step patterns:** Some patterns require deploying stacks in a specific order across regions (e.g., `s3-cross-region-replication` deploys a destination bucket to `eu-west-1` first, then a source bucket to the default region).

**README.md structure** — each pattern README should follow this order:
1. **Pattern Description** — bullet list of components and data flow; link each AWS service/concept to its official docs
2. **Cost** — table with columns: Resource | Idle | ~N unit/month | Cost driver; include region and workload assumption in the header; state the dominant cost driver
3. **Notes** — non-obvious decisions, production caveats, alternatives considered
4. **Commands to play with stack** — deploy, interact (upload/query/etc.), observe (logs), destroy, and `cdk synth` to capture CloudFormation yaml

**stack.ts commenting conventions** — comments are educational, not decorative. Each comment should teach something a reader couldn't immediately infer from the code:

- **Class-level comment**: one line describing the data flow, e.g. `// upload image to S3 → Lambda → Rekognition detectLabels → DynamoDB`
- **Construct comments**: explain *why* a config option was chosen, not what it does. Examples:
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

# Behavioural Guideline

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.