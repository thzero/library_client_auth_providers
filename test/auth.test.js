import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import LibraryClientUtility from '@thzero/library_client/utility/index';

import Constants from '../constants';
import ServerTokenAuthService from '../service/auth';
import { installBrowser, removeBrowser, token } from './browser';

let service;
let user;
const now = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
	installBrowser();
	LibraryClientUtility.$navRouter = { push: vi.fn() };
	user = {
		token: null,
		resetUser: vi.fn(async () => { user.token = null; }),
		setAuthCompleted: vi.fn(),
		setLoggedIn: vi.fn(),
		setTokenResult: vi.fn(async (correlationId, result) => { user.token = result.token; }),
		setUser: vi.fn()
	};
	service = new ServerTokenAuthService();
	service._serviceUser = user;
	service._serviceEvent = { emit: vi.fn() };
	Object.defineProperty(service, 'token', { get: () => user.token });
});

afterEach(() => {
	service._unschedule();
	vi.useRealTimers();
	removeBrowser();
});

describe('ServerTokenAuthService', () => {
	it('keeps a sign-in and picks it up on the next visit', async () => {
		const jwt = token({ userId: 'u', exp: now() + 3600 });
		await service.signedIn('c', jwt, { id: 'u' });
		expect(user.setUser).toHaveBeenCalledWith('c', { id: 'u' });
		expect(user.setLoggedIn).toHaveBeenCalledWith('c', true);

		const next = new ServerTokenAuthService();
		next._serviceUser = { ...user, setUser: vi.fn(), setTokenResult: vi.fn() };
		next._serviceEvent = { emit: vi.fn() };
		await next.initialize('c');
		expect(next._serviceUser.setTokenResult).toHaveBeenCalledWith('c', { token: jwt });
	});

	it('drops an expired sign-in instead of picking it up', async () => {
		localStorage.setItem('thzero.auth', JSON.stringify({ token: token({ exp: now() - 10 }), user: { id: 'u' } }));
		await service.initialize('c');
		expect(user.setTokenResult).not.toHaveBeenCalled();
		expect(localStorage.getItem('thzero.auth')).toBeNull();
		expect(user.setAuthCompleted).toHaveBeenCalledWith('c', true);
	});

	it('treats a token without an expiry, or garbage, as expired', () => {
		expect(service._expired(token({ userId: 'u' }))).toBe(true);
		expect(service._expired('garbage')).toBe(true);
		expect(service._expired(token({ exp: now() + 60 }))).toBe(false);
	});

	it('signs out, forgetting the sign-in', async () => {
		await service.signedIn('c', token({ exp: now() + 3600 }), { id: 'u' });
		await service.signOut('c');
		expect(localStorage.getItem('thzero.auth')).toBeNull();
		expect(user.resetUser).toHaveBeenCalled();
		expect(LibraryClientUtility.$navRouter.push).toHaveBeenCalledWith('/');
	});

	it('announces signing in and out on the auth event', async () => {
		await service.signedIn('c', token({ exp: now() + 3600 }), { id: 'u' });
		expect(service._serviceEvent.emit).toHaveBeenCalledWith('auth', true);
		await service.signOut('c');
		expect(service._serviceEvent.emit).toHaveBeenLastCalledWith('auth', false);
	});

	it('signs out once the token has expired', async () => {
		user.token = token({ exp: now() - 10 });
		await service.refreshToken('c', null, true);
		expect(user.resetUser).toHaveBeenCalled();
	});

	it('uses the app\'s storage key and sign-in route', async () => {
		service._storageKey = () => 'my-app.auth';
		service._signInRoute = () => '/sign-in';
		await service.signedIn('c', token({ exp: now() + 3600 }), { id: 'u' });
		expect(localStorage.getItem('my-app.auth')).not.toBeNull();
		await service.signIn('c');
		expect(LibraryClientUtility.$navRouter.push).toHaveBeenCalledWith('/sign-in');
	});
});

describe('ServerTokenAuthService renewal', () => {
	let providers;
	let renewed;

	const saved = () => JSON.parse(localStorage.getItem('thzero.auth') ?? 'null');

	beforeEach(() => {
		renewed = token({ userId: 'u', exp: now() + 3600 });
		providers = {
			renew: vi.fn(async () => ({ success: true, results: { token: renewed, user: { id: 'u' }, renewal: 'key2' } })),
			revoke: vi.fn(async () => ({ success: true }))
		};
		service._injector = { getService: (key) => (key === Constants.InjectorKeys.SERVICE_AUTH_PROVIDERS ? providers : null) };
		service._raceWaitMs = 0;
	});

	it('renews an expired sign-in on the next visit', async () => {
		localStorage.setItem('thzero.auth', JSON.stringify({ token: token({ exp: now() - 10 }), user: { id: 'u' }, renewal: 'key1' }));
		await service.initialize('c');
		expect(providers.renew).toHaveBeenCalledWith('c', 'key1');
		expect(user.token).toBe(renewed);
		expect(saved().renewal).toBe('key2');
	});

	it('forgets an expired sign-in whose key is refused', async () => {
		providers.renew = vi.fn(async () => ({ success: false }));
		localStorage.setItem('thzero.auth', JSON.stringify({ token: token({ exp: now() - 10 }), user: { id: 'u' }, renewal: 'key1' }));
		await service.initialize('c');
		expect(user.token).toBeNull();
		expect(saved()).toBeNull();
		expect(user.setAuthCompleted).toHaveBeenCalledWith('c', true);
	});

	it('renews five minutes before the token expires', async () => {
		vi.useFakeTimers();
		await service.signedIn('c', token({ userId: 'u', exp: now() + 3600 }), { id: 'u' }, 'key1');
		await vi.advanceTimersByTimeAsync((55 * 60 * 1000) - 1000);
		expect(providers.renew).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(2000);
		expect(providers.renew).toHaveBeenCalledWith(expect.anything(), 'key1');
		expect(user.token).toBe(renewed);
		expect(saved().renewal).toBe('key2');
	});

	it('does not schedule a renewal without a key', async () => {
		vi.useFakeTimers();
		await service.signedIn('c', token({ userId: 'u', exp: now() + 3600 }), { id: 'u' });
		await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
		expect(providers.renew).not.toHaveBeenCalled();
	});

	it('keeps the sign-in and tries again when the server is out of reach', async () => {
		vi.useFakeTimers();
		providers.renew = vi.fn(async () => ({ success: false, unreachable: true }));
		const current = token({ userId: 'u', exp: now() + 120 });
		await service.signedIn('c', current, { id: 'u' }, 'key1');
		await vi.advanceTimersByTimeAsync(1);
		expect(providers.renew).toHaveBeenCalledTimes(1);
		expect(user.token).toBe(current);
		await vi.advanceTimersByTimeAsync(60 * 1000);
		expect(providers.renew).toHaveBeenCalledTimes(2);
	});

	it('keeps an expired sign-in and its key when the server is out of reach, and renews once it answers', async () => {
		vi.useFakeTimers();
		providers.renew = vi.fn(async () => ({ success: false, unreachable: true }));
		const expired = token({ userId: 'u', exp: now() - 10 });
		localStorage.setItem('thzero.auth', JSON.stringify({ token: expired, user: { id: 'u' }, renewal: 'key1' }));
		await service.initialize('c');
		expect(user.token).toBe(expired);
		expect(saved().renewal).toBe('key1');
		expect(user.resetUser).not.toHaveBeenCalled();

		await service.refreshToken('c');
		expect(user.resetUser).not.toHaveBeenCalled();

		providers.renew = vi.fn(async () => ({ success: true, results: { token: renewed, user: { id: 'u' }, renewal: 'key2' } }));
		await vi.advanceTimersByTimeAsync(60 * 1000);
		expect(user.token).toBe(renewed);
		expect(saved().renewal).toBe('key2');
	});

	it('keeps the sign-in when the timer finds the token expired and the server out of reach', async () => {
		vi.useFakeTimers();
		providers.renew = vi.fn(async () => ({ success: false, unreachable: true }));
		await service.signedIn('c', token({ userId: 'u', exp: now() + 1 }), { id: 'u' }, 'key1');
		await vi.advanceTimersByTimeAsync(2000);
		expect(providers.renew).toHaveBeenCalled();
		expect(user.resetUser).not.toHaveBeenCalled();
		expect(saved().renewal).toBe('key1');
	});

	it('renews when the page wakes up or comes back online with the token due', async () => {
		const listeners = {};
		globalThis.window.addEventListener = (type, listener) => (listeners[type] = listener);
		globalThis.document = { visibilityState: 'visible', addEventListener: (type, listener) => (listeners[type] = listener) };
		try {
			await service.initialize('c');
			await service.signedIn('c', token({ userId: 'u', exp: now() + 3600 }), { id: 'u' }, 'key1');
			await listeners.visibilitychange();
			expect(providers.renew).not.toHaveBeenCalled();

			user.token = token({ userId: 'u', exp: now() - 10 });
			localStorage.setItem('thzero.auth', JSON.stringify({ token: user.token, user: { id: 'u' }, renewal: 'key1' }));
			await listeners.visibilitychange();
			expect(providers.renew).toHaveBeenCalledTimes(1);
			expect(user.token).toBe(renewed);

			user.token = token({ userId: 'u', exp: now() + 60 });
			localStorage.setItem('thzero.auth', JSON.stringify({ token: user.token, user: { id: 'u' }, renewal: 'key2' }));
			await listeners.online();
			expect(providers.renew).toHaveBeenCalledTimes(2);
		}
		finally {
			delete globalThis.document;
		}
	});

	it('takes the sign-in another tab already renewed, without renewing again', async () => {
		await service.signedIn('c', token({ userId: 'u', exp: now() + 60 }), { id: 'u' }, 'key1');
		localStorage.setItem('thzero.auth', JSON.stringify({ token: renewed, user: { id: 'u' }, renewal: 'key2' }));
		expect(await service._renew('c')).toBe(true);
		expect(providers.renew).not.toHaveBeenCalled();
		expect(user.token).toBe(renewed);
	});

	it('takes the sign-in from the other tab when it used the key first', async () => {
		await service.signedIn('c', token({ userId: 'u', exp: now() + 60 }), { id: 'u' }, 'key1');
		providers.renew = vi.fn(async () => {
			localStorage.setItem('thzero.auth', JSON.stringify({ token: renewed, user: { id: 'u' }, renewal: 'key9' }));
			return { success: false };
		});
		expect(await service._renew('c')).toBe(true);
		expect(user.token).toBe(renewed);
	});

	it('waits for the tab that used the key first to save the new sign-in', async () => {
		service._raceWaitMs = 2000;
		await service.signedIn('c', token({ userId: 'u', exp: now() - 10 }), { id: 'u' }, 'key1');
		providers.renew = vi.fn(async () => {
			setTimeout(() => localStorage.setItem('thzero.auth', JSON.stringify({ token: renewed, user: { id: 'u' }, renewal: 'key9' })), 400);
			return { success: false };
		});
		expect(await service._renew('c')).toBe(true);
		expect(user.token).toBe(renewed);
		expect(saved().renewal).toBe('key9');
	});

	it('does not erase another tab\'s new sign-in when its own renewal is refused', async () => {
		user.token = token({ exp: now() - 10 });
		localStorage.setItem('thzero.auth', JSON.stringify({ token: user.token, user: { id: 'u' }, renewal: 'key1' }));
		providers.renew = vi.fn(async () => ({ success: false }));
		// The other tab saves only after this one has stopped waiting for it.
		const renew = service._renewOnce.bind(service);
		service._renewOnce = async (correlationId) => {
			const answer = await renew(correlationId);
			localStorage.setItem('thzero.auth', JSON.stringify({ token: renewed, user: { id: 'u' }, renewal: 'key9' }));
			return answer;
		};
		await service._renewOrSignOut('c');
		expect(user.resetUser).not.toHaveBeenCalled();
		expect(user.token).toBe(renewed);
		expect(saved().renewal).toBe('key9');
	});

	it('renews once when asked twice at the same time', async () => {
		localStorage.setItem('thzero.auth', JSON.stringify({ token: token({ exp: now() - 10 }), user: { id: 'u' }, renewal: 'key1' }));
		await Promise.all([ service._renew('c'), service._renew('c') ]);
		expect(providers.renew).toHaveBeenCalledTimes(1);
	});

	it('renews an expired token when asked to refresh, and signs out when it cannot', async () => {
		localStorage.setItem('thzero.auth', JSON.stringify({ token: token({ exp: now() - 10 }), user: { id: 'u' }, renewal: 'key1' }));
		user.token = token({ exp: now() - 10 });
		await service.refreshToken('c');
		expect(user.token).toBe(renewed);

		providers.renew = vi.fn(async () => ({ success: false }));
		user.token = token({ exp: now() - 10 });
		localStorage.setItem('thzero.auth', JSON.stringify({ token: user.token, user: { id: 'u' }, renewal: 'key2' }));
		await service.refreshToken('c');
		expect(user.resetUser).toHaveBeenCalled();
	});

	it('deletes the key on sign-out, and an older key on a new sign-in', async () => {
		await service.signedIn('c', token({ exp: now() + 3600 }), { id: 'u' }, 'key1');
		await service.signedIn('c', token({ exp: now() + 3600 }), { id: 'u' }, 'key2');
		expect(providers.revoke).toHaveBeenCalledWith('c', 'key1');
		await service.signOut('c');
		expect(providers.revoke).toHaveBeenCalledWith('c', 'key2');
		expect(saved()).toBeNull();
	});

	it('follows a sign-in and a sign-out in another tab', async () => {
		const listeners = [];
		globalThis.window.addEventListener = (type, listener) => ((type === 'storage') ? listeners.push(listener) : null);
		await service.initialize('c');

		localStorage.setItem('thzero.auth', JSON.stringify({ token: renewed, user: { id: 'u' }, renewal: 'key2' }));
		await listeners[0]({ key: 'thzero.auth' });
		expect(user.token).toBe(renewed);

		localStorage.removeItem('thzero.auth');
		await listeners[0]({ key: 'thzero.auth' });
		expect(user.token).toBeNull();
	});
});
