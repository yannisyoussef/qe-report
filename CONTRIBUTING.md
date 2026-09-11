# Contributing

This repository follows the ecosystem conventions in
[qe-ecosystem/CONTRIBUTING.md](https://github.com/yannisyoussef/qe-ecosystem/blob/develop/CONTRIBUTING.md):
Conventional Commits, `feat/`, `fix/`, and `docs/` branches off `develop`,
pull requests that state what changed, why, how it was verified, and what
it means for compatibility, and no working material in public history
(plans, prompts, agent configuration, reviews, and scratch files stay under
the ignored `local/` directory).

## Repository-specific rules

- The JSON Schema under `protocol/schema` is the source of truth. A change
  to the protocol starts there, then in the fixture corpus, then in both
  bindings. A pull request that changes one binding without the other is
  incomplete.
- The fixture corpus is the specification. Add a fixture for every new
  rule, and an invalid fixture for every new invariant, and register both
  in `protocol/fixtures/manifest.json`. Keep fixtures small and sanitised;
  never commit raw runner output.
- Redaction rules change in both SDKs together, and
  `protocol/fixtures/redaction/cases.json` is updated in the same change.
- Within compatibility line 0.1 a change may add optional properties or
  ignorable event types. Anything a consumer must understand to derive
  existing state starts a new line.
- Public API is what is not under an `internal` package (Java) or not
  exported from `src/index.ts` (TypeScript). The emitted `.d.ts` files are
  part of the TypeScript contract.
- Do not add a dependency to a published package without saying in the
  pull request why it is worth the consumer's classpath or `node_modules`.

## Checks

Every pull request must pass:

```bash
cd java && ./gradlew check
cd ts && pnpm install && pnpm check
cd java && ./gradlew :sdk:equivalenceOutput && cd ../ts && pnpm test:equivalence
```

Spotless formats Java (`./gradlew spotlessApply`); Prettier formats
TypeScript (`pnpm format`). Tests never retry.
