# Fountain web shell

Run `node apps/web/build.mjs` from the repository root, then test with
`node --test tests/web-host.mjs`. The output contains the static application and
one presentation relay. Business functions, Auth, data and file storage remain
in Supabase. There is no database connection, service key, package installation,
or Python runtime in this web artifact. Desktop and mobile clients can select
the same HTTPS web origin and use its `/api` contract.

`dist` contains exactly 13 named public assets, `vercel.json`, and
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

The generic `/api` rewrite excludes the relay's internal endpoint and otherwise
stays an external rewrite directly to Supabase. Raw 4MiB upload chunks, downloads,
form submissions and SSE do not pass through the Node function. The local tests
check these routing boundaries; they do not simulate Vercel's deployed router.

Before activating a hostname, add its exact HTTPS origin to
`supabase/functions/fountain-api/deployment.ts`, redeploy the function, and verify
cookie login/logout, private responses, Range and SSE through that hostname.
The bundle is prepared; Vercel deployment, real hostname cookies, streaming,
HTML restoration, current Edge readiness and plan/usage eligibility still need
verification by the deployment owner. The connected team's read-only metadata
did not include its billing plan; Hobby/free status has not been established.

The standalone `.mjs` handler and rewrite syntax follow the official
[Node runtime](https://vercel.com/docs/functions/runtimes/node-js) and
[rewrite configuration](https://vercel.com/docs/project-configuration/vercel-json#rewrites)
documentation. Local loopback HTTP is only a test transport; the default relay
always calls the fixed HTTPS Supabase host.
