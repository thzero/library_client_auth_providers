![GitHub package.json version](https://img.shields.io/github/package-json/v/thzero/library_client_auth_providers)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

# library_client_auth_providers

Browser sign-in through outside providers for [@thzero/library_client](https://github.com/thzero/library_client) apps, proved to the app's own auth server, which answers with its own token.

- **Google**, through Firebase Auth: a popup, by [@thzero/library_client_firebase](https://github.com/thzero/library_client_firebase)'s `FirebaseProofService`.
- **Steam**, through OpenID 2.0: a trip to Steam's sign-in page and back to a return page in the app.
- **Discord**, through OAuth2: a trip to Discord's authorize page and back, with a `state` the return page checks.

The auth server checks each proof; [@thzero/library_server_auth_providers](https://github.com/thzero/library_server_auth_providers) has the checks. The same proofs link another sign-in to the signed-in account, and merge two accounts once the player confirms.

| Service | What it does |
| --- | --- |
| `service/index.js` (`AuthProvidersService`) | Starts a sign-in or a link, reads what a provider sent back (`takeReturn`), posts the proof to the auth server, and keeps the sign-in it answers with. |
| `service/auth.js` (`ServerTokenAuthService`) | The session: the auth server's token, in the store (the REST services send it from there) and in `localStorage` until it expires. Inject it as the app's auth service. |

## Requirements

### Installation

[![NPM](https://nodei.co/npm/@thzero/library_client_auth_providers.png?compact=true)](https://npmjs.org/package/@thzero/library_client_auth_providers)

`@thzero/library_client_firebase` is an optional peer: install it only when the app offers Google.

## Usage

Subclass both for the app's storage and server, and inject them in the services boot:

```js
import AuthProvidersService from '@thzero/library_client_auth_providers/service/index';
import ServerTokenAuthService from '@thzero/library_client_auth_providers/service/auth';

class AppAuthProvidersService extends AuthProvidersService {
	_storagePrefix() {
		return 'my-app';
	}
}

class AppAuthService extends ServerTokenAuthService {
	_storageKey() {
		return 'my-app.auth';
	}
}
```

```js
import FirebaseProofService from '@thzero/library_client_firebase/service/proof';

import AuthProvidersConstants from '@thzero/library_client_auth_providers/constants';

_initialize() {
	super._initialize();

	// Google: the Firebase library's popup, as a one-time proof.
	this._injectService(AuthProvidersConstants.InjectorKeys.SERVICE_AUTH_FIREBASE_PROOF, new FirebaseProofService());
	this._injectService(Constants.InjectorKeys.SERVICE_AUTH_PROVIDERS, new AppAuthProvidersService());
}

_initializeAuth() {
	return new AppAuthService();
}
```

Google is offered once `FirebaseProofService` is injected and `external.firebase` is filled in.

Then:

- **Sign-in page:** list `providers()`, and call `start(correlationId, id)`. Google is done when it resolves; Steam and Discord leave the page.
- **Return pages** (one each for Steam and Discord): `takeReturn(provider, route.query)` answers `{ intent, proof, cancelled }`. For `intent === 'signIn'`, call `signInWith(correlationId, proof)`; for `'link'`, call `link(correlationId, proof)`.
- **Account page:** `account()`, `startLink(correlationId, id)`, `unlink(correlationId, type, id)`, and `confirmLink(correlationId, ticket)` when `link` answers `{ status: 'conflict', ticket }`.
- Call the auth service's `initialize(correlationId)` once the store exists, to pick up a sign-in from an earlier visit.

## Configuration

The providers read the app config's `external` section; a provider is offered once its entry is filled in. Return URLs that are paths are on the address the page is served from.

```json
"external": {
	"firebase": { "apiKey": "...", "authDomain": "...", "projectId": "...", "appId": "..." },
	"steam": { "returnUrl": "/auth/steam" },
	"discord": { "clientId": "<application id>", "returnUrl": "/auth/discord" }
}
```

The auth server is the `backend` entry keyed `auth` (`_backendKey`), with its `baseUrl` and `apiKey`. Its routes default to the ones `_paths` lists (`users/steam/verify`, `users/link`, ...); override `_paths` for others.

The auth server's own config must match: Steam's `steam.returnUrl` and Discord's `discord.redirectUrl` are the full addresses of the same return pages.

## Tests

```
npm test
```

## License

[MIT](license.md)
