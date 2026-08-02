import { useCallback, useEffect, useMemo, useState } from 'react';
import { hashToPage, pageToHash } from './routing';
import type { BoardPage } from './WorkspaceSidebar';

export type HashNavigationMode = 'push' | 'replace';

/** Owns the raw URL state so the rendered page is always derived from the hash. */
export function useHashRoute(): readonly [BoardPage, (next: BoardPage, mode?: HashNavigationMode) => void] {
  const [hash, setHash] = useState(() => window.location.hash);

  useEffect(() => {
    const onUrlChange = () => setHash(window.location.hash);
    window.addEventListener('popstate', onUrlChange);
    window.addEventListener('hashchange', onUrlChange);
    return () => {
      window.removeEventListener('popstate', onUrlChange);
      window.removeEventListener('hashchange', onUrlChange);
    };
  }, []);

  const page = useMemo(() => hashToPage(hash), [hash]);
  const navigate = useCallback((next: BoardPage, mode: HashNavigationMode = 'push') => {
    const nextHash = pageToHash(next);
    if (nextHash === window.location.hash) return;
    if (mode === 'replace') window.history.replaceState(null, '', nextHash);
    else window.history.pushState(null, '', nextHash);
    setHash(nextHash);
  }, []);

  useEffect(() => {
    // Depend on the raw hash as well as the projection: invalid hashes share the
    // tasks page object, but every distinct URL still needs canonicalising.
    if (pageToHash(page) !== window.location.hash) navigate(page, 'replace');
  }, [hash, navigate, page]);

  return [page, navigate];
}
