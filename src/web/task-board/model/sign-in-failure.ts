import { BoardApiError } from '../data/client';

/**
 * The board sits behind staff SSO, which the app never sees succeed -- it only
 * ever notices the failure. A 401 means the session lapsed while the page stayed
 * open. Only a top-level navigation can renew it: the document request is allowed
 * to redirect to the identity provider, and an XHR cannot follow that redirect.
 *
 * This deliberately does NOT reload by itself. An earlier version did, guarded by
 * a module-level flag -- which a reload destroys, so the flag reset every time
 * and the page reloaded forever. Re-authentication is now something the operator
 * triggers, so a persistent 401 costs one click rather than an infinite loop.
 *
 * A 403 is a different failure: the session is valid but the account is not in
 * the operator group, and no amount of signing in again grants it.
 */
export function signInFailure(caught: unknown): { message: string; canRetrySignIn: boolean } | null {
  if (!(caught instanceof BoardApiError)) return null;
  if (caught.status === 403) {
    return {
      message: 'You are signed in, but your account is not a board operator. Ask an administrator to add you to the nexus-operator group.',
      canRetrySignIn: false,
    };
  }
  if (caught.status !== 401) return null;
  return { message: 'Your sign-in has expired.', canRetrySignIn: true };
}
