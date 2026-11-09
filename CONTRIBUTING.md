# Contributing to TaskSparkle

TaskSparkle has one maintainer and is looked after on a best-effort basis. Contributions are welcome, in the shape this page describes. Reading it first saves everyone a round trip.

## Issues

Issues are where conversation happens — there is no discussion board.

A good bug report names:

- which way you run TaskSparkle: Cloudflare hosted or self-hosted;
- the release version, or the build stamp (`GET /api/v1/version` with an agent key answers it, and the directions in Settings → Set Up Agent carry it);
- the steps that make the problem happen, in order;
- what you expected and what happened instead.

Feature ideas are welcome as issues too. Say the problem first and the shape you imagine second.

## Small fixes

Small, focused fixes are welcome as pull requests. Before sending one:

- Run the checks: `npm test` runs the self-host drills end to end against a throwaway instance it starts itself. `npm run test:ui` adds the browser drill and needs the Playwright setup in `tests/README.md`.
- A bug fix starts with a test that fails without the fix. The drills in `tests/` are where tests live; `tests/README.md` explains each one.
- Keep one change per pull request. A pull request that fixes one thing gets read quickly; one that fixes five waits.

Pull requests get the light checks in GitHub (syntax, the build-stamp agreement and the smoke tier) before anyone reads the code. The drills are not among them: they are yours to run before you push, as above.

## Bigger work

Anything larger than a small fix starts as an issue conversation, not a pull request. The roadmap is the maintainer's, and a large pull request that arrives unannounced may be declined even when the code is good — not from ingratitude, but because every feature here is one the maintainer then supports. Talk first and the work has a home before it is written.

## Style

The codebase has a particular style and a change should match the code around it:

- Plain words, in the code comments and the user-facing text alike. Comments are written for a stranger reading the file cold.
- No Oxford commas. This is a house rule and it is applied consistently, so please match it.
- No new dependencies. The project runs on the Node and Cloudflare standard libraries only, and that is a deliberate part of the design.
- Edits save themselves in the app, tests come first for fixes, and a change is not done until the drills pass with it.

## How a change lands

The maintainer reviews pull requests, merges to `main`, and `main` is what deploys. Releases are numbered `vMAJOR.MINOR.PATCH`, tagged in git and published as GitHub releases; `CHANGELOG.md` records what each one carries. Inside a release the app stamps every deploy with a build stamp (`rYYYY-MM-DD-N`), so a bug report that names the release and the build stamp pins the code exactly.

## Conduct and security

`CODE_OF_CONDUCT.md` states the behaviour expected here, in short plain words.

A security problem is never a public issue. `SECURITY.md` gives the private reporting route.
