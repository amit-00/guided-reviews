# Contributing

Start with `npm ci`, then `npm run check` and `npm run test:browser`. Browser tests require Chrome or `npx playwright install chromium`.

Keep the CLI usable against local Git repositories without a GitHub connection. Preserve the distinction between a source-grounded explanation and an inference. Any change omitted from analysis must remain visible in the inventory. Do not carry review marks to new revisions without proving the corresponding reviewed code and context are unchanged.

Model calls belong behind `src/core/provider.ts`; deterministic collection and validation belong in `src/core`. The viewer consumes saved artifacts and does not receive credentials. Schema changes should version the artifact and define compatibility behavior.

Use temporary repositories for tests of Git behavior. Provider tests use a local fake HTTP endpoint; regular tests must not require credentials or spend model credits. A live model check should be opt-in and use a small synthetic repository.

Open an issue or pull request describing the concrete problem, resulting behavior, and relevant validation.
