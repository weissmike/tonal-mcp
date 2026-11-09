# Third-party notices

- Worker structure, Auth0 session and the read tools come from
  [BrianVia/tonal-mcp-cloudflare-workers](https://github.com/BrianVia/tonal-mcp-cloudflare-workers), Copyright (c) 2026 Brian Via (MIT).
- Custom-workout CRUD follows the behavior of [frictionlesscode/tonal-mcp](https://github.com/frictionlesscode/tonal-mcp)
  (read for behavior, reimplemented in TypeScript). Tonal API research: [ericlitman/tonal-api](https://github.com/ericlitman/tonal-api) (a fork of danmarai/tonal-api) and `@dlwiest/ts-tonal-client` and [dlwiest/ts-tonal-mcp](https://github.com/dlwiest/ts-tonal-mcp).
- The calendar scheduling calls (`workout-signups`) were found in the open-source Tonal coach app
  Roni ([tonal.coach](https://www.tonal.coach/); copy read: [johnfagerland/exercisecoach](https://github.com/johnfagerland/exercisecoach)) and then verified against the live API.
- Libraries: [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider),
  [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk), [Hono](https://hono.dev).

Changes relative to the MIT-licensed upstream (see git history): OAuth 2.1 provider layer, custom workout tools,
calendar scheduling tools, build-time origin configuration.
