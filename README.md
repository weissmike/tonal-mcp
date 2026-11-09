# tonal-mcp

A remote [MCP](https://modelcontextprotocol.io/) server for one Tonal account on Cloudflare Workers, with
history, custom-workout editing and calendar scheduling. Derived from
[BrianVia/tonal-mcp-cloudflare-workers](https://github.com/BrianVia/tonal-mcp-cloudflare-workers) (MIT); see
[NOTICE.md](NOTICE.md).

One Worker serves a stateless Streamable-HTTP `/mcp` endpoint behind an OAuth 2.1 login
([workers-oauth-provider](https://github.com/cloudflare/workers-oauth-provider)); a Durable Object owns the Auth0
tokens, user id and a cached movement catalog. Setup: [Setup](#setup).

## Tools

| Tool | Description |
|---|---|
| `get_recent_workouts`, `list_workout_activities` | Completed workouts (volume, reps, duration, target area) |
| `get_workout_activity_details`, `get_workout_summary` | Every set of a completed workout; Tonal's formatted summary |
| `get_user_stats`, `get_muscle_readiness`, `get_strength_scores` | Lifetime stats and streak, recovery, strength by region |
| `search_movements`, `find_movement`, `list_exercises` | Exercise catalog: ranked name lookup and filtered browsing |
| `list_workouts`, `get_workout` | Your custom workouts and their sets |
| `estimate_workout_duration` | Duration of a candidate set list, without creating anything |
| `create_workout`, `update_workout`, `delete_workout` | Custom workout CRUD (update replaces the full set list; delete archives and returns a snapshot) |
| `get_schedule` | Your calendar for a date range, scheduled items with their `signup_id` |
| `schedule_workout`, `reschedule_workout`, `unschedule_workout` | Calendar CRUD (reschedule is delete + create with automatic rollback) |

Volumes are pounds. `weight_percentage` on sets is relative to your working weight and resolves on the machine.

## Setup

Prerequisites: a Cloudflare account with a domain on it, Node 22+, and `npx wrangler login` done once.

1. `npm install`, then `cp wrangler.jsonc wrangler.local.jsonc`.
2. `npx wrangler kv namespace create OAUTH_KV`; paste the id into `wrangler.local.jsonc`, and set your hostname in both
   the route and `__ORIGIN__`.
3. `npx wrangler deploy --config wrangler.local.jsonc` (a new deploy can take up to 30 seconds to be served;
   the upstream `npm run deploy` script uses POSIX env syntax and fails on Windows).
4. Secrets (each `npx wrangler secret put NAME --config wrangler.local.jsonc`): `TONAL_USERNAME`, `TONAL_PASSWORD`, and
   `MCP_BEARER`, your **owner token**: generate with `openssl rand -hex 32` and keep it private. It is the password on
   the OAuth login page and also works as a plain bearer token.
5. Check: `curl https://<host>/health`, then `OWNER_TOKEN=<token> python scripts/oauth_flow_test.py https://<host>`.

### Connect Claude

claude.ai: Settings, Connectors, Add custom connector, `https://<host>/mcp`, then paste the owner token on the login page.
Claude Code: `claude mcp add --transport http tonal https://<host>/mcp --header "Authorization: Bearer <token>"`.

## Security

Anyone with the owner token can read your Tonal data and change your workouts and calendar. Your Tonal login is stored
only as Worker secrets and sent only to Tonal's Auth0 endpoint and `api.tonal.com`.

## Develop

```sh
npm install
cp .dev.vars.example .dev.vars
npm run check      # typecheck + unit tests
```

## Caveats

- Unofficial: it uses Tonal's private API and the Auth0 password grant, so it can break when Tonal changes them.
- Tonal's calendar has no edit endpoint, so rescheduling changes the signup id. See [docs/TONAL-API.md](docs/TONAL-API.md).
- Write tools change your real account. Archiving a workout hides it; scheduling adds it to your calendar.

## Built on

This project stands on other people's work. Please star and credit them:

**Projects it is derived from or learned from**

- [BrianVia/tonal-mcp-cloudflare-workers](https://github.com/BrianVia/tonal-mcp-cloudflare-workers) (MIT): the original Worker, Auth0 session handling and read tools this is forked from.
- [frictionlesscode/tonal-mcp](https://github.com/frictionlesscode/tonal-mcp): the design and request shapes for custom-workout create, update and archive (reimplemented in TypeScript).
- [ericlitman/tonal-api](https://github.com/ericlitman/tonal-api) and [danmarai/tonal-api](https://github.com/danmarai/tonal-api): reverse-engineered Tonal API documentation and the workout payload format.
- [`@dlwiest/ts-tonal-client`](https://www.npmjs.com/package/@dlwiest/ts-tonal-client) and [dlwiest/ts-tonal-mcp](https://github.com/dlwiest/ts-tonal-mcp): the TypeScript Tonal client whose endpoint list led to the calendar API.
- Roni, the open-source AI coach for Tonal ([tonal.coach](https://www.tonal.coach/)); the copy read was [johnfagerland/exercisecoach](https://github.com/johnfagerland/exercisecoach). Its scheduling code revealed the `workout-signups` calendar calls, which I then verified against the live API.

**Libraries**

- [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider): the OAuth 2.1 server (authorization, dynamic client registration, PKCE, tokens) that makes this usable as a claude.ai connector.
- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk): the MCP TypeScript SDK.
- [Hono](https://hono.dev): the web framework used for routing.
- [Cloudflare Workers](https://developers.cloudflare.com/workers/) and [Wrangler](https://developers.cloudflare.com/workers/wrangler/): the runtime and deploy tooling.
- [zod](https://zod.dev): input validation for tool parameters.

Full license details are in [NOTICE.md](NOTICE.md).

## License

MIT. See [LICENSE](LICENSE) (original copyright Brian Via).
