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

**Stack conventions** — see [docs/stack-guide.md](docs/stack-guide.md) for the full guide on writing CDK stacks. In brief: export a `StackName` constant per file, split stacks by lifecycle, use `CfnSecurityGroupIngress` for cross-stack SG rules, flag demo-only settings with `// !!`.

**Utils:** `utils/stackoutput.ts` exports `getStackOutputs(stackName)`, which uses the CloudFormation SDK to retrieve stack outputs by name. Demo servers use this to discover resource names/ARNs at runtime without hardcoding them.

**Multi-step patterns:** Some patterns require deploying stacks in a specific order across regions (e.g., `s3-cross-region-replication` deploys a destination bucket to `eu-west-1` first, then a source bucket to the default region).

**README.md structure** — see [docs/pattern-readme-guide.md](docs/pattern-readme-guide.md) for the full guide. In brief: Title → Summary → Architecture diagram → Service links → Cost → Notes → Commands → Entity Relationship Diagram.

**Default region** is `eu-central-1` (set via `CDK_DEFAULT_REGION`; CDK resolves account/region automatically from the AWS CLI profile).
