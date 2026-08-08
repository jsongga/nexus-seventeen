import { maximumDocumentContentBytes } from '../data/wire';

export interface StoredDocumentDraft {
  documentId: string;
  baseContentVersion: number;
  content: string;
  updatedAt: number;
}

const storageKey = 'cicada.documentDrafts.v1';
const maximumDrafts = 8;

// The server's document content cap, taken from the shared contract rather
// than mirrored, so the two sides cannot drift.
// Deliberately NOT the automation payload cap: the two limits are unrelated and
// only happen to share a value today, so coupling them would let a change to one
// silently break the other.
const maximumDraftBytes = maximumDocumentContentBytes;

function contentBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validDraft(value: unknown): value is StoredDocumentDraft {
  if (typeof value !== 'object' || value === null) return false;
  const draft = value as Partial<StoredDocumentDraft>;
  return typeof draft.documentId === 'string'
    && draft.documentId.length > 0
    && draft.documentId.length <= 256
    && Number.isSafeInteger(draft.baseContentVersion)
    && Number(draft.baseContentVersion) >= 1
    && typeof draft.content === 'string'
    && contentBytes(draft.content) <= maximumDraftBytes
    && Number.isSafeInteger(draft.updatedAt)
    && Number(draft.updatedAt) >= 0;
}

export function documentContentFits(value: string): boolean {
  return contentBytes(value) <= maximumDraftBytes;
}

/** Session-scoped draft cache. Memory remains authoritative when browser storage is denied. */
export class DocumentDraftStore {
  readonly #storage: Storage | null;
  readonly #drafts = new Map<string, StoredDocumentDraft>();
  #loaded = false;

  constructor(storage: Storage | null) {
    this.#storage = storage;
  }

  get(documentId: string): StoredDocumentDraft | null {
    this.#load();
    const draft = this.#drafts.get(documentId);
    return draft ? { ...draft } : null;
  }

  has(documentId: string): boolean {
    this.#load();
    return this.#drafts.has(documentId);
  }

  hasAny(): boolean {
    this.#load();
    return this.#drafts.size > 0;
  }

  set(draft: StoredDocumentDraft): boolean {
    this.#load();
    if (!validDraft(draft)) return false;
    this.#drafts.set(draft.documentId, { ...draft });
    return this.#persist();
  }

  delete(documentId: string): void {
    this.#load();
    if (!this.#drafts.delete(documentId)) return;
    this.#persist();
  }

  #load(): void {
    if (this.#loaded) return;
    this.#loaded = true;
    if (!this.#storage) return;
    try {
      const raw = this.#storage.getItem(storageKey);
      if (!raw) return;
      const decoded = JSON.parse(raw) as unknown;
      if (!Array.isArray(decoded)) return;
      for (const candidate of decoded.slice(0, maximumDrafts)) {
        if (validDraft(candidate)) this.#drafts.set(candidate.documentId, { ...candidate });
      }
    } catch {
      // Corrupt or unavailable session storage must not blank the Documents page.
    }
  }

  #persist(): boolean {
    if (!this.#storage) return false;
    try {
      if (this.#drafts.size === 0) this.#storage.removeItem(storageKey);
      else {
        const retained = [...this.#drafts.values()]
          .sort((left, right) => right.updatedAt - left.updatedAt || left.documentId.localeCompare(right.documentId))
          .slice(0, maximumDrafts);
        this.#storage.setItem(storageKey, JSON.stringify(retained));
      }
      return this.#drafts.size <= maximumDrafts;
    } catch {
      return false;
    }
  }
}

function browserSessionStorage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export const documentDraftStore = new DocumentDraftStore(browserSessionStorage());

let unloadGuardRegistered = false;

export function protectUnsavedDocumentDrafts(): void {
  if (unloadGuardRegistered || typeof globalThis.addEventListener !== 'function') return;
  unloadGuardRegistered = true;
  globalThis.addEventListener('beforeunload', (event) => {
    if (!documentDraftStore.hasAny()) return;
    event.preventDefault();
    // Required by Chromium even though browsers show their own message.
    event.returnValue = true;
  });
}
