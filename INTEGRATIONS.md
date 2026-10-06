# Account integrations

The existing Render app at https://operations-desk.onrender.com has Gmail and Canada Shopify read-only connections. New features below require the reviewed warehouse release and separately granted production permissions. Preserve `OPS_TOKEN_KEY`, provider applications, existing consent, and `/var/data/operations.sqlite` across releases. Never paste credentials into chat or commit them.

## Configuration

| Setting | Purpose |
| --- | --- |
| OPS_PUBLIC_URL | Exact HTTPS service URL |
| OPS_TOKEN_KEY | Original secret for encrypted OAuth tokens; preserve it |
| GOOGLE_WORKSPACE_EMAIL | Expected mailbox, currently kamalb@nex3d.com |
| GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET | Existing Google OAuth web app credentials |
| SHOPIFY_SHOP | Canada store, barakatbrand.myshopify.com |
| SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET | Canada app credentials |
| SHOPIFY_USA_SHOP | USA store, blckcompany.myshopify.com |
| SHOPIFY_USA_CLIENT_ID / SHOPIFY_USA_CLIENT_SECRET | Separate USA app credentials |
| OPS_ALLOW_GMAIL_SEND | Default false. `true` requests gmail.send at reconnect; granted scope is also checked before sending |
| OPS_ALLOW_SHOPIFY_FULFILLMENT | Default false. `true` requests read/write merchant-managed fulfillment-order permissions; actual granted scopes are checked |
| OPS_SYNC_INTERVAL_SECONDS | Default 0 (off); 60 or more enables read-only polling |
| OPS_SHIPPING_MODE | Default simulation. `sandbox` accepts only marked fictional samples; `live` enables production adapters |
| EASYSHIP_ENVIRONMENT | production or sandbox; sandbox token must use sandbox endpoint |
| EASYSHIP_API_TOKEN | Private token for selected environment |
| FREIGHTCOM_API_TOKEN | Private approved account API token |
| FREIGHTCOM_PAYMENT_METHOD_ID | Approved account payment method identifier, required for booking |
| OPS_SHIPPING_COMPARISON_CURRENCY | Default CAD. Common quote/charge currency; item declared currency remains the order currency |

Flags alone do not expand existing provider permissions. Registration, scoped consent, deployment approval, verified warehouses/products, and provider validation remain separate requirements.

## Gmail

Callback: `https://operations-desk.onrender.com/api/integrations/gmail/callback`.

Owner initiates OAuth with PKCE and state/session binding. Exact expected mailbox is enforced. Tokens are encrypted; refresh preserves them. Imports paginate inbox message metadata/snippets, without full bodies or attachments. Staff cannot read raw inbox snapshots; linked order notes are shared. Exact reference/customer matches can link internally; ambiguous links need owner review.

Base scope is gmail.readonly. Approved plain-text replies additionally require gmail.send, explicit execution of the immutable approved proposal, and separate live capability flag. A stable Message-ID supports checking uncertain sends without blindly resending. No background sending or automatic mailbox edits occur. Google organization/provider requirements still apply.

## Shopify Canada and USA

Callbacks:

- `https://operations-desk.onrender.com/api/integrations/shopify/callback`
- `https://operations-desk.onrender.com/api/integrations/shopify_usa/callback`

Separate provider applications, credentials, tokens, OAuth states, and expected store identities prevent accidental cross-store writes. Shopify's SDK verifies callback signatures. API version is 2026-10. Imports paginate accessible orders and their line items; older history may require Shopify's additional authorization. Products are limited to 25 recent records. State/cancellation/current quantities are verified again before label purchase and fulfillment.

Base scopes: read_orders, read_products. Optional shipping requires read_locations, read_merchant_managed_fulfillment_orders and write_merchant_managed_fulfillment_orders, appropriate app data access, and matching actual Shopify fulfillment location. Only scanned quantities for one supported domestic shipment/location are fulfilled. Multiple locations or incomplete routing block purchase. Shopify customer notification is off; the desk prepares a tracking reply for approval. Product publication and supplier orders have no live executor.

## Freightcom and Easyship

Easyship Operations desk connection creation was approved. Access was narrowed to addresses/boxes/courier services read, label write, shipment read/write, shipment document/track/rate/tax read. Production and sandbox credentials are stored privately outside Git. Fictional Easyship sandbox rate → draft → label → tracking verification passed; no real paid label was purchased. Production credentials are not installed in Render by this code.

Freightcom's API access request was approved, submitted, and confirmed. Vendor approval is pending; adapter behavior is mocked in automated tests. Both accounts must be available for a complete comparison; partial provider failures are displayed and never presented as a verified best price across both.

Owner configures origins and SKU shipping declarations in Shipping setup & jobs. Live requests require verified HS classifications, company/contact addresses, and correct Shopify location. Saved packages normalize units and retain versioned quote snapshots. Changed order/package/origin/product data or expired quotes requires fresh comparison. Every unit must be scanned before owner approval. Paid/unknown label outcomes are reconciled from durable jobs, not automatically repurchased. An unpaid Easyship draft can be cancelled only after provider verification and explicit owner confirmation.

Cross-border, dangerous-goods, multiple-parcel, and split fulfillment workflows are blocked pending implementation and actual carrier validation.

## Bambu

API access for PRM and the USA supplier workflow is pending, as confirmed October 6, 2026. No email is required. Do not contact Bambu to request duplicate access, guess API endpoints, or treat portal sign-in as API permission. Internal purchase drafts, supplier SKU mapping, USA customer-order snapshots, approval revisions, and fictional inbound scans are implemented. Good/damaged/missing units and unique serial evidence are retained without changing live stock. Approved documentation and credentials are required before implementing/validating live supplier sync, receipt reconciliation, purchasing, and USA fulfillment.

- PRM: https://prm.bambulab.com/#/index
- USA: https://us.store.bambulab.com/account

## Support intake and approvals

`/support` is a public support/warranty form. It returns a generic acknowledgment and does not reveal whether an order/customer exists. Requests and relevant email subjects await owner review. Verify identity/order before converting to a shared staff ticket. Customer attachments, automatic warranty decisions, refunds/replacements, and supplier escalation are not implemented.

Owner handles private inbox links and external approvals. Members can scan, add intentional order notes, and work tickets. Editing proposals invalidates approval. Correction history reuses matching approved text; it is not AI training or permission for automatic execution.

## Recovery and validation

Disconnect removes that provider's saved tokens/imported snapshot, not durable order notes/tickets or provider-side app permissions. Revoke access in the provider account when required. Restore the original encryption key if tokens cannot be decrypted; never rotate it casually.

Tests simulate provider authorization, signatures, encryption, snapshots, scopes, store separation, fulfillment, unknown sends/purchases, and privacy. They do not establish live write readiness. Preserve data and verify the approved live release separately.

Warehouse addresses can be loaded directly from Shopify after read_locations is granted. Imported line items retain Shopify HS code and manufacturing country when provided. Battery and dangerous-goods declarations require explicit SKU review; missing declarations block production rate requests.
