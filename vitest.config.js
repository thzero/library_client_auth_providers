import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		// the first import transforms the whole dependency tree, cold
		testTimeout: 30000,
		include: [ 'test/**/*.test.js' ],
		setupFiles: [ 'test/setup.js' ],
		coverage: {
			provider: 'v8',
			reporter: [ 'text-summary', 'lcov' ],
			// every source file, so a file no test loads counts as uncovered
			include: [ '**/*.{js,vue}' ],
			exclude: [ 'test/**', 'coverage/**', '*.config.*', 'openSource.js' ]
		},
		server: {
			deps: {
				// @thzero packages import without file extensions, which Vite resolves
				// but Node does not, so they must be transformed rather than externalized
				inline: [ /@thzero\// ]
			}
		}
	}
});
