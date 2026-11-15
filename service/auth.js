import LibraryClientConstants from '@thzero/library_client/constants';
import LibraryClientUtility from '@thzero/library_client/utility/index';
import LibraryCommonUtility from '@thzero/library_common/utility/index';

import BaseAuthService from '@thzero/library_client/service/auth/index';

import Constants from '../constants';

// How long before the token expires it's renewed, and how long to wait before trying again when a
// renewal couldn't reach the server.
const RENEW_BEFORE_MS = 5 * 60 * 1000;
const RETRY_MS = 60 * 1000;

// The browser's session with the app's own auth server. A sign-in (AuthProvidersService: Google,
// Steam, Discord) proves the player to the auth server, which answers with its own short-lived JWT,
// the user and a renewal key; signedIn() keeps them, in the store (the REST services send the token
// from there) and in localStorage.
// Renewal: a few minutes before the JWT expires, or on a later visit after it has, the key is
// traded for a new JWT and key (AuthProvidersService.renew, injected as SERVICE_AUTH_PROVIDERS), so
// the player stays signed in until the key goes unused for its lifetime (the auth server's, 30 days
// by default). Each key works once; tabs share the newest through localStorage, so one tab's
// renewal reaches the others. Signing out deletes the key on the server.
// Without a renewal key (an auth server that doesn't issue them), the sign-in lasts until the JWT
// expires.
// Inject it as the app's auth service. Call initialize() once the store exists, to pick up a
// sign-in from an earlier visit. Override _storageKey for the app's storage, _signInRoute for its
// sign-in page, and _setUser when the store's setUser doesn't suit the app's user.
class ServerTokenAuthService extends BaseAuthService {
	constructor() {
		super();

		this._serviceStore = null;
		this._renewing = null;
		this._timer = null;
		this._watching = false;
	}

	async init(injector) {
		await super.init(injector);

		this._serviceStore = this._injector.getService(LibraryClientConstants.InjectorKeys.SERVICE_STORE);
	}

	// Picks up a sign-in from an earlier visit: as it is while its token lasts, renewed when the
	// token has expired but the key still works.
	async initialize(correlationId) {
		this._watch();

		const saved = this._load();
		if (saved?.token && !this._expired(saved.token)) {
			await this._apply(correlationId, saved.token, saved.user);
			this._schedule(saved.token);
			return;
		}
		if (saved?.renewal && await this._renew(correlationId))
			return;

		this._save(null);
		await this._serviceUser.setAuthCompleted(correlationId, true);
	}

	async isAuthenticated() {
		const token = this.token;
		return !!token && !this._expired(token);
	}

	// Renews an expired token when it can, and signs out when it can't.
	async refreshToken(correlationId, user, forceRefresh) {
		if (!this.token || !this._expired(this.token))
			return;
		if (await this._renew(correlationId))
			return;
		await this._signOutHere(correlationId);
	}

	async signIn(correlationId) {
		LibraryClientUtility.$navRouter.push(this._signInRoute());
	}

	// A new sign-in: its token, user and renewal key (when the auth server issued one). A key from
	// an earlier sign-in in this browser is deleted on the server.
	async signedIn(correlationId, token, user, renewal = null) {
		const previous = this._load()?.renewal;
		this._save({ token, user, renewal });
		await this._apply(correlationId, token, user);
		this._schedule(token);
		if (previous && (previous !== renewal))
			this._providers()?.revoke(correlationId, previous);
	}

	async signOut(correlationId) {
		const renewal = this._load()?.renewal;
		await this._signOutHere(correlationId);
		if (renewal)
			await this._providers()?.revoke(correlationId, renewal);
	}

	async _apply(correlationId, token, user) {
		await this._serviceUser.setTokenResult(correlationId, { token });
		await this._setUser(correlationId, user);
		await this._serviceUser.setLoggedIn(correlationId, true);
		await this._serviceUser.setAuthCompleted(correlationId, true);
		await this.announceToken(correlationId, user, token);
	}

	// The token's exp in milliseconds, read without checking the signature (the auth server checks
	// it on every call); 0 when it has none or isn't a JWT.
	_expiresAt(token) {
		try {
			const payload = JSON.parse(atob(String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
			return payload.exp ? (payload.exp * 1000) : 0;
		}
		catch {
			return 0;
		}
	}

	_expired(token) {
		return this._expiresAt(token) <= Date.now();
	}

	_load() {
		try {
			return JSON.parse(localStorage.getItem(this._storageKey()) ?? 'null');
		}
		catch {
			return null;
		}
	}

	// The sign-in service, which talks to the auth server.
	_providers() {
		return this._injector?.getService(Constants.InjectorKeys.SERVICE_AUTH_PROVIDERS) ?? null;
	}

	// Trades the saved renewal key for a new token and key. Answers whether the player is signed in
	// afterwards. One renewal at a time; a tab that finds another tab already renewed takes that.
	_renew(correlationId) {
		if (!this._renewing) {
			this._renewing = this._renewOnce(correlationId).finally(() => {
				this._renewing = null;
			});
		}
		return this._renewing;
	}

	async _renewOnce(correlationId) {
		const saved = this._load();
		// Another tab renewed since this one last looked: take its sign-in.
		if (saved?.token && (saved.token !== this.token) && !this._nearExpiry(saved.token)) {
			await this._apply(correlationId, saved.token, saved.user);
			this._schedule(saved.token);
			return true;
		}
		const providers = this._providers();
		if (!saved?.renewal || !providers)
			return false;

		const response = await providers.renew(correlationId, saved.renewal);
		if (response?.success && response.results?.token) {
			const { token, user, renewal } = response.results;
			this._save({ token, user, renewal });
			await this._apply(correlationId, token, user);
			this._schedule(token);
			return true;
		}

		// Another tab may have used the key first, and saved the new one.
		const latest = this._load();
		if (latest?.renewal && (latest.renewal !== saved.renewal) && latest.token && !this._expired(latest.token)) {
			await this._apply(correlationId, latest.token, latest.user);
			this._schedule(latest.token);
			return true;
		}

		// The token still works: keep the sign-in while it lasts. Try again in a minute when the
		// server couldn't be reached; when it refused the key, the sign-in ends with the token.
		if (this.token && !this._expired(this.token)) {
			this._scheduleIn(response?.unreachable ? RETRY_MS : Math.max(0, this._expiresAt(this.token) - Date.now()));
			return true;
		}
		return false;
	}

	_nearExpiry(token) {
		return this._expiresAt(token) - Date.now() <= RENEW_BEFORE_MS;
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

	// Renews a few minutes before [token] expires, when there's a key to renew with.
	_schedule(token) {
		if (!this._load()?.renewal) {
			this._unschedule();
			return;
		}
		this._scheduleIn(Math.max(0, this._expiresAt(token) - Date.now() - RENEW_BEFORE_MS));
	}

	_scheduleIn(ms) {
		this._unschedule();
		if (typeof setTimeout === 'undefined')
			return;
		this._timer = setTimeout(async () => {
			this._timer = null;
			const correlationId = LibraryCommonUtility.correlationId();
			if (!await this._renew(correlationId) && this.token && this._expired(this.token))
				await this._signOutHere(correlationId);
		}, ms);
	}

	async _setUser(correlationId, user) {
		await this._serviceUser.setUser(correlationId, user);
	}

	_signInRoute() {
		return '/auth';
	}

	// Signs out of this browser only (the key, if any, is the caller's to delete).
	async _signOutHere(correlationId) {
		this._unschedule();
		this._save(null);
		await this._serviceUser.resetUser(correlationId);
		await this._serviceUser.setAuthCompleted(correlationId, true);
		LibraryClientUtility.$navRouter.push('/');
	}

	// Where the sign-in is kept between visits; the app's name keeps it apart.
	_storageKey() {
		return 'thzero.auth';
	}

	_unschedule() {
		if (this._timer) {
			clearTimeout(this._timer);
			this._timer = null;
		}
	}

	// Follows the other tabs: a sign-in or renewal there is taken here, and a sign-out there signs
	// this tab out too.
	_watch() {
		if (this._watching || (typeof window === 'undefined') || !window.addEventListener)
			return;
		this._watching = true;
		window.addEventListener('storage', async (event) => {
			if (event.key !== this._storageKey())
				return;
			const correlationId = LibraryCommonUtility.correlationId();
			const saved = this._load();
			if (saved?.token && !this._expired(saved.token)) {
				if (saved.token !== this.token) {
					await this._apply(correlationId, saved.token, saved.user);
					this._schedule(saved.token);
				}
				return;
			}
			if (!saved && this.token) {
				this._unschedule();
				await this._serviceUser.resetUser(correlationId);
				await this._serviceUser.setAuthCompleted(correlationId, true);
			}
		});
	}
}

export default ServerTokenAuthService;
