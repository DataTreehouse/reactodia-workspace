import { defineProject } from 'vitest/config';

export default defineProject({
    test: {
        name: 'unit',
        environment: 'node',
        include: [
            'test/data/adjacencyBlocks.test.ts',
            'test/data/sha256.test.ts',
            'test/data/requestChunking.test.ts',
            'test/data/sparql/sparqlProviderBasic.test.ts',
            'test/data/sparql/sparqlProviderOptions.test.ts',
        ],
    },
});
