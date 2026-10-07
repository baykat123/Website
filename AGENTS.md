# Local development handoff

Read README.md, DEPLOYMENT.md, and INTEGRATIONS.md first.
Use Node.js 24, install with npm ci, and run npm test.
Build and test with sample data and simulated integrations until workflows are finalized.
Preserve the existing Render deployment and business data. Gmail remains read-only. Shopify Canada fulfillment/location access and Easyship production access are approved and verified on Render; every shipment purchase still needs per-order owner approval. Local sample connections stay disabled.
Ask the user before deploying changes or performing external business actions.
Never use production databases, provider credentials, or live provider imports for local workflow development.

Proposed external actions must remain approval-first. Capture corrections and review history; do not enable autonomous execution without a later explicit policy from the user.

Bambu PRM and USA API access is pending, as confirmed by the user on October 6, 2026. No email is required. Prepare and test internal purchase/receiving workflows with fictional data; do not contact Bambu or automate portal purchases as a substitute for approved API access.

Current warehouse release is cebfe83cf5c59cf199a6c8862359b8775205b2ca. The owner confirmed regular shipping/no special handling on October 6. All 62 current outstanding-order SKUs now have profiles (63 saved total); 19 imported lines without SKUs remain blocked pending actual scan identifiers. Future battery/liquid products need accurate declarations; do not invent these fields. See MASTER_OPS_PLAN.md for the verified state and limits.
