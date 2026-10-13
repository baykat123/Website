# Local development handoff

Read README.md, DEPLOYMENT.md, and INTEGRATIONS.md first.
Use Node.js 24, install with npm ci, and run npm test.
Build and test with sample data and simulated integrations until workflows are finalized.
Preserve the existing Render deployment and business data. Gmail remains read-only. Shopify Canada fulfillment/location access and Easyship production access are approved and verified on Render; every shipment purchase still needs per-order owner approval. Local sample connections stay disabled.
Ask the user before deploying changes or performing external business actions.
Never use production databases, provider credentials, or live provider imports for local workflow development.

Proposed external actions must remain approval-first. Capture corrections and review history; do not enable autonomous execution without a later explicit policy from the user.

Bambu PRM and USA API access is pending, as confirmed by the user on October 6, 2026. No email is required. Prepare and test internal purchase/receiving workflows with fictional data; do not contact Bambu or automate portal purchases as a substitute for approved API access.

Current verified runtime is 92f63c3f9c6d87924761f40c4553a8b9a60931c7 (October 13, 2026). The Canada repair uses distinct desk labels for genuine no-SKU lines, verifies custom-print physical Pieces instead of cent-price quantities, and excludes minimum-order fees from packing while retaining original Shopify quantities. Invoice-description corrections affect only untouched generated drafts; original contents and all financial values are preserved. All 43 tests pass. Freightcom's signed licence was returned with owner approval; actual credentials remain pending. USA and Bambu work remain deferred. See MASTER_OPS_PLAN.md for verified status and limits.
