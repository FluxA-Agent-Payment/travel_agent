import { describe, expect, it } from 'vitest';

import { nextSeq, sharedMap } from '../store';

describe('sharedMap', () => {
  it('returns the same Map instance for the same name', () => {
    const a = sharedMap<string>('test.same');
    const b = sharedMap<string>('test.same');
    expect(a).toBe(b);
  });

  it('returns different Maps for different names', () => {
    const a = sharedMap<string>('test.a');
    const b = sharedMap<string>('test.b');
    expect(a).not.toBe(b);
  });

  it('persists writes across reads', () => {
    const map = sharedMap<number>('test.persist');
    map.set('key', 42);
    expect(sharedMap<number>('test.persist').get('key')).toBe(42);
  });

  it('supports generic types', () => {
    const map = sharedMap<{ name: string }>('test.typed');
    map.set('item', { name: 'Alice' });
    expect(map.get('item')?.name).toBe('Alice');
  });
});

describe('nextSeq', () => {
  it('returns 1 on the first call for a new counter', () => {
    expect(nextSeq('test.fresh')).toBe(1);
  });

  it('increments on each call', () => {
    const name = 'test.increment';
    const first = nextSeq(name);
    const second = nextSeq(name);
    const third = nextSeq(name);
    expect(first).toBe(1);
    expect(second).toBe(2);
    expect(third).toBe(3);
  });

  it('keeps separate counters for separate names', () => {
    const a = nextSeq('test.counter.a');
    const b = nextSeq('test.counter.b');
    expect(a).toBe(1);
    expect(b).toBe(1);
  });
});
