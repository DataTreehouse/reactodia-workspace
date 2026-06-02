import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    resolve: {
        alias: {
            '@images': resolve(__dirname, './images'),
            '@codicons': '@vscode/codicons/src/icons/',
        },
    },
    css: {
        modules: {
            generateScopedName: '[name]__[local]',
        },
    },
    build: {
        assetsInlineLimit: (path, _content) => (
            /.resource.svg$/.test(path) ? false :
            /.inline.svg$/.test(path) ? true :
            undefined
        ),
    },
    test: {
        name: 'browser',
        browser: {
            provider: playwright({
                launch: {
                    args: ['--disable-dev-shm-usage', '--no-sandbox'],
                },
            }),
            enabled: true,
            headless: true,
            screenshotFailures: false,
            instances: [
                {browser: 'chromium'},
            ],
        },
        include: [
            'test/data/indexedDbCachedProvider.test.ts',
            'test/paper/toSvg.test.tsx',
        ],
        fileParallelism: false,
    },
});
