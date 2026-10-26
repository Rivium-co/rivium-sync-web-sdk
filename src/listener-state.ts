/**
 * What a listener knows about its documents, and how it turns that into what
 * the app sees. No I/O here: the SDK feeds it snapshots and events and asks it
 * for the current view.
 */

/** A document as a listener keeps it. */
export interface KeptDocument {
  id: string;
  data: Record<string, any>;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
}

/** An event on a listener's private topic. */
export interface ListenerEvent {
  subscriptionId?: string;
  type: 'added' | 'modified' | 'removed' | 'revoked';
  documentId?: string;
  data?: Record<string, any>;
  version?: number | null;
  updatedAt?: string;
  reason?: 'permission' | 'expired' | string;
}

/** Order and window a query listener applies itself. */
export interface ViewOptions {
  orderBy?: string;
  orderDirection?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

const versionOf = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export class ListenerState {
  private docs = new Map<string, KeptDocument>();

  /** Replace everything with a snapshot (the listen answer). */
  reset(documents: Array<Partial<KeptDocument> & { id: string }>): void {
    this.docs.clear();
    for (const d of documents) {
      if (!d || typeof d.id !== 'string') continue;
      this.docs.set(d.id, {
        id: d.id,
        data: d.data ?? {},
        version: versionOf(d.version),
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      });
    }
  }

  get(id: string): KeptDocument | undefined {
    return this.docs.get(id);
  }

  get size(): number {
    return this.docs.size;
  }

  /**
   * Apply one `added` / `modified` / `removed` event. Returns false when it
   * changed nothing: an event older than (or as old as) what is already known
   * is dropped, since the snapshot or a later event already had it.
   */
  apply(event: ListenerEvent): boolean {
    const id = event.documentId;
    if (typeof id !== 'string' || !id) return false;

    if (event.type === 'removed') {
      return this.docs.delete(id);
    }
    if (event.type !== 'added' && event.type !== 'modified') return false;
    if (event.data === undefined || event.data === null) return false;

    const incoming = versionOf(event.version);
    const known = this.docs.get(id);
    if (known && known.version !== undefined && incoming !== undefined && known.version >= incoming) {
      return false;
    }
    this.docs.set(id, {
      id,
      data: event.data,
      version: incoming,
      createdAt: known?.createdAt,
      updatedAt: event.updatedAt ?? known?.updatedAt,
    });
    return true;
  }

  /** Put a document in directly (older realtime topics: no versions). */
  upsert(doc: KeptDocument): void {
    this.docs.set(doc.id, doc);
  }

  delete(id: string): boolean {
    return this.docs.delete(id);
  }

  /** Every kept document, in the order they were learned. */
  all(): KeptDocument[] {
    return Array.from(this.docs.values());
  }

  /** The documents as the app sees them: sorted, then offset / limit. */
  view(options?: ViewOptions, docs: KeptDocument[] = this.all()): KeptDocument[] {
    let out = [...docs];
    if (options?.orderBy) out = sortDocuments(out, options.orderBy, options.orderDirection);
    const offset = options?.offset && options.offset > 0 ? options.offset : 0;
    if (offset || options?.limit) {
      out = out.slice(offset, options?.limit ? offset + options.limit : undefined);
    }
    return out;
  }
}

/** Sort by a field of the data; missing values go last. Stable. */
export function sortDocuments(docs: KeptDocument[], field: string, direction?: 'asc' | 'desc'): KeptDocument[] {
  const sign = direction === 'desc' ? -1 : 1;
  return [...docs].sort((a, b) => {
    const av = a.data?.[field];
    const bv = b.data?.[field];
    const aMissing = av === undefined || av === null;
    const bMissing = bv === undefined || bv === null;
    if (aMissing || bMissing) return aMissing === bMissing ? 0 : aMissing ? 1 : -1;
    if (av < bv) return -1 * sign;
    if (av > bv) return 1 * sign;
    return 0;
  });
}

/**
 * A key that changes when what the app sees changes. Versions make it cheap;
 * without one (older realtime topics) the data itself is compared.
 */
export function deliveryKey(docs: Array<KeptDocument | null>): string {
  return docs
    .map((d) => (d === null ? '-' : d.version !== undefined ? `${d.id}@${d.version}` : `${d.id}:${JSON.stringify(d.data)}`))
    .join('|');
}
