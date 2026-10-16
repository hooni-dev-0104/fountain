/** Non-secret installation scope. Changing this does not migrate or link user data. */
export const deployment=Object.freeze({
  workspaceId:'a2d18b6eef4444b0aa1e956496f7d9be',
  // Add the verified static frontend's exact HTTPS origin before browser cutover.
  webOrigins:[] as string[],
  // Enable only after the private bootstrap RPC and actual setup flow are verified.
  setupEnabled:false,
});
