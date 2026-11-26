import { expect, test } from 'bun:test';

import { acmeDescriptor } from '@/lib/source-control/providers/descriptor.fixture';

import { firstByOrder } from './referenceSources';

test('contexts are ordered by descriptor order, not by array order', () => {
    const slow = acmeDescriptor({ id: 'slow', order: 9 });
    const fast = acmeDescriptor({ id: 'fast', order: 2 });
    const contexts = [{ provider: 'slow' }, { provider: 'fast' }];
    expect(firstByOrder(contexts, [slow, fast])?.provider).toBe('fast');
    expect(firstByOrder([...contexts].reverse(), [slow, fast])?.provider).toBe('fast');
});
