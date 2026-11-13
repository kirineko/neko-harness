// Node exposes `navigator` (and, in newer versions, other browser globals) as accessors without a setter.
// The web tests install jsdom's objects with plain assignment, so turn those accessors into writable properties.
for (const name of ["navigator", "localStorage", "sessionStorage"]) {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
	if (descriptor?.get && descriptor.configurable) {
		Object.defineProperty(globalThis, name, { value: undefined, writable: true, configurable: true, enumerable: true });
	}
}

// Browser builds of some libraries (TanStack Router) reach for `self`. It only exists once a test has installed a
// jsdom window, so everything else still sees Node's environment.
Object.defineProperty(globalThis, "self", {
	configurable: true,
	get: () => ((globalThis as { window?: unknown }).window ? globalThis : undefined),
});
