# Fountain web shell

Run `node apps/web/build.mjs` from the repository root, then test with
`node --test tests/web-host.mjs`. The output contains the static application and
one presentation relay. Business functions, Auth, data and file storage remain
in Supabase. There is no database connection, service key, package installation,
or Python runtime in this web artifact. Desktop and mobile clients can select
the same HTTPS web origin and use its `/api` contract.

`dist` contains exactly 20 named public assets, `vercel.json`, and
`api/public-relay.mjs`. Use that **directory** as the reviewed preview bundle;
its `.mjs` entry is a standard Node Vercel Function. It is not a purely static
hosting artifact. Alternatively, a Git project rooted at `apps/web` needs access
to the reviewed `static` sources outside that root for its build. Never upload
the repository root, `.data`, account files or secret environment files.

`/sites/:slug` and `/forms/:slug` route through the relay. It accepts only
GET/HEAD and a single ASCII slug, calls the fixed HTTPS `fountain-api` upstream,
and never follows redirects. Only a successful upstream response explicitly
marked `X-Fountain-Format: html` with a text media type becomes HTML. JSON fields
such as `_html` cannot enable HTML. All responses disable browser/CDN caching and
use a fixed CSP and `nosniff`. Only the bounded `fountain_session` cookie and a
canonical HTTPS Origin are forwarded; there are no upstream/key request options.
The response streams with cancellation, backpressure, a 15-second total deadline
and a 16MiB byte ceiling. A stream failure after headers interrupts the body.
The relay alone sets `supportsCancellation: true` in `vercel.json`, as required
by Vercel's [cancellation API](https://vercel.com/docs/functions/functions-api-reference#enable-cancellation)
for client disconnects to reach `request.signal`. Local signal tests verify the
handler; they do not prove deployed platform disconnect delivery.

Published forms and sites currently require a family account login. A GET
document navigation that explicitly accepts `text/html` and receives upstream
401 gets an empty, no-store 303 to `/#open-public=<encoded exact page path>`.
The app can then show its normal login and return to that page after successful
authentication. The relay cancels the 401 body; it never forwards an upstream
Location, cookie or error body in this transition. HEAD, JSON/fetch requests,
non-HTML Accept headers and 403 responses keep their original error status.
Modern navigation headers must identify a document/navigation when present;
older clients without those headers still need explicit positive HTML Accept.
This transition does not grant anonymous access or bypass publication settings.

The generic `/api` rewrite excludes the relay's internal endpoint and otherwise
stays an external rewrite directly to Supabase. Raw 4MiB upload chunks, downloads,
form submissions and SSE do not pass through the Node function. The local tests
check these routing boundaries; they do not simulate Vercel's deployed router.

Before activating a hostname, add its exact HTTPS origin to
`webOrigins` in `supabase/functions/fountain-api/deployment.ts`. Set
`publicWebOrigin` to that same verified canonical origin to use it in copied
desktop/mobile document links. Its default is `null`; an API-only Supabase origin
does not provide a shareable frontend. Redeploy the function, then verify
cookie login/logout, private responses, Range and SSE through that hostname.
The canonical hostname is `https://fountain-hoonis-projects-1ccfd37e.vercel.app`.
The owner confirmed the existing Hobby/free team. Upload only this allowlisted
artifact to that existing project. The same-origin `/api` rewrite keeps opaque
HttpOnly cookies on the web hostname; native apps keep their own OS-protected
sessions. The current account-directory release still needs its own authenticated
canonical-host and five-platform evidence; prior deployments do not prove it.

The local login-return integration and Android native URL boundary are recorded
in [public frontend link verification](../../docs/research/public-frontend-links.md).
Those checks do not establish a deployed hostname or activate anonymous access.

The standalone `.mjs` handler and rewrite syntax follow the official
[Node runtime](https://vercel.com/docs/functions/runtimes/node-js) and
[rewrite configuration](https://vercel.com/docs/project-configuration/vercel-json#rewrites)
documentation. Local loopback HTTP is only a test transport; the default relay
always calls the fixed HTTPS Supabase host.

Same-account workspace navigation uses `#w/{workspaceId}/home`, `page/{id}` or
`database/{id}`. Requests capture `/api/w/{workspaceId}/{childBinding}/…` before
starting. A workspace address or retained offline hint alone grants no access.
The server validates the live account session and current membership for each
request. Ordinary A → B → A keeps pending edits under their original profile;
revoked profiles remain suspended.
