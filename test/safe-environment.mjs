// Render also exposes runtime credentials while building. Each test worker must
// start without them; provider tests supply explicit fictional configurations.
// This changes only the test subprocess, never the deployed server environment.
for (const name of Object.keys(process.env)) {
  if (/^(OPS_|GOOGLE_|SHOPIFY_|EASYSHIP_|FREIGHTCOM_)/.test(name)) delete process.env[name];
}
