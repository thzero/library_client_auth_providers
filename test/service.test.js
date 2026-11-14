import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import LibraryClientConstants from '@thzero/library_client/constants';

import AuthProvidersService from '../service/index';
import { installBrowser, removeBrowser } from './browser';

const external = {
	firebase: { apiKey: 'key' },
	steam: { returnUrl: '/auth/steam' },
	discord: { clientId: '1571199451295523017', returnUrl: '/auth/discord' }
};

let service;
let assigned;
let serviceAuth;
let posted;
let answer;

beforeEach(() => {
	assigned = installBrowser();
	serviceAuth = { token: 'session', signedIn: vi.fn() };
	posted = [];
	answer = { status: 200, body: { success: true, results: { token: 't', user: { id: 'u' } } } };
	globalThis.fetch = vi.fn(async (url, options) => {
		posted.push({ url, headers: options.headers, body: JSON.parse(options.body) });
		return { ok: answer.status === 200, status: answer.status, json: async () => answer.body };
	});

	service = new AuthProvidersService();
	service._logger = { debug() {}, error() {}, exception() {}, warn() {} };
	service._config = {
		getExternal: () => external,
		getBackend: (correlationId, key) => (key === 'auth' ? { baseUrl: 'https://auth.example.com/api/v1', apiKey: 'api' } : null)
	};
	service._injector = { getService: (key) => (key === LibraryClientConstants.InjectorKeys.SERVICE_AUTH ? serviceAuth : null) };
});

afterEach(() => {
	removeBrowser();
	delete globalThis.fetch;
});

describe('AuthProvidersService.providers', () => {
	it('offers a provider once its config is filled in', () => {
		expect(service.providers().map((provider) => provider.available)).toEqual([ true, true, true ]);
		service._config.getExternal = () => ({ steam: { returnUrl: '' }, discord: { clientId: 'id' } });
		expect(service.providers().map((provider) => provider.available)).toEqual([ false, false, false ]);
	});
});

describe('Steam', () => {
	it('sends the player to Steam with the return page on this address', async () => {
		expect((await service.start('c', 'steam')).success).toBe(true);
		const url = assigned[0];
		expect(url.origin + url.pathname).toBe('https://steamcommunity.com/openid/login');
		expect(url.searchParams.get('openid.return_to')).toBe('https://example.com/auth/steam');
		expect(url.searchParams.get('openid.realm')).toBe('https://example.com');
	});

	it('reads back an answer, and whether the trip was a link', () => {
		service.startLink('c', 'steam');
		const answered = service.takeReturn('steam', { 'openid.mode': 'id_res', 'openid.sig': 's', other: 'x' });
		expect(answered).toEqual({ intent: 'link', proof: { type: 'steam', params: { 'openid.mode': 'id_res', 'openid.sig': 's' } }, cancelled: false });
		// The trip is read once.
		expect(service.takeReturn('steam', { 'openid.mode': 'id_res' }).intent).toBe('signIn');
	});

	it('treats an answer without id_res as cancelled', () => {
		expect(service.takeReturn('steam', { 'openid.mode': 'cancel' }).cancelled).toBe(true);
	});
});

describe('Discord', () => {
	it('sends the player to Discord with a state it keeps', () => {
		service.start('c', 'discord');
		const url = assigned[0];
		expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize');
		expect(url.searchParams.get('client_id')).toBe(external.discord.clientId);
		expect(url.searchParams.get('scope')).toBe('identify');
		expect(url.searchParams.get('redirect_uri')).toBe('https://example.com/auth/discord');
		expect(url.searchParams.get('state')).toMatch(/^[0-9a-f]{32}$/);
	});

	it('accepts a code with the state it sent', () => {
		service.start('c', 'discord');
		const state = assigned[0].searchParams.get('state');
		expect(service.takeReturn('discord', { code: 'code', state }).proof).toEqual({ type: 'discord', code: 'code' });
	});

	it('refuses a code with another state, and one with no trip', () => {
		service.start('c', 'discord');
		expect(service.takeReturn('discord', { code: 'code', state: 'forged' }).proof).toBeNull();
		expect(service.takeReturn('discord', { code: 'code', state: 'any' }).proof).toBeNull();
	});

	it('treats a declined authorize as cancelled', () => {
		expect(service.takeReturn('discord', { error: 'access_denied' }).cancelled).toBe(true);
	});
});

describe('The auth server', () => {
	it('signs in with a proof and keeps the sign-in', async () => {
		const response = await service.signInWith('c', { type: 'discord', code: 'code' });
		expect(response.success).toBe(true);
		expect(posted[0].url).toBe('https://auth.example.com/api/v1/users/discord/verify');
		expect(posted[0].body).toEqual({ code: 'code' });
		expect(posted[0].headers[LibraryClientConstants.Headers.AuthKeys.API]).toBe('api');
		expect(posted[0].headers.Authorization).toBeUndefined();
		expect(serviceAuth.signedIn).toHaveBeenCalledWith('c', 't', { id: 'u' });
	});

	it('refuses a missing proof without asking the server', async () => {
		expect((await service.signInWith('c', null)).success).toBe(false);
		expect((await service.link('c', null)).success).toBe(false);
		expect(posted).toHaveLength(0);
	});

	it('links with the session token', async () => {
		answer.body = { success: true, results: { status: 'conflict', ticket: 'ticket' } };
		const response = await service.link('c', { type: 'steam', params: {} });
		expect(response.results).toEqual({ status: 'conflict', ticket: 'ticket' });
		expect(posted[0].url).toBe('https://auth.example.com/api/v1/users/link');
		expect(posted[0].headers.Authorization).toBe('Bearer session');
	});

	it('needs a session to link', async () => {
		serviceAuth.token = null;
		expect((await service.link('c', { type: 'steam', params: {} })).message).toBe('Sign in first.');
	});

	it('keeps the reason the server refused with', async () => {
		answer = { status: 401, body: { success: false, message: 'Discord did not confirm the sign-in.' } };
		expect((await service.signInWith('c', { type: 'discord', code: 'code' })).message).toBe('Discord did not confirm the sign-in.');
	});

	it('says when the server is out of reach', async () => {
		globalThis.fetch = vi.fn(async () => { throw new Error('offline'); });
		expect((await service.signInWith('c', { type: 'discord', code: 'code' })).message).toMatch(/Couldn't reach the sign-in server/);
	});

	it('uses the app\'s paths and storage prefix', async () => {
		service._paths = () => ({ ...AuthProvidersService.prototype._paths.call(service), discord: 'auth/discord' });
		service._storagePrefix = () => 'my-app';
		await service.signInWith('c', { type: 'discord', code: 'code' });
		expect(posted[0].url).toBe('https://auth.example.com/api/v1/auth/discord');
		service.start('c', 'steam');
		expect(sessionStorage.getItem('my-app.signInTrip')).not.toBeNull();
	});
});
