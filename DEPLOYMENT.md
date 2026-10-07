# Existing Render deployment

Operations desk already runs at https://operations-desk.onrender.com, with existing business data and read-only Gmail and approved Shopify Canada fulfillment connections. The warehouse release `cebfe83cf5c59cf199a6c8862359b8775205b2ca` is successfully deployed and live. Further changes still require review and authorization. `render.yaml` describes the existing single-instance Starter service and persistent disk; do not create a replacement service or delete its disk.

## Preserve the current service

- Keep `/var/data/operations.sqlite`, users/passwords, provider credentials, and the original `OPS_TOKEN_KEY`.
- Keep one instance. SQLite requires the shared persistent local disk; multiple independent instances are unsupported.
- Keep automatic deployment off. Ask for approval before pushing a release that could deploy or using Render Manual Deploy.
- Do not include databases, password files, environment variables, shipping credentials, or private test artifacts in Git.
- Node.js 24 is required. Build: `npm ci && npm test`; start: `npm start`; health: `/health`. HTTPS production uses `OPS_HOST=0.0.0.0`, the Render PORT, secure cookies, and the durable DB path.

## Reviewable release procedure

1. Prepare a clean change review and test report on fictional data. Describe new writes, permissions, migrations, and outstanding blocked workflows accurately.
2. Create a database backup using SQLite's backup facilities and retain it securely outside the live disk. Verify restoring into an isolated instance. Never test restoration against the production DB.
3. Review the exact release commit and requested environment changes with the owner. Gmail send, Shopify fulfillment, shipping production mode/tokens, and USA app consent each need their explicit authorization. Flags do not substitute for provider consent.
4. After release approval, push only reviewed source and deploy the existing Render service manually. Preserve the encryption key. Additive tables/columns retain existing records; do not use destructive resets or development seeds.
5. Confirm Render reports a successful live deploy. Refresh the expected live UI, health endpoint, authenticated accounts/records, and unchanged connected accounts. Restart and confirm persistence. A successful local test or a running build is not deployment success.
6. Validate actual warehouses/SKU declarations and provider permissions before live shipping. Perform representative approved provider checks; never use a real customer shipment as an unapproved test.

## Current readiness

All 34 tests pass on Node.js 24.21.0 and in the Render build. The warehouse release is live. Shopify Canada grants and Easyship production access are verified; Richmond origin is configured. Production rates returned 18 options with fictional verification data, without a label purchase. The pre-release SQLite backup passed an isolated restore check. Remaining SKU safety declarations await owner information. Freightcom credentials/payment method and USA OAuth are unconfigured; Bambu API access remains pending. Gmail sending, support attachments, live supplier execution, cross-border/split shipping, and issued/delivered invoices are not complete.

See [MASTER_OPS_PLAN.md](MASTER_OPS_PLAN.md) for the acceptance ledger and [INTEGRATIONS.md](INTEGRATIONS.md) for exact configuration. Production backups/restore, monitoring, secure account recovery/MFA, and operating ownership still need verification before full everyday use. Do not call this a completed master desk until those requirements and all requested workflows are met.
