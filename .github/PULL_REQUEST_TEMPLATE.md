## What does this PR change?

<!-- One or two sentences: the problem and the fix. -->

## How is it tested?

<!-- Every behavior change needs a test that fails without it. -->

- [ ] New/updated tests included; `npm run test:unit`, `npm run typecheck` and
      `npm run coverage:unit` (>= 85% lines AND branches) pass locally

## Checklist

- [ ] Behavior change is test-first (failing test made green by this PR)
- [ ] The commit lists its work as changes lines, one token per unit of
      work; the highest token matches the intended release significance
- [ ] No error masking: user-visible errors keep their real cause
- [ ] Guarded invariants untouched or explicitly re-tested (billing metadata
      `vibe_code`, forced OIDC flag, redaction, never-dump prompts)
- [ ] Docs updated if setup, commands or behavior changed
