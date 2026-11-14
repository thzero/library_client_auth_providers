import LibraryClientConstants from '@thzero/library_client/constants';
import LibraryClientUtility from '@thzero/library_client/utility/index';

import BaseAuthService from '@thzero/library_client/service/auth/index';

// The browser's session with the app's own auth server. A sign-in (AuthProvidersService: Google,
// Steam, Discord) proves the player to the auth server, which answers with its own JWT and the
// user; signedIn() keeps both, in the store (the REST services send the token from there) and in
// localStorage until the JWT expires. The JWT can't be refreshed: once it expires, the player
// signs in again.
// Inject it as the app's auth service. Call initialize() once the store exists, to pick up a
// sign-in from an earlier visit. Override _storageKey for the app's storage, _signInRoute for its
// sign-in page, and _setUser when the store's setUser doesn't suit the app's user.
class ServerTokenAuthService extends BaseAuthService {
	constructor() {
		super();

		this._serviceStore = null;
	}

	async init(injector) {
		await super.init(injector);

		this._serviceStore = this._injector.getService(LibraryClientConstants.InjectorKeys.SERVICE_STORE);
	}

	// Picks up a sign-in from an earlier visit, if it hasn't expired.
	async initialize(correlationId) {
		const saved = this._load();
		if (saved && !this._expired(saved.token))
			await this._apply(correlationId, saved.token, saved.user);
		else {
			this._save(null);
			await this._serviceUser.setAuthCompleted(correlationId, true);
		}
	}

	async isAuthenticated() {
		const token = this.token;
		return !!token && !this._expired(token);
	}

	async refreshToken(correlationId, user, forceRefresh) {
		if (this.token && this._expired(this.token))
			await this.signOut(correlationId);
	}

	async signIn(correlationId) {
		LibraryClientUtility.$navRouter.push(this._signInRoute());
	}

	async signedIn(correlationId, token, user) {
		this._save({ token, user });
		await this._apply(correlationId, token, user);
	}

	async signOut(correlationId) {
		this._save(null);
		await this._serviceUser.resetUser(correlationId);
		await this._serviceUser.setAuthCompleted(correlationId, true);
		LibraryClientUtility.$navRouter.push('/');
	}

	async _apply(correlationId, token, user) {
		await this._serviceUser.setTokenResult(correlationId, { token });
		await this._setUser(correlationId, user);
		await this._serviceUser.setLoggedIn(correlationId, true);
		await this._serviceUser.setAuthCompleted(correlationId, true);
		await this.announceToken(correlationId, user, token);
	}

	// The JWT's exp, read without checking the signature; the auth server checks it on every call.
	_expired(token) {
		try {
			const payload = JSON.parse(atob(String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
			return !payload.exp || ((payload.exp * 1000) <= Date.now());
		}
		catch {
			return true;
		}
	}

	_load() {
		try {
			return JSON.parse(localStorage.getItem(this._storageKey()) ?? 'null');
		}
		catch {
			return null;
		}
	}

	_save(value) {
		try {
			if (value)
				localStorage.setItem(this._storageKey(), JSON.stringify(value));
			else
				localStorage.removeItem(this._storageKey());
		}
		catch {
			// Private windows can refuse storage; the sign-in still lasts for this visit.
		}
	}

	async _setUser(correlationId, user) {
		await this._serviceUser.setUser(correlationId, user);
	}

	_signInRoute() {
		return '/auth';
	}

	// Where the sign-in is kept between visits; the app's name keeps it apart.
	_storageKey() {
		return 'thzero.auth';
	}
}

export default ServerTokenAuthService;
