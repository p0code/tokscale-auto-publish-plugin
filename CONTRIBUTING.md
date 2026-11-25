# Contributing

This is the Tokscale auto-publish plugin for [p0code](https://github.com/p0code/p0code): it sends
the usage numbers p0code already shows to Tokscale on a schedule.

Contributions are welcome. Bug reports and small, focused PRs are the best kind. I'm one person and
this is a side project, so reviews and replies can take a while — please be patient, and don't ping
repeatedly. If it's been a couple of weeks, one polite bump is fine.

## Setup

The plugin normally builds inside a p0code checkout (it depends on `@t3tools/plugin-api` and
`@t3tools/contracts` through the workspace). There's also a `standalone/` setup with its own test
harness for when you don't have a p0code checkout:

```sh
cd standalone
pnpm install
pnpm test
pnpm typecheck
```

Inside a p0code checkout, run `pnpm typecheck` and `pnpm test` from the repo root, or filter to this
package with `pnpm --filter @t3tools/plugin-tokscale-auto-publish typecheck`.

## What makes a PR easy to land

- One thing per PR. Don't mix a fix with a refactor.
- Tests for behaviour changes. The `standalone/` suite is fine for parsing, aggregation and payload
  logic; host-facing bits need the p0code workspace.
- Conventional-commit-ish messages (`fix: ...`, `feat: ...`, `docs: ...`).
- No drive-by refactors or reformatting of files you didn't need to touch.

## License

MIT. By contributing you agree that your work is released under the MIT license. See
[LICENSE](LICENSE).
