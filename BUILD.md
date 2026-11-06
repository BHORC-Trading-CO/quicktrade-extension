# Reproduce the unsigned store archives

Use the source snapshot and `package-lock.json` corresponding to the exact submitted version. Do not change package versions, runtime origins, signing public keys, or browser identifiers during reproduction.

## Environment

Releases are built on macOS arm64 with Node **22.17.1**, npm **10.9.2**, and the locked dependencies. CI uses GitHub-hosted Ubuntu with the same Node/npm versions. Linux reproduction must be verified by that CI before claiming cross-platform parity. npm needs network access to the public package registry; building and tests need no credentials, server, database, signing key or live marketplace access. No environment file is needed. Use a clean shell without WXT/Vite build overrides.

## Commands

Run from the snapshot root:

```sh
npm ci
npm test
npm run build
npm run zip
```

`build` prepares WXT's generated types, builds Chrome MV3 and Firefox MV2 in production mode, and verifies both manifests. `zip` repeats the builds, creates the browser archives and the Firefox source archive, and verifies the manifests again. Sources have an explicit file allowlist. The extension version is taken unchanged from `apps/extension/package.json`.

Outputs in `apps/extension/dist/`:

- `chrome-mv3/` and `firefox-mv2/`: unpacked browser payloads.
- `quicktradeskin-<version>-chrome.zip` and `quicktradeskin-<version>-firefox.zip`: unsigned store payloads.
- `quicktradeskin-<version>-sources.zip`: reviewer source snapshot, including this guide, the lockfile, tests and configs.

The shared contracts ship TypeScript source. Their test command typechecks the package and runs the extension's contract behavior suites. The full extension suite also tests those contracts. Helpers under `apps/extension/test-support/web/` are offline request builders used by tests, and are not extension entrypoints. The signed table in `test-support/operation-table.json` is a public verification fixture, not a signing key. Its freshness assertion intentionally fails after its expiry; use the exact release fixture, never re-sign during reproduction.

## Compare uncompressed bytes

Use two new empty directories and the **unsigned** archive provided by the release owner:

```sh
mkdir submitted-firefox rebuilt-firefox
unzip /absolute/path/submitted-firefox.zip -d submitted-firefox
unzip apps/extension/dist/quicktradeskin-<version>-firefox.zip -d rebuilt-firefox
diff -r submitted-firefox rebuilt-firefox
```

An empty diff with exit code 0 means every path and uncompressed byte matches. Repeat for Chrome. ZIP timestamps can differ without a payload difference. AMO signing adds files, so a store-signed download is not the comparison target.

Also extract the `sources.zip` into an empty directory outside this checkout and repeat `npm ci`, `npm test`, `npm run zip` there. Compare its browser archives with the original unsigned uploads. Supply this source archive for every submitted version. Mozilla requires matching source, a lockfile and clear build instructions for bundled code: [source code submission](https://extensionworkshop.com/documentation/publish/source-code-submission/).
