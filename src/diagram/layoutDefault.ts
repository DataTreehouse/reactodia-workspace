import { RefCountedWorker, refCountedWorker } from '../worker-proxy/workers';

import type { DefaultLayouts } from '../layout.worker';

/**
 * Creates a definition for a a Web Worker with the default layout algorithms.
 *
 * @category Utilities
 */
export function defineLayoutWorker(workerFactory: () => Worker): RefCountedWorker<DefaultLayouts> {
    return refCountedWorker<typeof DefaultLayouts>(workerFactory, []);
}

export type { DefaultLayouts };
