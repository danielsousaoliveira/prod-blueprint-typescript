# GCP → AWS → Azure, for this system

I know AWS and Azure; GCP is the gap this document exists to close. So it is written the
way I actually needed it — start from the service I already understand, find the GCP
equivalent, and note where the analogy breaks, because the places it breaks are where the
real surprises are.

## The services this project uses

| What it does here                    | GCP                                         | AWS                                   | Azure                           |
| ------------------------------------ | ------------------------------------------- | ------------------------------------- | ------------------------------- |
| Runs the API container               | **Cloud Run**                               | App Runner, or ECS Fargate            | Container Apps                  |
| Stores the container image           | **Artifact Registry**                       | ECR                                   | Azure Container Registry        |
| MongoDB                              | **MongoDB Atlas** (marketplace)             | Atlas, or DocumentDB                  | Atlas, or Cosmos DB (Mongo API) |
| Redis                                | **Memorystore**                             | ElastiCache                           | Azure Cache for Redis           |
| Secrets                              | **Secret Manager**                          | Secrets Manager / SSM Parameter Store | Key Vault                       |
| Private networking to the datastores | **Serverless VPC Access connector**         | VPC + security groups                 | VNet integration                |
| CI/CD                                | **Cloud Build** (using GitHub Actions here) | CodeBuild                             | Azure Pipelines                 |
| Logs and metrics                     | **Cloud Logging / Monitoring**              | CloudWatch                            | Azure Monitor                   |
| Workload identity for CI             | **Workload Identity Federation**            | IAM OIDC role                         | Federated credential            |

## Where the analogy breaks — the parts worth knowing

**Cloud Run is not "Fargate with less YAML".** Two differences change how you write the
application, not just how you deploy it:

- **CPU is throttled outside a request** unless you set `cpu-throttling: false`. This
  project has an outbox relay polling on a timer and BullMQ workers processing jobs
  between requests. With throttling on, those run only while a request happens to be in
  flight, so notifications arrive in bursts whenever someone loads a page. The symptom is
  "background jobs are mysteriously slow" — not an error, which is what makes it
  expensive to diagnose. ECS Fargate has no equivalent trap; the container simply runs.
- **The filesystem is read-only apart from `/tmp`.** This bit me for real: code-first
  GraphQL was writing `schema.gql` at boot, which fails under a non-root user and would
  fail on Cloud Run regardless.

**Serverless VPC Access is an extra hop with its own capacity.** On AWS, putting a Fargate
task in a VPC is the default posture. On Cloud Run you attach a connector that is itself a
scaling resource with throughput limits, and it can become the bottleneck between the API
and MongoDB while both look healthy.

**Cosmos DB's Mongo API is not MongoDB.** The most relevant difference for this project:
**partial indexes** are unsupported. The double-booking guarantee is a partial unique
index on `(doctorId, startsAt)` filtered to active statuses — without the filter, a
cancelled slot could never be rebooked (documented design choice). So "move to Azure" is not a
deployment change here; it is a redesign of the correctness mechanism. Atlas on Azure
avoids that entirely, which is why it is the first choice in the table.

**DocumentDB has the same shape of problem** — it emulates an older MongoDB wire protocol
and its transaction and index support lags. Anything relying on `$dateTrunc` (the stats
aggregation) or partial unique indexes needs checking against the specific version.

## Deploying this

```bash
# 1. Build and push
gcloud builds submit --tag europe-west1-docker.pkg.dev/PROJECT_ID/scheduler/api:$GIT_SHA

# 2. Migrate FIRST, as a separate step, as a job — not on boot
gcloud run jobs execute scheduler-migrate --region=europe-west1 --wait

# 3. Then roll out the code
gcloud run services replace deploy/cloudrun/service.yaml --region=europe-west1
```

Migrations run **before** the new revision, as a Cloud Run Job rather than at startup —
several instances starting at once would race each other, and a deploy should not silently
mutate the schema. That ordering only works because every migration is
backwards-compatible with the currently-running code: during a rollout both versions serve
traffic simultaneously, so a destructive change has to wait for a later release. Add in
release N, remove in release N+1.

The AWS equivalent is an ECS one-off task in the pipeline; on Azure, a Container Apps job.
The discipline is identical and platform-independent — only the noun changes.

## What I would add before calling this production-ready

- **Cloud Armor** (AWS WAF / Azure Front Door) in front, with rate limiting. GraphQL makes
  this more than routine hardening: the client composes the query, so depth and complexity
  limits are application-level defences that a network-level one complements rather than
  replaces (documented design choice).
- **Uptime checks** against `/health`, alerting on the readiness endpoint rather than on
  raw error rate — it fails before users notice.
- **Structured log correlation.** Pino already emits JSON, which Cloud Logging parses
  natively; the missing piece is a request id propagated into every log line and returned
  in problem+json responses, so a reported error maps to a server log entry.
- **Workload Identity Federation** for the GitHub Actions deploy, rather than a
  long-lived service account key in a repository secret. Same reasoning as an IAM OIDC
  role on AWS: a key that never expires is a key that eventually leaks.
