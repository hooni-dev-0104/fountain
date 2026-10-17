/** Non-secret installation scope. Changing this does not migrate or link user data. */
export const deployment=Object.freeze({
  workspaceId:'a2d18b6eef4444b0aa1e956496f7d9be',
  // The production frontend is hosted on this exact HTTPS origin.
  webOrigins:['https://fountain-hoonis-projects-1ccfd37e.vercel.app'] as string[],
  // Optional verified sharing origin; must also occur in webOrigins.
  publicWebOrigin:'https://fountain-hoonis-projects-1ccfd37e.vercel.app' as string|null,
  // Setup still requires an explicit private, expiring claim for the existing member.
  setupEnabled:true,
});
