# QuickTrade.skin browser extension

QuickTrade connects the web application at https://app.quicktrade.skin to CS2 marketplaces through the user's browser. This snapshot contains the Chrome Manifest V3 and Firefox Manifest V2 extension, shared TypeScript contracts, and the small set of pure request builders used by the extension's tests. The server is separate.

This repository is a source snapshot of the QuickTrade.skin extension, exported from the private QuickTrade.skin monorepo for each release. It lets anyone audit what the extension does and rebuild the release archives byte for byte (see [BUILD.md](BUILD.md)).

## Permissions and data

- `storage` and `unlimitedStorage` keep scheduler rules, marketplace state and the local diagnostic journal.
- `scripting` restores the bridge in already-open application tabs after extension activation.
- `cookies` reads marketplace session data for approved requests; sensitive authentication values remain in the extension background.
- `alarms` runs scheduled work while the application tab is closed.
- `declarativeNetRequest` and `declarativeNetRequestWithHostAccess` manage request header rules. Page-supplied rules are restricted to requests initiated by this extension.
- Install-time host access covers the application, cs.money, CSFloat and Steam Community. This revision declares optional HTTPS access broadly; runtime connection requests are restricted to the bundled marketplace catalog and require a user gesture. Firefox uses `optional_permissions` for these hosts.

The toolbar button grants a pending marketplace permission or opens the application. There is no popup. Firefox requires version 140 or newer and declares authentication information and website content in its data consent metadata. Chrome requires version 101 or newer.

## Web communication

A content script accepts the application's `postMessage` messages and relays them to the background through extension runtime messaging. Production accepts the exact `https://app.quicktrade.skin` origin, excludes `/api/*`, and does not inject into marketplace pages. Development builds also permit localhost. The background validates message shape, the bundled operation allowlist and granted host permissions before sending a marketplace request. Some operations can buy, list or change prices when the user enables those features.

A signed operation table can update endpoint definitions within enforced limits. Its verification public key, the Chrome identity public key, and the Firefox add-on identifier are intentionally public. A failed or expired table falls back to bundled operations. Marketplace sessions and tokens are not build inputs.

## Build and verify

Use Node 22.17.1 and npm 10.9.2. From the repository root:

```sh
npm ci
npm test
npm run build
npm run zip
```

Both browser builds and their manifests are checked. See [BUILD.md](BUILD.md) for the precise unsigned payload comparison and AMO source instructions. [CONTRIBUTING.md](CONTRIBUTING.md) explains the test workflow; report security concerns privately as described in [SECURITY.md](SECURITY.md).

## License

Licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE). The license covers this source code only: it does not grant access to the QuickTrade.skin service or its server, and it does not grant rights to the QuickTrade names or logos (section 6 of the license).
