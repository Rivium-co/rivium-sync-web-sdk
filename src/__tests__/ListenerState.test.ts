/**
 * What a listener keeps: events applied by version, order and limit applied
 * by the SDK, and a delivery key that only changes when the result does.
 */
import { ListenerState, deliveryKey, sortDocuments } from '../listener-state';

describe('ListenerState', () => {
  it('applies added, modified and removed events', () => {
    const s = new ListenerState();
    s.reset([{ id: 'a', data: { n: 1 }, version: 1 }]);

    expect(s.apply({ type: 'added', documentId: 'b', data: { n: 2 }, version: 1 })).toBe(true);
    expect(s.apply({ type: 'modified', documentId: 'a', data: { n: 10 }, version: 2 })).toBe(true);
    expect(s.get('a')).toEqual(expect.objectContaining({ data: { n: 10 }, version: 2 }));

    expect(s.apply({ type: 'removed', documentId: 'b', version: null })).toBe(true);
    expect(s.get('b')).toBeUndefined();
    expect(s.size).toBe(1);
  });

  it('drops an event the snapshot already had (same or older version)', () => {
    const s = new ListenerState();
    s.reset([{ id: 'a', data: { n: 5 }, version: 5 }]);

    expect(s.apply({ type: 'modified', documentId: 'a', data: { n: 4 }, version: 4 })).toBe(false);
    expect(s.apply({ type: 'modified', documentId: 'a', data: { n: 5 }, version: 5 })).toBe(false);
    expect(s.get('a')!.data).toEqual({ n: 5 });

    expect(s.apply({ type: 'modified', documentId: 'a', data: { n: 6 }, version: 6 })).toBe(true);
    expect(s.get('a')!.data).toEqual({ n: 6 });
  });

  it('ignores events without a document or data, and revoked events', () => {
    const s = new ListenerState();
    expect(s.apply({ type: 'added', data: { x: 1 }, version: 1 })).toBe(false);
    expect(s.apply({ type: 'added', documentId: 'a', version: 1 })).toBe(false);
    expect(s.apply({ type: 'revoked', reason: 'permission' })).toBe(false);
    expect(s.apply({ type: 'removed', documentId: 'missing', version: null })).toBe(false);
    expect(s.size).toBe(0);
  });

  it('sorts and trims to the limit itself', () => {
    const s = new ListenerState();
    s.reset([
      { id: 'a', data: { at: 1 }, version: 1 },
      { id: 'b', data: { at: 3 }, version: 1 },
      { id: 'c', data: { at: 2 }, version: 1 },
    ]);
    s.apply({ type: 'added', documentId: 'd', data: { at: 4 }, version: 1 });

    const view = s.view({ orderBy: 'at', orderDirection: 'desc', limit: 2 });
    expect(view.map((d) => d.id)).toEqual(['d', 'b']);
  });

  it('applies the offset before the limit', () => {
    const s = new ListenerState();
    s.reset([1, 2, 3, 4, 5].map((n) => ({ id: `d${n}`, data: { n }, version: 1 })));
    expect(s.view({ orderBy: 'n', offset: 1, limit: 2 }).map((d) => d.id)).toEqual(['d2', 'd3']);
    expect(s.view({ orderBy: 'n', offset: 3 }).map((d) => d.id)).toEqual(['d4', 'd5']);
  });

  it('puts documents without the order field last', () => {
    const sorted = sortDocuments(
      [
        { id: 'x', data: {} },
        { id: 'y', data: { n: 2 } },
        { id: 'z', data: { n: 1 } },
      ],
      'n',
    );
    expect(sorted.map((d) => d.id)).toEqual(['z', 'y', 'x']);
  });
});

describe('deliveryKey', () => {
  it('is the same for the same documents and versions', () => {
    const a = [{ id: 'a', data: { n: 1 }, version: 3 }];
    expect(deliveryKey(a)).toBe(deliveryKey([{ id: 'a', data: { n: 1 }, version: 3 }]));
    expect(deliveryKey(a)).not.toBe(deliveryKey([{ id: 'a', data: { n: 1 }, version: 4 }]));
  });

  it('compares the data when there is no version', () => {
    expect(deliveryKey([{ id: 'a', data: { n: 1 } }])).not.toBe(deliveryKey([{ id: 'a', data: { n: 2 } }]));
    expect(deliveryKey([null])).not.toBe(deliveryKey([{ id: 'a', data: {} }]));
  });
});
