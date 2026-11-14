// Stand-ins for the browser's storage and location, so the services run in Node.
export function memoryStorage() {
	const items = new Map();
	return {
		getItem: (key) => (items.has(key) ? items.get(key) : null),
		setItem: (key, value) => items.set(key, String(value)),
		removeItem: (key) => items.delete(key),
		clear: () => items.clear()
	};
}

export function installBrowser(origin = 'https://example.com') {
	const assigned = [];
	globalThis.window = { location: { origin, assign: (url) => assigned.push(new URL(url)) } };
	globalThis.sessionStorage = memoryStorage();
	globalThis.localStorage = memoryStorage();
	return assigned;
}

export function removeBrowser() {
	delete globalThis.window;
	delete globalThis.sessionStorage;
	delete globalThis.localStorage;
}

// A JWT with [claims]; the services read it without checking a signature.
export function token(claims) {
	const part = (value) => btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
	return `${part({ alg: 'RS256' })}.${part(claims)}.signature`;
}
