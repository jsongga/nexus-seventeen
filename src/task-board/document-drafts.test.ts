import { describe, expect, it } from 'vitest';
import { DocumentDraftStore, documentContentFits } from './document-drafts';

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

function draft(documentId: string, updatedAt: number, content = `draft ${documentId}`) {
  return { documentId, baseContentVersion: 2, content, updatedAt };
}

describe('document draft store', () => {
  it('restores drafts from session storage and clears them after save or discard', () => {
    const storage = new MemoryStorage();
    const first = new DocumentDraftStore(storage);
    expect(first.set(draft('document-one', 10))).toBe(true);

    const restored = new DocumentDraftStore(storage);
    expect(restored.get('document-one')).toEqual(draft('document-one', 10));
    restored.delete('document-one');

    expect(new DocumentDraftStore(storage).get('document-one')).toBeNull();
    expect(storage.length).toBe(0);
  });

  it('persists the eight newest drafts while retaining older drafts in memory with a warning result', () => {
    const storage = new MemoryStorage();
    const store = new DocumentDraftStore(storage);
    for (let index = 0; index < 10; index += 1) {
      expect(store.set(draft(`document-${index}`, index))).toBe(index < 8);
    }

    expect(store.get('document-0')).not.toBeNull();
    expect(store.get('document-1')).not.toBeNull();
    expect(store.get('document-2')).not.toBeNull();
    const reloaded = new DocumentDraftStore(storage);
    expect(reloaded.get('document-0')).toBeNull();
    expect(reloaded.get('document-1')).toBeNull();
    expect(reloaded.get('document-2')).not.toBeNull();
    expect(reloaded.get('document-9')).not.toBeNull();
  });

  it('rejects content beyond the board limit without replacing the current draft', () => {
    const store = new DocumentDraftStore(new MemoryStorage());
    expect(store.set(draft('document-one', 1, 'safe'))).toBe(true);
    expect(documentContentFits('x'.repeat(48 * 1_024))).toBe(true);
    expect(documentContentFits('x'.repeat(48 * 1_024 + 1))).toBe(false);
    expect(store.set(draft('document-one', 2, 'x'.repeat(48 * 1_024 + 1)))).toBe(false);
    expect(store.get('document-one')?.content).toBe('safe');
  });

  it('retains an in-memory draft when browser storage is unavailable', () => {
    const store = new DocumentDraftStore(null);
    expect(store.set(draft('document-one', 1))).toBe(false);
    expect(store.get('document-one')).toEqual(draft('document-one', 1));
  });
});
