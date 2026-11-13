# Contributing

This repository is licensed under the [Functional Source License 1.1, Apache 2.0 Future License](LICENSE) (FSL-1.1-ALv2). By submitting a contribution you agree that it is licensed under the same terms, and that BHORC may also release it under the Apache License 2.0. Releases are exported from a private monorepo, so an accepted change is applied there first and appears here with the next exported snapshot.

Use Node 22.17.1 and npm 10.9.2, then run `npm ci` at the repository root. For behavior changes, write a failing test first, make the smallest change that passes it, and run:

```sh
npm test
npm exec --workspace=apps/extension -- tsc --noEmit
npm exec --workspace=apps/extension -- eslint .
npm exec -- oxlint apps/extension packages/contracts/src
npm run build
npm run zip
```

Keep the extension/contracts boundary independent of server implementation details. Preserve exact-origin bridge checks, operation allowlists, permission gating, signed-table validation and money-path guards. Use offline fixtures and mocks; tests must not contact marketplaces. Add no credentials, private endpoints, personal metadata or generated output to source.

Keep all 13 manifest locale files consistent when changing user-facing wording. Describe the problem, the behavior after the change, and the tests run. Changes to host permissions or operation policy require the corresponding manifest and policy tests. See [BUILD.md](BUILD.md) for reproducibility and [SECURITY.md](SECURITY.md) for private vulnerability reporting.
