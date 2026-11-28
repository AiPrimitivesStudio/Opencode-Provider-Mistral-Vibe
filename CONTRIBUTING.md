# Contributing

Thanks for improving the Mistral Vibe provider for OpenCode. Contributions
are **fork-based**: fork the repository, work on a branch in your fork, and
open a pull request against `main`.

## Fork workflow

```sh
# 1. Fork AiPrimitivesStudio/Opencode-Provider-Mistral-Vibe on GitHub, then:
git clone https://github.com/<your-account>/Opencode-Provider-Mistral-Vibe.git
cd Opencode-Provider-Mistral-Vibe
git switch -c <type>-<short-description>   # e.g. ci-template-check

# 2. Develop (setup below), commit following the message template,
#    and run the offline gates before pushing.

# 3. Push your branch to your fork and open the PR:
git push -u origin <type>-<short-description>
#    PR target: AiPrimitivesStudio/Opencode-Provider-Mistral-Vibe:main
```

CI runs on every pull request. For a first-time outside contributor the
workflow run needs a one-time maintainer approval (GitHub's fork-PR policy) -
that is normal, nothing you need to do.

## Setup (inside your fork)

```sh
cd Opencode-Provider-Mistral-Vibe/package
npm install
```

Requirements: Node.js 22+ and Python 3.12+ on your PATH. No Vibe login, no
API keys, and no Mistral account are needed - the offline test suite is fully
self-contained.

## The gates your PR must pass

CI runs these on every pull request, and they are the same commands locally:

```sh
npm run format:check  # formatting gate (prettier; npm run format fixes)
npm run typecheck      # tsc --noEmit
npm run test:unit      # offline unit suite, no API spend
npm run coverage:unit  # c8 gate: >= 85% lines AND >= 85% branches
ruff check .           # Python lint (pip install ruff; config in ruff.toml)
npm run lint           # JS/TS lint (eslint; config in eslint.config.mjs)
```

All six are expected green before review.

The token-spending suites (`npm run test:e2e`, `npm run coverage`) hit the real
Mistral API through the real Vibe plan and are **not** run in CI and are not
required from contributors - the maintainer runs them before releasing.

## Ground rules

- **Test first.** Every behavior change lands with a failing test made green
  by the change. The suite is offline and fast; there is no excuse.
- **Never mask errors.** Any error the user sees must carry its real cause
  (HTTP status, quota, auth, network). Do not replace error text with generic
  "run setup" hints - the existing tests guard this and your PR should add
  to them, not relax them.
- **Do not weaken the coverage gate.** Below 85% lines or branches, add tests
  instead.
- **Keep the plugin self-contained.** Runtime bootstrap, credential handling
  and billing metadata are guarded invariants
  (`call_source = "vibe_code"`, forced OIDC flag, redaction); changes there
  need explicit tests proving the invariant still holds.

## Commit message template

This repository releases continuously: every merge to `main` cuts a
[semantic version](https://semver.org/) release from your commit message.
Every commit in a pull request follows this template - CI rejects commits
that deviate from it:

```
<type>(<scope>)?: <subject>

Optional body: the why behind the change, wrapped at 100 characters.

Changes:
- <type>(<scope>)?: <what was done> (SEMVER_PATCH)
- <type>(<scope>)?: <another unit of work in this commit> (SEMVER_MINOR)
```

A commit can bundle several units of work - list **every** item you
performed, each with its own type and token, so nothing is hidden and the
significance of each piece is stated, not laundered into the subject.

### Subject line

Names the dominant change.

- `<type>` (required, lowercase): `feat`, `fix`, `chore`, `docs`, `test`,
  `refactor`, `perf`, `ci`, `build`, `style`
- `<scope>` (optional, lowercase with `-` and `.`): the area, e.g. `bridge`,
  `runtime`, `ci`
- `<subject>` (required): imperative mood ("add", not "added"), no trailing
  period, at most **72 characters**

### Changes list (required)

One line per unit of performed work:

- starts with `- `, then `<type>(<scope>)?: <what was done>`
- ends with ` (SEMVER_...)` - exactly one token per line:

| Token in the changes line | Release it declares |
|---------------------------|---------------------|
| `SEMVER_MAJOR`            | a major release     |
| `SEMVER_MINOR`            | a minor release     |
| `SEMVER_PATCH`            | a patch release     |

Rules:

- The commit's bump is the **highest** token among its items; the release
  takes the highest across the commits being released.
- Tokens **only count inside changes lines** - prose is ignored, and a
  standalone token line is rejected, so intent is never silently dropped.
- Type prefixes are a readability convention only - the token alone decides
  the bump. `BREAKING CHANGE` footers have no versioning effect.

### Pull requests

Squash-merging is the default, so your PR title becomes the subject line:
put the changes list at the end of the PR description.

### Worked example

```
feat: runtime bootstrap and honest login hints

On a machine with no compatible Vibe the plugin now installs its own
pinned runtime in the background; login messages name the exact binary.

Changes:
- feat(runtime): auto-install the pinned runtime when nothing compatible exists (SEMVER_MINOR)
- fix(ci): make launcher-discovery tests 8.3-short-path safe (SEMVER_PATCH)
- docs(readme): document the runtime resolution order (SEMVER_PATCH)
```
