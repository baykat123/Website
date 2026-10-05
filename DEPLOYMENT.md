# Render deployment proposal

The app is currently tested in a private development environment. `render.yaml` proposes a **paid Starter web service and a 1 GB persistent disk**. Review current charges in Render before creating the service. No Render resources have been created by these files, and no cloud account credentials are included.

## Source prerequisite

Render must be connected to the GitHub repository containing this app. Local code in the cloud development workspace is not automatically uploaded to GitHub. Confirm whether `baykat123/Website` is private before uploading; even a public source repository must never include passwords or business data. Its name can remain Website; the service name will be operations-desk.

Upload the reviewed application code to an agreed branch, then grant Render access to this repository only. No development database or account password files belong in the source repository. The database, password files, and `.env` are excluded by `.gitignore`, and the current development data is outside the checkout.

## Create the prototype service

1. In the Render dashboard, select **New → Blueprint**, connect the GitHub repository, and choose the branch containing `render.yaml`.
2. Inspect the proposed Starter service and disk and their displayed costs. Proceed only after approving the subscription. Automatic deployments are disabled in the proposal.
3. Render runs `npm ci && npm test` as the build command, then `npm start`. The application installs Shopify's official SDK from the pinned lockfile and does not require a frontend compilation step. The supplied Node version is 24.19.0.
4. The server binds to `0.0.0.0` and uses Render's provided `PORT`. SQLite writes to `/var/data/operations.sqlite`, backed by the persistent disk. HTTPS requests use secure session cookies. Keep the app at one instance; SQLite is not configured for multiple independent application instances.
5. Use the deployed service's **Shell** to run `npm run create-user -- your-username`. The command creates a random password in `/var/data/your-username.password` with restrictive file permissions. Retrieve the password privately in your authenticated shell, store it in your password manager, and never paste it into this chat. The first account is the owner. Use **Team & account** to invite additional members with individual passwords. Repeat CLI calls preserve existing accounts and password files.
6. Open the HTTPS address displayed by Render and verify sign-in, creating/editing a test quote, submitting it for review, approving it, converting it to an order draft, and logging out. Confirm another account sees the same test records. App approvals do not trigger external actions.
7. Restart the service and verify accounts and test records remain. Never delete the disk to redeploy.

Render deployment, subscription approval, account creation, and external HTTPS validation have **not** been performed in the development workspace. A passing local test does not establish deployment success.

## Before using live business records

Use this deployment only to validate the prototype until production prerequisites are completed:

- Configure backups outside the live disk and successfully restore a backup in an isolated instance. A persistent disk alone is not a backup.
- Validate the owner/member roles and self-service password change on the deployed app, plan secure forgotten-password recovery or Google Workspace sign-in, and review account security. There is no email password recovery or MFA yet.
- Configure production monitoring and an operating owner. Do not use a personal development password or database in production.
- Register and authorize Gmail and Shopify applications using [INTEGRATIONS.md](INTEGRATIONS.md), then validate the implemented encrypted token storage and read-only imports against real providers. Continuous monitoring, authenticated webhooks, durable jobs, and write actions are still pending. QuickBooks remains optional.

The prototype stores quote/invoice records and user-entered taxes. It does not deliver tax-compliant invoices, manage payments, monitor Gmail, place supplier purchases, publish Shopify products, or perform SEO automatically.
