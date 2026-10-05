# Operations desk

A working starting point for a small business's shared operations system. Node.js 24 serves the interface and authenticated JSON API, and SQLite persists records, users, sessions, and activity. There are no third-party runtime dependencies.

## Current capabilities

- Individual username/password accounts with shared team records.
- Quotes, orders, and invoice drafts with line items, quantities, shipping, manually entered tax, and server-calculated totals in integer cents.
- Draft → review → approved workflow, quote-to-order and order-to-invoice conversion.
- Follow-up and marketing tasks, email drafts, product drafts, and manual dropship status tracking.
- Activity history and optimistic concurrency protection when multiple users update records.

These are internal records. Gmail monitoring/sending, Shopify sync/publishing, supplier purchasing, payment processing, PDF/tax-compliant invoice delivery, and QuickBooks are **not connected or implemented**. Approving a record does not perform an external action. Drafts and active tasks/shipments can be edited; reviewed/completed records are protected. Deletion, attachments, and full accounting are not yet implemented.

## Local development in the cloud workspace

Use the existing `/workspace/Website` checkout; each task is already isolated. Do not create a Git worktree unless the user requests one.

```sh
cd /workspace/Website
node --version                 # Node 24.x
npm test
npm run create-user -- admin   # Run only once per database
npm start
```

The app binds to `127.0.0.1:3000` by default. Onboarding supports internal requests, not a user-facing browser preview. Verify `GET /health` and authenticate for representative requests to `/api/records`.

The initial account's random password is saved with restrictive permissions at `/workspace/.business-operations/admin.password`. Retrieve it securely; do not print it into chat, commit it, or publish it. Create other accounts with `npm run create-user -- <username>`. This command refuses to replace existing accounts/password files. There is no password reset UI yet.

Data lives outside the repository at `/workspace/.business-operations/operations.sqlite`. `OPS_DB_PATH` can point to another durable path. Other runtime settings: `PORT`, `OPS_HOST` (default `127.0.0.1`), and `OPS_SECURE_COOKIES=true` when accessed through HTTPS. Sessions expire after eight hours. All accounts have equal access; no administrator role, MFA, or Google sign-in is implemented yet.

## Deployment and account connections still required

See [DEPLOYMENT.md](DEPLOYMENT.md) and the proposed `render.yaml` for the Render hosting steps, paid-service requirements, and production checklist. Creating these files does not deploy the service or upload source to GitHub.

This cloud development environment is not a production hosting service. Do not expose this prototype publicly as-is. Before everyday team use, choose a hosting account and deploy behind HTTPS with persistent storage, backups and restore validation, secure user provisioning/password recovery or Google Workspace sign-in, and production monitoring. Never bake development passwords or business databases into a public image. SQLite is appropriate for a single small app instance with durable local storage; horizontal scaling requires a managed database and a different session/storage design.

For Google Workspace, register a Google Cloud OAuth application, request only required Gmail scopes, configure the callback URL, and obtain administrator approval where required. Store tokens securely outside Git. External Gmail applications with sensitive/restricted scopes may require Google's verification process.

For Shopify, configure an application with only the required order/product permissions, securely store its access credentials, and configure authenticated webhooks. No Shopify or Google credentials are required for the current local workflow. QuickBooks remains optional; select it only if you want accounting integration.

Before adding automated external actions, implement durable jobs, retries with idempotency, explicit approval policies, audit events, and provider-specific integration tests. This application currently makes no external business requests.
