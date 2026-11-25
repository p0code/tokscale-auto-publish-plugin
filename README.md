# Tokscale auto-publish (p0code plugin)

An off-by-default [p0code](https://github.com/p0code/p0code) server plugin that publishes your AI token and cost totals to [Tokscale](https://tokscale.ai), the public usage leaderboard, on a schedule. It sends the numbers p0code already shows on its Usage page, so you don't need to run the `tokscale` CLI.

Unofficial: not made or endorsed by Tokscale.

> **Needs a p0code host change first.** Plugins can't read usage yet. This plugin is written against the `usage:read` API described in [docs/HOST_API.md](docs/HOST_API.md) and won't start until p0code adds it.

## Setup

1. Turn it on under **Settings → Plugins → Tokscale auto-publish**.
2. Sign in: **Sign in to Tokscale** shows a code; approve it at `tokscale.ai/device` with your GitHub account. You can also paste an API token (`tt_…`) made at [tokscale.ai/settings](https://tokscale.ai/settings).
3. Select **Preview what is sent**. You'll see every day and model that would be sent, and the exact request body.
4. Turn on **Publish automatically** (daily by default, or hourly), or select **Publish now**.

The token is stored in p0code's secret store and the panel never shows it again. Signing out deletes it and turns automatic publishing off.

## Privacy

**What is sent**, to `https://tokscale.ai/api/submit` only, per day and per model:

- the date (in your time zone) and the model name, such as `claude-opus-5-5`
- the agent it came from, as a Tokscale client id (`claude`, `codex`, `cursor`, `opencode`, `grok`, `antigravity`, `pi`)
- input, output, cache read, cache write and reasoning token counts
- cost in USD and the number of messages
- an anonymous device id (a hash of the p0code environment id) and the device name `p0code`

**What is never sent:** prompts, replies, code, diffs, thread titles, project names, file paths, your hostname or your username. The plugin never receives them: p0code's `usage:read` API only hands it the numbers above.

Tokscale shows what you publish on a public profile. To remove it, delete your submitted data at [tokscale.ai/settings](https://tokscale.ai/settings).

Usage from agents Tokscale doesn't support (Muse) isn't sent, and the preview lists it as skipped.

## How publishing works

- Each publish reads the last 30 days of usage from p0code and folds it into one entry per day, agent and model.
- Only days that changed since the last successful publish are sent. A local ledger remembers what was sent for each day, so unchanged days are never sent again.
- Resending a day doesn't add to it either: Tokscale stores each device's numbers per day and agent and replaces them on every submit.
- Today is sent while it's still in progress and sent again as it grows.
- A failed publish shows its error in the panel and retries after 30 minutes. If Tokscale rejects the token, the plugin forgets it and asks you to sign in again.

**Don't also run `tokscale submit` on the same machine.** The CLI reads the same Claude Code and Codex logs under its own device id, and Tokscale adds devices together, so that usage would be counted twice.

## Tokscale API used

All of this is from [junhoyeo/tokscale](https://github.com/junhoyeo/tokscale), the source for tokscale.ai:

| Call | Purpose |
| --- | --- |
| `POST /api/auth/device` `{ deviceName }` | Starts the device sign-in. Returns `deviceCode`, `userCode`, `verificationUrl`, `expiresIn`, `interval` |
| `POST /api/auth/device/poll` `{ deviceCode }` | Returns `pending`, `expired`, or `complete` with an API token (`tt_…`) and username |
| `POST /api/submit` with `Authorization: Bearer tt_…` | Takes the same JSON the CLI sends (`meta`, `device`, `summary`, `years`, `contributions[]`, each day with per-model `clients[]`) |

[src/payload.ts](src/payload.ts) builds that body. It passes Tokscale's own `validateSubmission` checks.

## Development

The repository ([p0code/tokscale-auto-publish-plugin](https://github.com/p0code/tokscale-auto-publish-plugin)) is meant to be mounted as the `plugins/tokscale-auto-publish` git submodule of p0code and built inside that workspace, where it imports `@t3tools/plugin-api` and `effect`:

```sh
pnpm --filter @t3tools/plugin-tokscale-auto-publish typecheck
pnpm --filter @t3tools/plugin-tokscale-auto-publish test
```

To work on it without a p0code checkout, use `standalone/`. It has its own vitest, TypeScript and effect, plus test-only stand-ins for `@t3tools/plugin-api` and `@t3tools/contracts` that already include `usage:read`:

```sh
cd standalone
pnpm install
pnpm test
pnpm typecheck
```

| Path | What it is |
| --- | --- |
| `src/aggregate.ts` | Host usage rows to per-day, per-model Tokscale entries |
| `src/payload.ts` | The `/api/submit` body |
| `src/ledger.ts` | What was already published, per day |
| `src/schedule.ts` | When a publish is due, local days, the 30-day window |
| `src/publisher.ts` | Sign-in, storage, HTTP and the schedule loop |
| `src/actions.ts` | Action schemas the settings panel calls |
| `web/TokscalePanel.tsx` | Draft settings panel for `apps/web` |
| `docs/HOST_API.md` | The `usage:read` API p0code needs to add |

## License

MIT. See [LICENSE](LICENSE).
