# Master operations desk — acceptance ledger

Last updated October 6, 2026. Warehouse release cebfe83 is successfully deployed/live. Shopify Canada and Easyship production access are verified. Local tests and demos use fictional records and simulated connections. No Bambu email is required or authorized.

## Operating policy

Prepare proposed external actions for owner approval. Edits invalidate approval. Retain corrections, review decisions, scan evidence, source records, and execution outcomes. Do not enable automatic sending, supplier purchases, or label purchase without a later explicit per-action policy. Keep Render's database, accounts, original encryption key, and current connections intact.

## Implemented and tested

| Workflow | Behavior and verification |
| --- | --- |
| Quotes/orders/invoices | Exact cents, persistent conversion links, concurrency checks, review workflow, PDF quotes/estimates and invoice drafts. Paid, complete, reconciled Shopify orders prepare one invoice draft. |
| Store separation | Canada and USA have separate OAuth configuration, token contexts, store identities, and imports, including overlapping external order IDs. |
| Order imports | Paginated accessible orders and nested line items; remaining shipping quantities, exact discounted totals, cancellation and current state checks. Products remain limited to 25 recent records. |
| Email links | Exact order reference plus matching customer email auto-links an unambiguous snapshot to an internal note. Owner reviews ambiguous suggestions and rejects remembered links. Staff cannot browse private Gmail snapshots or attach raw emails. |
| Replies/corrections | Edit, approve, reject, simulate; reuse approved corrections for identical original text. Authorized Gmail sends have stable message IDs and uncertain outcomes require reconciliation without resend. Product publishing has no live executor. |
| Support/warranty | Public form and email-subject intake queue; owner verifies customer/order before conversion to a staff ticket. Assignment, versioned updates, order notes, serial evidence, generic public acknowledgment, and request throttling. |
| Packing | Unit scans by SKU/barcode; wrong item, ambiguity, excess units, duplicate scan key, and post-booking edits rejected. Changed packing requirements retire evidence without deleting history. Price-only changes retain scans. |
| Saved packages | Owner creates/edits/archives/restores named packages. cm/in and kg/lb conversion; defaults populate shipping form. Package changes invalidate old quotes. |
| Shipping | Common-currency total comparison, provider errors disclosed, immutable approved package/order/origin/product snapshots. Domestic single-parcel shipping only. SKU declarations and sender location required. |
| Durable booking | Stable operation key, saved unpaid provider draft reference, price recheck before label purchase, startup/timeout uncertainty protection, provider reconciliation, and one shipment per order. |
| Tracking | Approved live shipment creates an order tracking note and attempts Shopify fulfillment for scanned units at the authorized location. Failed tracking sync needs explicit review/retry. Customer notification is a reply draft. |
| Bambu preparation | Supplier-mapped purchase drafts, one active request per source USA order, expected arrival, approved revision history, sample acceptance and receipt scans. Serials cannot be duplicated, over-receipts are rejected, and good/damaged/missing units are displayed separately. No live stock or supplier writes. |
| Read-only monitoring | Optional non-overlapping polling with provider health; minimum interval 60 seconds, default off. Does not buy labels or send mail. |

34 automated tests pass on Node.js 24.21.0. Tests cover provider mocks, authorization, data preservation, concurrency, packing, invoices/PDFs, public intake privacy, and uncertain writes. Easyship's actual sandbox produced comparable CAD rates, an unpaid draft, a test label, and tracking for fictional US sample data. Sandbox actions did not purchase real shipping or change Shopify. Freightcom adapter tests use mocked responses pending its API grant.

## Account status and dependencies

| Account | Confirmed status | Remaining requirement |
| --- | --- | --- |
| Gmail kamalb@nex3d.com | Existing Render read-only connection | Approve/re-authorize sending scope when the release is ready. Full message bodies/attachments are not imported. |
| Canada Shopify barakatbrand.myshopify.com | Fulfillment/location grants approved and provider-verified on Render | All current outstanding SKUs profiled; 19 lines without SKUs need actual identifiers. Physical scans required for each order. |
| USA Shopify blckcompany.myshopify.com | Permanent domain verified; public storefront us.nex3d.com | Separate app credentials and OAuth connection, actual fulfillment location and supplier eligibility. |
| Easyship | Production connection installed and live rate verification passed; sandbox label/tracking verified | Per-order owner approval; actual packed weight; identifiers for imported lines lacking SKUs. |
| Freightcom | API access request submitted and confirmed; 100 shipments/month, no carrier partners | Vendor approval, private token/payment method, actual-provider validation. |
| Bambu PRM and USA | User confirms API access pending; no email needed | Approved official API documentation/credentials and supported receiving/order/fulfillment contract. |

Bambu portals: https://prm.bambulab.com/#/index and https://us.store.bambulab.com/account. Browser sign-in does not establish API access. No guessed endpoints, automated portal purchasing, supplier email, or claim decision is used as a substitute.

## Unfinished scope — full delivery cannot yet be claimed

- Bambu catalog/order/inbound syncing, live purchasing/receipt reconciliation, inventory writes, and USA supplier fulfillment need the approved provider contract and implementation. Internal purchase/arrival/receipt preparation works with sample data; supplier-provided inventory/acceptance/tracking is not connected.
- Split fulfillment, backorders, multiple parcels/locations, cross-border customs, serialized inventory/location control, physical scanner validation, and dangerous-goods handling remain unavailable.
- Support attachments, customer identity verification automation, SLA policy, return/refund/replacement execution, and supplier escalation remain unimplemented.
- Issued invoices need verified business identity, numbering, tax/accounting policy, customer details, refunds/credit notes, and approved delivery. Current PDFs are drafts.
- Shopify product publication, historic all-orders access approval, incremental mailbox history/webhooks, AI training/evaluation, and autonomous per-action policies remain unfinished.
- Full live master-desk delivery still requires the unfinished workflows above. The warehouse release, isolated backup restore, production grants, and rate verification are confirmed. No live shipment was purchased during setup.

## Sources

- Easyship API: https://developers.easyship.com/reference/rates_request and https://developers.easyship.com/docs/sandbox
- Freightcom API: https://developer-test.freightcom.com/
- Shopify Admin GraphQL: https://shopify.dev/docs/api/admin-graphql/2026-10
- Gmail sending: https://developers.google.com/workspace/gmail/api/guides/sending

## Live warehouse status — October 6, 2026

Release `cebfe83cf5c59cf199a6c8862359b8775205b2ca` is successfully deployed/live on the existing Render service. Easyship production access and Shopify Canada fulfillment/location grants are verified. Richmond origin is configured. A production rate query returned 18 CAD options with fictional verification data and no label purchase. Three PETG HF G02 profiles retain manufacturer SDS declarations; 60 more profiles use the owner-confirmed regular-shipping rule. All 62 outstanding-order SKUs are covered by 63 saved profiles. Nineteen imported lines lack SKUs and need actual scan identifiers; Freightcom credentials remain unconfigured. Domestic single-parcel supported shipments only. Bambu remains pending/excluded, USA is not connected by the Canada grant, and Gmail sending remains disabled.
