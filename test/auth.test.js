import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import LibraryClientUtility from '@thzero/library_client/utility/index';

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
		resetUser: vi.fn(),
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
