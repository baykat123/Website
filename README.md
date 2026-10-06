# Operations desk

A working starting point for a small business's shared operations system. Node.js 24 serves the interface and authenticated JSON API, and SQLite persists records, users, sessions, and activity. Shopify callback signatures are verified with Shopify's official SDK, pinned in the lockfile.

See [MASTER_OPS_PLAN.md](MASTER_OPS_PLAN.md) for the master desk scope, local features, integration dependencies, and live-work boundaries.

## Current capabilities

- Individual username/password accounts with shared team records.
- Owner-managed, single-use team invitations, member access, and self-service password changes that revoke existing sessions.
- Quotes, orders, and invoice drafts with line items, quantities, shipping, manually entered tax, and server-calculated totals in integer cents.
- Draft → review → approved workflow, quote-to-order and order-to-invoice conversion. Conversions now retain durable source/target links; repeating a conversion returns the existing draft instead of creating duplicates. Existing historical conversions remain unchanged.
- Clickable overview counts, assigned-to-me and overdue filters, and a live sales total preview before saving. Server-calculated totals remain authoritative.
- Follow-up and marketing tasks, email drafts, product drafts, and manual dropship status tracking.
- Owner-only proposed email/product actions with edit, approval, rejection, simulation, and retained correction history. Approved corrections are reused for identical draft text while preserving email recipients. Editing invalidates approval; email execution requires the separate sending permission and explicit action. Product publication and autonomous execution are unavailable.
- Order desk with durable store-scoped orders, exact-reference/customer email association, support/warranty tickets, public requests awaiting owner review, and unit scanning. Saved packages and domestic shipping adapters compare compatible prices, retain booking jobs, and reconcile uncertain outcomes. Complete scans are required before booking.
- Automatically prepared invoice drafts from complete reconciled paid-order snapshots; authenticated quote/estimate and invoice PDF downloads. PDF download does not issue or send an invoice.
- Bambu purchase drafts with mapped supplier SKUs, source USA-order snapshots, versioned approval history, and fictional inbound receiving scans with unique serial/damage evidence. Live supplier APIs are pending.
- Activity history and optimistic concurrency protection when multiple users update records.
- Owner-managed Google Workspace and Shopify OAuth connections with encrypted token storage, read-only imports, and connection/activity status. Provider applications and live authorization must be configured separately; see [INTEGRATIONS.md](INTEGRATIONS.md).

Internal drafts are separate from provider snapshots. This checkout adds approval-gated Gmail sending, configurable read-only polling, durable shipping jobs, Shopify tracking updates, a separate USA connection, and public support intake. Deployment readiness must be verified against the running Render release. Local examples use fictional data and simulated providers. See [INTEGRATIONS.md](INTEGRATIONS.md) for configuration and permission gates.

Bambu API access is pending. Supplier syncing/purchasing, Shopify product publication, split/multiple-parcel fulfillment, cross-border label booking, attachments, issued invoice numbering, invoice delivery, credit notes, and full accounting remain unfinished. Approved correction reuse matches identical drafts; it is not a trained AI model or an automatic execution policy.

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

No provider credentials are required for local business records, team features, or the simulated-provider tests. QuickBooks remains optional; select it only if you want accounting integration. Read-only polling is available through `OPS_SYNC_INTERVAL_SECONDS`; external actions still require approval.

Durable shipping jobs and approved-email outcomes distinguish successful, failed, and uncertain writes. Never retry an uncertain purchase or send blindly. Automatic external execution remains unavailable until an explicit per-action policy and further provider validation exist.
