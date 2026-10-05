# Connect the business accounts

The implementation supports owner-managed OAuth connections and **manual, read-only imports**. Production authorization and real-provider validation remain outstanding. It does not send mail, modify the mailbox, publish products, create Shopify orders, or monitor continuously.

## Render configuration

The Blueprint sets these non-secret values:

- `OPS_PUBLIC_URL=https://operations-desk.onrender.com`
- `GOOGLE_WORKSPACE_EMAIL=kamalb@nex3d.com`
- `SHOPIFY_SHOP=barakatbrand.myshopify.com`

It proposes a generated `OPS_TOKEN_KEY` for AES-256-GCM encryption of saved OAuth tokens. Apply the Blueprint update through Render before connecting. Preserve this key across deploys and back it up securely alongside your recovery procedure; a changed or missing key prevents existing credentials from decrypting. Never store the key in Git or share it in chat.

The following credentials must be entered privately in **Render → operations-desk → Environment** after registering your provider applications:

| Variable | Where to obtain it |
| --- | --- |
| `GOOGLE_CLIENT_ID` | Google Cloud OAuth web application |
| `GOOGLE_CLIENT_SECRET` | The same Google OAuth application |
| `SHOPIFY_CLIENT_ID` | Shopify app's client ID |
| `SHOPIFY_CLIENT_SECRET` | The same Shopify app's client secret |

Keep these variables outside the Blueprint and source control. Shopify's client secret is needed locally to validate callback signatures; a network-only proxy placeholder cannot substitute for it. All of these values must be available to the actual Render app process, not just a development environment. Never ask the user to paste credential values into a chat.

## Google Workspace Gmail

1. In the business-owned Google Cloud organization/project, enable the Gmail API. Configure the Google Auth Platform application. Use **Internal** audience if the Workspace organization permits it, with access limited to authorized business users.
2. Add `https://www.googleapis.com/auth/gmail.readonly`. This is a restricted scope. External application distribution may require Google's verification; Workspace administrators may also need to permit the app. Do not disable consent or bypass organizational restrictions.
3. Create a **Web application** OAuth client. Register this exact authorized redirect URI:

   `https://operations-desk.onrender.com/api/integrations/gmail/callback`

4. Save its client ID and client secret in Render's variables above and restart/deploy the service with the updated environment.
5. Sign in to Operations desk as the workspace owner, open **Connections**, and select **Connect Gmail**. Authorize **kamalb@nex3d.com**. The server rejects a different mailbox, validates OAuth state against the owner and their active session, and uses PKCE for the code exchange.
6. Select **Sync now**. Verify recognizable real message subjects/senders and the successful sync timestamp. It fetches up to 25 INBOX messages and stores subjects, sender headers, dates, and snippets. It does not fetch attachments/full message bodies, send messages, or poll continuously. A later sync replaces the imported inbox snapshot; internal draft records are separate and preserved.

## Shopify

1. In the business's Shopify Dev Dashboard, create an app for **barakatbrand.myshopify.com** with the appropriate single-store/custom distribution. Configure non-embedded access for this standalone operations app. Use app URL `https://operations-desk.onrender.com`.
2. Configure only `read_orders` and `read_products` for this initial integration. Complete Shopify's relevant app distribution and data access approvals. No customer address or payment details are requested by the current query; additional features will require a separate scope/data-access review.
3. Register the exact OAuth redirect URI:

   `https://operations-desk.onrender.com/api/integrations/shopify/callback`

4. Save the app's client ID and secret in Render and restart/deploy the service with that environment. Ensure the app version with these scopes/callbacks is available for installation on the intended store.
5. In Operations desk → **Connections**, select **Connect Shopify** and approve installation for **barakatbrand.myshopify.com**. The server validates the callback signature with Shopify's official SDK, checks OAuth state and the active owner session, and rejects a different store.
6. Select **Sync now** and verify a recognizable order and product. The GraphQL import uses API version `2026-10`, up to 25 recently updated orders and 25 recently updated products, and replaces the Shopify snapshot on success. It does not import all historic orders, modify products, or place purchases. A protected-data or permission denial must be resolved with Shopify before claiming readiness.

## Team accounts

The earliest existing account becomes the workspace owner during the additive database migration. For the original Render deployment this should be **kamal**. Existing passwords and business records are preserved. Owner accounts manage invitations/connections; members share business records and imported snapshots but cannot change account connections or invite teammates.

Use **Team & account → Invite by email** to create a private, one-time link valid for 48 hours. Share it directly with that person. The app does not email invitations. Creating a replacement invitation invalidates the prior unused link for that email. The recipient selects a username/password on the join page and receives member permissions. Never share invitation links publicly.

Each user can change their password under **Team & account**; doing so revokes every existing session for that user. Sessions use HttpOnly cookies with SameSite=Lax so authenticated OAuth redirects can return; JSON mutation endpoints retain origin/content-type protections. There is no email-based password recovery or MFA yet. Invitation/account creation must be validated on the deployed service before onboarding real teammates.

## Disconnecting and recovery

Disconnect removes saved tokens, pending authorization states, and that provider's imported snapshot from this app. It does not revoke the provider's app permission. Revoke access separately in Google Workspace/Google Account or Shopify administration when required. Internal business records remain.

Owner/password recovery and encryption-key recovery still require the operator's secure access to the hosting service. No browser API exposes saved tokens, password hashes, or the encryption key.

## Validation status

Automated tests use simulated provider responses to exercise authorization failure/success, PKCE, state/session binding, signature verification, encrypted storage, token refresh, import idempotency, provider denial, and preserving snapshots on failure. Those tests do not establish that Google/Shopify have authorized the live app. Validate consent, actual provider records, deploy/restart persistence, and provider revocation with the registered applications before enabling everyday use.
