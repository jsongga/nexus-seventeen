import { randomUuid } from './uuid';

const documentClientStorageKey = 'cicada.documentClientId';
const documentClientOwnerStoragePrefix = 'cicada.documentClientOwner.';
const documentClientRuntimeNonce = `document-runtime-${randomUuid()}`;
let runtimeDocumentClientId: string | null = null;
let runtimeDocumentClientOwnerKey: string | null = null;
let documentClientCleanupRegistered = false;

function newDocumentClientId(): string {
  return `document-ui-${randomUuid()}`;
}

function documentClientOwnerKey(clientId: string): string {
  return `${documentClientOwnerStoragePrefix}${clientId}`;
}

function registerDocumentClientCleanup(): void {
  if (documentClientCleanupRegistered || typeof globalThis.addEventListener !== 'function') return;
  documentClientCleanupRegistered = true;
  globalThis.addEventListener('pagehide', (event) => {
    if ('persisted' in event && event.persisted === true) return;
    const ownerKey = runtimeDocumentClientOwnerKey;
    if (!ownerKey) return;
    try {
      if (globalThis.localStorage?.getItem(ownerKey) === documentClientRuntimeNonce) {
        globalThis.localStorage.removeItem(ownerKey);
      }
    } catch {
      // A storage policy change must not make page navigation fail.
    }
  });
}

function claimDocumentClientId(clientId: string, storage: Storage): boolean {
  const ownerKey = documentClientOwnerKey(clientId);
  const currentOwner = storage.getItem(ownerKey);
  if (currentOwner && currentOwner !== documentClientRuntimeNonce) return false;
  storage.setItem(ownerKey, documentClientRuntimeNonce);
  if (storage.getItem(ownerKey) !== documentClientRuntimeNonce) return false;
  runtimeDocumentClientOwnerKey = ownerKey;
  registerDocumentClientCleanup();
  return true;
}

export function stableDocumentClientId(configured?: string): string {
  const supplied = configured?.trim();
  if (supplied) return supplied;
  if (runtimeDocumentClientId) return runtimeDocumentClientId;

  let session: Storage | undefined;
  try {
    session = globalThis.sessionStorage;
    const local = globalThis.localStorage;
    if (!session || !local) throw new Error('Browser storage is unavailable');

    const stored = session.getItem(documentClientStorageKey)?.trim();
    let selected: string | null = null;
    if (stored && claimDocumentClientId(stored, local)) {
      selected = stored;
    } else {
      for (let attempt = 0; attempt < 3 && !selected; attempt += 1) {
        const candidate = newDocumentClientId();
        if (claimDocumentClientId(candidate, local)) selected = candidate;
      }
    }
    if (!selected) throw new Error('Document client ownership could not be claimed');
    session.setItem(documentClientStorageKey, selected);
    runtimeDocumentClientId = selected;
  } catch {
    // Without a shared ownership claim, reusing copied session storage is unsafe.
    const claimedOwnerKey = runtimeDocumentClientOwnerKey;
    try {
      if (claimedOwnerKey && globalThis.localStorage?.getItem(claimedOwnerKey) === documentClientRuntimeNonce) {
        globalThis.localStorage.removeItem(claimedOwnerKey);
      }
    } catch {
      // Storage is already known to be unreliable; continue with runtime state.
    }
    runtimeDocumentClientOwnerKey = null;
    runtimeDocumentClientId = newDocumentClientId();
    try {
      session?.setItem(documentClientStorageKey, runtimeDocumentClientId);
    } catch {
      // The runtime-scoped value still keeps repeated client creation stable.
    }
  }
  return runtimeDocumentClientId;
}
