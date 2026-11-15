import LibraryClientConstants from '@thzero/library_client/constants';

import Service from '@thzero/library_client/service/index';

import Constants from '../constants';

const DISCORD_AUTHORIZE = 'https://discord.com/oauth2/authorize';
const OPENID_NS = 'http://specs.openid.net/auth/2.0';
const OPENID_SELECT = 'http://specs.openid.net/auth/2.0/identifier_select';
const STEAM_LOGIN = 'https://steamcommunity.com/openid/login';

const MISMATCH = 'The sign-in answer is missing, or isn\'t the one this browser asked for.';

// Sign-in through outside providers, proved to the app's own auth server, which answers with its
// own token: Google through Firebase Auth (a popup, by @thzero/library_client_firebase's
// FirebaseProofService, injected as SERVICE_AUTH_FIREBASE_PROOF), Steam through OpenID 2.0 and Discord through
// OAuth2 (each a trip to the provider's page and back to a return page in the app). The auth
// server checks each proof; @thzero/library_server_auth_providers has the checks.
// A provider is offered once its config under "external" (firebase, steam, discord) is filled in,
// and for Google, once FirebaseProofService is injected.
// The same proofs link another sign-in to the signed-in account, and when that sign-in already has
// its own account, merge the two once the player confirms.
// The session itself (the auth server's token) is ServerTokenAuthService (service/auth.js),
// injected as the app's auth service.
// Override _backendKey, _paths and _storagePrefix for the app's auth server and storage.
class AuthProvidersService extends Service {
	constructor() {
		super();

		this._serviceFirebaseProof = null;
	}

	async init(injector) {
		await super.init(injector);

		this._serviceFirebaseProof = this._injector.getService(Constants.InjectorKeys.SERVICE_AUTH_FIREBASE_PROOF);
	}

	// The sign-in choices. A page that shows them is about to be clicked, so Google's Firebase starts
	// loading here (FirebaseProofService.preload): its popup has to open right after the click.
	providers() {
		const external = this._external();
		const google = !!(this._serviceFirebaseProof && external.firebase?.apiKey);
		if (google)
			this._serviceFirebaseProof.preload?.();
		return [
			{ id: 'google', type: 'firebase', available: google },
			{ id: 'steam', type: 'steam', available: !!external.steam?.returnUrl },
			{ id: 'discord', type: 'discord', available: !!(external.discord?.clientId && external.discord?.returnUrl) }
		];
	}

	// Starts sign-in through [id]. Steam and Discord leave the page (they come back to their return
	// page); Google signs in through a popup and is done when this resolves.
	async start(correlationId, id) {
		if (id === 'google') {
			const proof = await this._googleProof(correlationId);
			if (!proof.success)
				return proof;
			return await this._signInWith(correlationId, 'start', this._paths().firebase, { idToken: proof.results });
		}
		if (id === 'steam')
			return this._startSteam(correlationId, 'signIn');
		if (id === 'discord')
			return this._startDiscord(correlationId, 'signIn');
		return this._error('AuthProvidersService', 'start', `Sign-in through ${id} isn't built yet.`, null, null, null, correlationId);
	}

	// What a provider ([provider]: 'steam' or 'discord') sent the player back with, on the return
	// page ([query]): { intent ('signIn' or 'link'), proof (for signInWith or link), cancelled }.
	// The trip is read once. Discord's answer must carry the state this browser sent it with.
	takeReturn(provider, query) {
		let trip = null;
		try {
			trip = JSON.parse(sessionStorage.getItem(this._tripKey()) ?? 'null');
			sessionStorage.removeItem(this._tripKey());
		}
		catch {
			trip = null;
		}
		const intent = (trip?.provider === provider) ? trip.intent : 'signIn';

		if (provider === 'steam') {
			const params = Object.fromEntries(Object.entries(query).filter(([ key ]) => key.startsWith('openid.')));
			if (params['openid.mode'] !== 'id_res')
				return { intent, proof: null, cancelled: true };
			return { intent, proof: { type: 'steam', params }, cancelled: false };
		}

		if (provider === 'discord') {
			if (query.error || !query.code)
				return { intent, proof: null, cancelled: true };
			if ((trip?.provider !== 'discord') || !trip.state || (query.state !== trip.state))
				return { intent, proof: null, cancelled: false };
			return { intent, proof: { type: 'discord', code: String(query.code) }, cancelled: false };
		}

		return { intent, proof: null, cancelled: false };
	}

	// Signs in with a provider's proof ({ type: 'steam', params } or { type: 'discord', code }):
	// the auth server checks it and answers the sign-in, which is kept.
	async signInWith(correlationId, proof) {
		if (proof?.type === 'steam')
			return await this._signInWith(correlationId, 'signInWith', this._paths().steam, { params: proof.params });
		if (proof?.type === 'discord')
			return await this._signInWith(correlationId, 'signInWith', this._paths().discord, { code: proof.code });
		return this._error('AuthProvidersService', 'signInWith', MISMATCH, null, null, null, correlationId);
	}

	// The signed-in account, as the auth server describes it (its sign-ins).
	async account(correlationId) {
		return await this._post(correlationId, 'account', this._paths().account, {}, true);
	}

	// Links Google (a popup), Steam or Discord (a trip to their page, finished by link() on the
	// return page) to the signed-in account. Answers like link().
	async startLink(correlationId, id) {
		if (id === 'google') {
			const proof = await this._googleProof(correlationId);
			if (!proof.success)
				return proof;
			return await this._link(correlationId, { type: 'firebase', idToken: proof.results });
		}
		if (id === 'steam')
			return this._startSteam(correlationId, 'link');
		if (id === 'discord')
			return this._startDiscord(correlationId, 'link');
		return this._error('AuthProvidersService', 'startLink', `Linking ${id} isn't built yet.`, null, null, null, correlationId);
	}

	// Links a provider's proof (from takeReturn) to the signed-in account. Answers the auth server's
	// results: { status: 'linked', ... }, or { status: 'conflict', ticket, ... } when the sign-in
	// has its own account (confirmLink merges them).
	async link(correlationId, proof) {
		if (!proof)
			return this._error('AuthProvidersService', 'link', MISMATCH, null, null, null, correlationId);
		return await this._link(correlationId, proof);
	}

	// Merges the account a link found ([ticket]) with the signed-in one, and signs in to the
	// account that's kept.
	async confirmLink(correlationId, ticket) {
		return await this._signInWith(correlationId, 'confirmLink', this._paths().linkConfirm, { ticket }, true);
	}

	async unlink(correlationId, type, id) {
		return await this._post(correlationId, 'unlink', this._paths().unlink, { type, id }, true);
	}

	// The backend config entry for the auth server.
	// Trades a renewal key for a new sign-in: { token, user, renewal, renewalExpiresAt }. The
	// answer is marked unreachable when the auth server couldn't be reached (ServerTokenAuthService
	// tries again then).
	async renew(correlationId, renewal) {
		return await this._post(correlationId, 'renew', this._paths().renew, { renewal });
	}

	// Deletes a renewal key on the auth server, on sign-out. Best effort: signing out of the browser
	// doesn't wait on it.
	async revoke(correlationId, renewal) {
		return await this._post(correlationId, 'revoke', this._paths().signOut, { renewal });
	}

	_backendKey() {
		return 'auth';
	}

	_external() {
		return this._config.getExternal() ?? {};
	}

	// The Firebase ID token from a Google popup (FirebaseProofService). Closing the popup answers
	// an error with no message.
	async _googleProof(correlationId) {
		if (!this._serviceFirebaseProof)
			return this._error('AuthProvidersService', '_googleProof', 'Google sign-in needs @thzero/library_client_firebase\'s FirebaseProofService.', null, null, null, correlationId);
		return await this._serviceFirebaseProof.idToken(correlationId);
	}

	async _link(correlationId, proof) {
		return await this._post(correlationId, '_link', this._paths().link, proof, true);
	}

	// The auth server's routes, relative to its backend baseUrl.
	_paths() {
		return {
			account: 'users/account',
			discord: 'users/discord/verify',
			firebase: 'users/firebase/verify',
			link: 'users/link',
			linkConfirm: 'users/link/confirm',
			renew: 'users/renew',
			signOut: 'users/signOut',
			steam: 'users/steam/verify',
			unlink: 'users/unlink'
		};
	}

	// Posts to the auth server ([signedIn]: with the session's token) and answers its results.
	// Straight through fetch, not the REST service, so the reason the server refused with always
	// reaches the player.
	async _post(correlationId, method, url, body, signedIn) {
		const config = this._config.getBackend(correlationId, this._backendKey());
		if (!config?.baseUrl)
			return this._error('AuthProvidersService', method, `No sign-in server is configured (the "${this._backendKey()}" backend).`, null, null, null, correlationId);

		let response;
		try {
			const baseUrl = config.baseUrl.endsWith('/') ? config.baseUrl : `${config.baseUrl}/`;
			const headers = {
				'Content-Type': 'application/json',
				[LibraryClientConstants.Headers.CorrelationId]: correlationId
			};
			if (config.apiKey)
				headers[LibraryClientConstants.Headers.AuthKeys.API] = config.apiKey;
			if (signedIn) {
				const serviceAuth = this._injector.getService(LibraryClientConstants.InjectorKeys.SERVICE_AUTH);
				if (!serviceAuth?.token)
					return this._error('AuthProvidersService', method, 'Sign in first.', null, null, null, correlationId);
				headers.Authorization = `Bearer ${serviceAuth.token}`;
			}
			response = await fetch(`${baseUrl}${url}`, {
				method: 'POST',
				headers,
				body: JSON.stringify(body)
			});
		}
		catch (err) {
			const unreachable = this._error('AuthProvidersService', method, `Couldn't reach the sign-in server at ${config.baseUrl}.`, err, null, null, correlationId);
			unreachable.unreachable = true;
			return unreachable;
		}

		const answer = await response.json().catch(() => null);
		if (!response.ok || !answer?.success) {
			const reason = answer?.message ?? (response.status === 401 ? 'The sign-in server refused the request (check the API key, or sign in again).' : `The sign-in server answered ${response.status}.`);
			return this._error('AuthProvidersService', method, reason, null, null, null, correlationId);
		}
		return this._successResponse(answer.results, correlationId);
	}

	_saveTrip(provider, intent, state) {
		try {
			sessionStorage.setItem(this._tripKey(), JSON.stringify({ provider, intent, state }));
			return true;
		}
		catch {
			return false;
		}
	}

	// Posts a sign-in proof and keeps the sign-in the auth server answers with ({ token, user }).
	async _signInWith(correlationId, method, url, body, signedIn) {
		const response = await this._post(correlationId, method, url, body, signedIn);
		if (!response.success)
			return response;
		if (!response.results?.token)
			return this._error('AuthProvidersService', method, 'The sign-in server answered without a sign-in.', null, null, null, correlationId);

		const serviceAuth = this._injector.getService(LibraryClientConstants.InjectorKeys.SERVICE_AUTH);
		await serviceAuth.signedIn(correlationId, response.results.token, response.results.user, response.results.renewal ?? null);
		return this._success(correlationId);
	}

	// Sends the player to Discord's authorize page (the identify scope: their user id and name), to
	// sign in or to link ([intent]). Discord returns them to returnUrl, the app's return page, with
	// a code the auth server exchanges using the application's secret, and the state sent here,
	// which the return page checks (takeReturn).
	_startDiscord(correlationId, intent) {
		const discord = this._external().discord;
		if (!discord?.clientId || !discord?.returnUrl)
			return this._error('AuthProvidersService', '_startDiscord', 'No external.discord clientId and returnUrl in the config.', null, null, null, correlationId);
		const returnUrl = new URL(discord.returnUrl, window.location.origin).toString();

		const state = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
		if (!this._saveTrip('discord', intent, state))
			return this._error('AuthProvidersService', '_startDiscord', 'This browser won\'t keep the sign-in while Discord asks you (storage is blocked).', null, null, null, correlationId);

		const url = new URL(DISCORD_AUTHORIZE);
		url.searchParams.set('client_id', discord.clientId);
		url.searchParams.set('response_type', 'code');
		url.searchParams.set('redirect_uri', returnUrl);
		url.searchParams.set('scope', 'identify');
		url.searchParams.set('state', state);
		window.location.assign(url.toString());
		return this._success(correlationId);
	}

	// Sends the player to Steam's own sign-in page, to sign in or to link ([intent]). Steam returns
	// them to returnUrl, the app's return page, which hands the answer to the auth server, which
	// checks it with Steam. The return goes to the app, not the auth server, because a redirect
	// can't carry the auth server's API key. A returnUrl that is a path ("/auth/steam") is on the
	// address the page is served from.
	_startSteam(correlationId, intent) {
		const configured = this._external().steam?.returnUrl;
		if (!configured)
			return this._error('AuthProvidersService', '_startSteam', 'No external.steam.returnUrl in the config.', null, null, null, correlationId);
		const returnUrl = new URL(configured, window.location.origin).toString();

		if (!this._saveTrip('steam', intent, null) && (intent === 'link'))
			return this._error('AuthProvidersService', '_startSteam', 'This browser won\'t keep the link while Steam signs you in (storage is blocked).', null, null, null, correlationId);

		const url = new URL(STEAM_LOGIN);
		url.searchParams.set('openid.ns', OPENID_NS);
		url.searchParams.set('openid.mode', 'checkid_setup');
		url.searchParams.set('openid.return_to', returnUrl);
		url.searchParams.set('openid.realm', new URL(returnUrl).origin);
		url.searchParams.set('openid.identity', OPENID_SELECT);
		url.searchParams.set('openid.claimed_id', OPENID_SELECT);
		window.location.assign(url.toString());
		return this._success(correlationId);
	}

	// The prefix of this service's sessionStorage keys; the app's name keeps them apart.
	_storagePrefix() {
		return 'thzero';
	}

	_tripKey() {
		return `${this._storagePrefix()}.signInTrip`;
	}
}

export default AuthProvidersService;
