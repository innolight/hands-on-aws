# Pattern README Guide

How to write a README.md for a pattern in this repo.
Primary reference: [`patterns/rds/rds-redshift-zero-etl/README.md`](../patterns/rds/rds-redshift-zero-etl/README.md).

---

## Section Order

| #   | Section                               | Required?                 |
| --- | ------------------------------------- | ------------------------- |
| 1   | Title (`# kebab-case-name`)           | Yes                       |
| 2   | 1-2 sentence summary                  | Yes                       |
| 3   | ASCII architecture diagram            | Yes                       |
| 4   | AWS service bullet list               | Yes                       |
| 5   | `**Folder Structure**`                | If multi-stack/multi-file |
| 6   | `## Cost`                             | Yes                       |
| 7   | `## Notes`                            | Yes                       |
| 8   | `## Commands`                         | Yes                       |
| 9   | `## Entity Relation of AWS Resources` | Recommended               |

---

## 1. Title + Summary

`# rds-redshift-zero-etl` — kebab-case matching the directory name, no subtitle.

Immediately follow with 1–2 sentences describing the data flow and the problem it solves. No heading — this is the pattern's elevator pitch.

```
Continuously replicate RDS PostgreSQL databases into Redshift for analytics workload, without any ETL pipeline.
Reduce operational burden and cost of building and operating complex ETL pipelines, and so you can focus on your business logics.
```

---

## 2. Architecture Diagram

Plain fenced code block (no language tag — not mermaid). Use Unicode box-drawing characters: `┌┐└┘│─▶▼►`.

Conventions:

- Show the full data path from the user's machine (or trigger) to the AWS resources
- Label boxes with resource name, instance class, and key config values
- Annotate connections with protocol/mechanism (WAL, CDC, HTTPS, logical replication)
- Include port numbers where relevant

```
RDS PostgreSQL 17.7              Zero-ETL               Redshift Provisioned
(db.t4g.micro, Single-AZ)   (continuous CDC)         (ra3.large, single-node)
┌──────────────────────┐    ┌──────────────┐    ┌────────────────────────────┐
│  Instance            │───▶│ CfnIntegra-  │───▶│  Cluster: zero-etl-        │
│  demo DB             │WAL │ tion (RDS)   │    │  provisioned               │
│  logical_replication │    └──────────────┘    │  case_sensitive_id = true  │
│  = 1                 │                        └────────────────────────────┘
└──────────────────────┘                                    │
        ▲                                          Redshift Data API (IAM)
  SSM tunnel :5432                                          │
  (writes via pg client)                           Analytical queries
```

---

## 3. AWS Service Bullet List

After the diagram, list each AWS service or concept involved, each linked to its official docs page. One bullet per service. Avoid details that will likely to change (.e.g. used instance type)

```markdown
- [Amazon RDS for PostgreSQL](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_PostgreSQL.html) — relational source, writes via SSM tunnel
- [Amazon RDS Zero-ETL integrations](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/zero-etl.html) — streams WAL changes to Redshift continuously
- [Amazon Redshift](https://docs.aws.amazon.com/redshift/latest/mgmt/working-with-clusters.html) — columnar data warehouse
```

---

## 4. Folder Structure (optional)

Include for multi-stack or multi-file patterns. Skip for single-stack patterns where `stack.ts` + `demo_server.ts` are self-evident.

```markdown
**Folder Structure**:

- [`stack_rds.ts`](./stack_rds.ts) — RDS PostgreSQL instance with logical replication enabled
- [`stack_redshift_provisioned.ts`](./stack_redshift_provisioned.ts) — Redshift Provisioned single-node cluster
- [`stack_integration.ts`](./stack_integration.ts) — the `CfnIntegration` resource linking RDS and Redshift
- [`demo_server.ts`](./demo_server.ts) — Express server to seed the RDS database and query Redshift via Data API
- `cloud_formation_*.yaml` — synthesized CloudFormation templates for inspection
```

---

## 5. Cost

Three required parts:

**Part 1 — header line** stating region and workload assumption:

```
Region: eu-central-1. Workload: light demo writes.
```

**Part 2 — table** with fixed columns:

| Resource                         | Idle     | ~Light usage | Cost driver    |
| -------------------------------- | -------- | ------------ | -------------- |
| RDS db.t4g.micro                 | ~$13/mo  | ~$13/mo      | Instance hours |
| Redshift ra3.large (single-node) | ~$468/mo | ~$468/mo     | Instance hours |

Column 3 header adapts to the pattern's natural unit: `~1K images/mo`, `~100 writes/s`, `~Light usage`.

**Part 3 — dominant cost note** after the table. State the main cost driver and any action the reader should take:

```
**Dominant cost driver**: Redshift ra3.large at $0.649/hr. **Run `cdk destroy` immediately after experimenting.**
```

**Cost warnings** — for patterns with >$50/mo idle cost, add a prominent warning. Two styles in use:

Blockquote style (rds-readable-standbys):

```markdown
> **Cost warning**: This pattern uses db.m5d.large instances (~$117/mo idle). Deploy, run the demo, and destroy immediately.
```

Inline bold style (rds-redshift-zero-etl): fold the warning into the dominant cost note paragraph.

---

## 6. Notes

Covers non-obvious decisions, production caveats, known failure modes, and comparison tables.

**Two acceptable styles:**

**Style A — Numbered subsections** (use for complex patterns with 3+ distinct topics):

```markdown
### 1. Configuration Requirements

- **Mandatory RDS Parameters**: ...
- **Mandatory Redshift Parameter**: ...

### 2. Features & Behavior

- **DML Replication**: Near real-time sync for INSERT, UPDATE, DELETE.
- **Latency**: Sub-minute; typical sync in under 15 seconds.

### 3. Failure Modes & Production Operations

- **Missing Primary Keys**: Tables without a PRIMARY KEY are silently skipped (Event 0004).
```

**Style B — Bold-lead paragraphs** (use for simpler patterns):

```markdown
**Async replication means stale reads.**

Replicas lag behind the writer by milliseconds to seconds. Applications that write and
immediately read back must either read from the writer or tolerate stale data.

**Promoting a replica is a manual operation.**

...
```

**What to cover in Notes** (not every pattern needs all of these):

- Configuration requirements and prerequisites not obvious from the code
- Common misconceptions about the service (e.g., "Multi-AZ standby is NOT readable")
- Failure modes: what might breaks, how to monitor, what are mitigation strategies
- Production caveats: settings that are demo-only vs production-safe
- Comparison tables for key architectural decision (RDS Proxy vs Route 53, Switchover vs Failover)
- Alternatives considered: why this approach over others
- Day-2 operations: monitoring, scaling triggers, maintenance windows

---

## 7. Commands

Section heading: `## Commands` or `## Commands to play with stack`.

Canonical subsection order:

```markdown
**Deploy** — cdk deploy, stacks in dependency order
**Set up SSM tunnel** — only for VPC-bound patterns; fetch outputs, start session
**Start demo server** — AWS_REGION=... npx ts-node patterns/.../demo_server.ts
**Interact** — curl examples with inline comments
**Observe** — (optional) logs, status checks, CloudWatch metrics
**Destroy** — cdk destroy, reverse dependency order
**Capture CloudFormation YAML** — cdk synth per stack
```

Use `### SubSection` headings or bold `**SubSection**` — either is fine; be consistent within a README.

Conventions:

- All commands in fenced `bash` code blocks
- **Self-contained**: fetch stack outputs inline, never reference a variable set in a previous step
- Inline `# comments` explain what each command does (especially non-obvious flags)
- Multi-terminal operations: label explicitly ("Terminal 1", "Terminal 2")

`cdk synth` capture format (see also CLAUDE.md):

```bash
cdk synth RdsRedshiftZeroEtl-Rds --output .temp > patterns/rds/rds-redshift-zero-etl/cloud_formation_rds.yaml
```

Note: use `cdk` (not `npx cdk`). Never append `2>&1` — CDK writes logs to stderr and it will corrupt the YAML.

---

## 8. Entity Relation of AWS Resources

End every README with a Mermaid `flowchart TB` diagram showing all CloudFormation resources and their relationships.
Skill `entity-diagram` should be used to generate the diagram (requires synthesized cloudformation stacks).

---

## Good Practices Checklist

When writing or reviewing a pattern README:

- [ ] Cost warning added for patterns with >$50/mo idle (blockquote or inline bold)
- [ ] Every AWS service links to its official docs (not blog posts)
- [ ] Comparison table present wherever the reader faces an architectural choice
- [ ] Failure modes documented with what the symptom looks like (not just "it breaks")
- [ ] Any manual post-deploy steps called out explicitly (e.g., "run this SQL after integration is Active")
- [ ] CDK context variables (`-c key=value`) listed with the deploy command if the pattern is parameterized
- [ ] Day-2 operations included when relevant (reshard, promote replica, manual failover)
- [ ] `cdk destroy` command covers cleanup in the right order (reverse deploy order for cross-stack deps)
- [ ] `cloud_formation_*.yaml` capture command present for every stack

```

```
