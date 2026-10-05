# Operations desk

A working starting point for a small business's shared operations system. Node.js 24 serves the interface and authenticated JSON API, and SQLite persists records, users, sessions, and activity. Shopify callback signatures are verified with Shopify's official SDK, pinned in the lockfile.

## Current capabilities

- Individual username/password accounts with shared team records.
- Owner-managed, single-use team invitations, member access, and self-service password changes that revoke existing sessions.
- Quotes, orders, and invoice drafts with line items, quantities, shipping, manually entered tax, and server-calculated totals in integer cents.
- Draft → review → approved workflow, quote-to-order and order-to-invoice conversion.
- Follow-up and marketing tasks, email drafts, product drafts, and manual dropship status tracking.
- Activity history and optimistic concurrency protection when multiple users update records.
- Owner-managed Google Workspace and Shopify OAuth connections with encrypted token storage, read-only imports, and connection/activity status. Provider applications and live authorization must be configured separately; see [INTEGRATIONS.md](INTEGRATIONS.md).

Internal drafts are separate from read-only Gmail and Shopify imports. Continuous Gmail monitoring/sending, Shopify publishing, supplier purchasing, payment processing, PDF/tax-compliant invoice delivery, and QuickBooks are **not implemented**. Approving a record does not perform an external action. Drafts and active tasks/shipments can be edited; reviewed/completed records are protected. Deletion, attachments, and full accounting are not yet implemented.

## Local development in the cloud workspace

Use the existing `/workspace/Website` checkout; each task is already isolated. Do not create a Git worktree unless the user requests one.

```sh
cd /workspace/Website
node --version                 # Node 24.x
npm ci --cache /workspace/.cache/npm
npm test
npm run create-user -- admin   # Run only once per database
npm start
```

The app binds to `127.0.0.1:3000` by default. Onboarding supports internal requests, not a user-facing browser preview. Verify `GET /health` and authenticate for representative requests to `/api/records`.

The initial account's random password is saved with restrictive permissions at `/workspace/.business-operations/admin.password`. Retrieve it securely; do not print it into chat, commit it, or publish it. Create other accounts with `npm run create-user -- <username>` or use owner-managed invitation links. This command refuses to replace existing accounts/password files. Password changes are available in the UI; forgotten-password recovery is not.

Data lives outside the repository at `/workspace/.business-operations/operations.sqlite`. `OPS_DB_PATH` can point to another durable path. Other runtime settings: `PORT`, `OPS_HOST` (default `127.0.0.1`), and `OPS_SECURE_COOKIES=true` when accessed through HTTPS. Sessions expire after eight hours. The earliest account becomes the workspace owner; later accounts are members. Business records are shared. Owner permissions are required for invitations and account connections. MFA and Google sign-in for app login are not implemented; Gmail OAuth connects the mailbox, not the user's app login.

## Deployment and account connections still required

See [DEPLOYMENT.md](DEPLOYMENT.md) and the proposed `render.yaml` for the Render hosting steps, paid-service requirements, and production checklist. Creating these files does not deploy the service or upload source to GitHub.

This cloud development environment is not a production hosting service. Do not expose this prototype publicly as-is. Before everyday team use, choose a hosting account and deploy behind HTTPS with persistent storage, backups and restore validation, secure user provisioning/password recovery or Google Workspace sign-in, and production monitoring. Never bake development passwords or business databases into a public image. SQLite is appropriate for a single small app instance with durable local storage; horizontal scaling requires a managed database and a different session/storage design.

For Google Workspace and Shopify, follow [INTEGRATIONS.md](INTEGRATIONS.md) to register applications, set secure runtime configuration, and validate real account authorization/imports. Connections stay disabled when required configuration is absent. External Gmail applications with sensitive/restricted scopes may require Google's verification process.

No provider credentials are required for local business records, team features, or the simulated-provider tests. QuickBooks remains optional; select it only if you want accounting integration. Continuous monitoring and background automation will require additional implementation.

Before adding automated external actions, implement durable jobs, retries with idempotency, explicit approval policies, audit events, and provider-specific integration tests. Current external requests are limited to OAuth authorization/token refresh and read-only account imports.
