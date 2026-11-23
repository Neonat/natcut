import type { Auth } from 'firebase-admin/auth';

export type AuthenticatedVisitor = { uid: string };
export type VerifyBearerToken = (token: string) => Promise<AuthenticatedVisitor>;

export function createFirebaseBearerVerifier(auth: Auth): VerifyBearerToken {
  return async (token) => {
    const decoded = await auth.verifyIdToken(token);
    if (decoded.firebase.sign_in_provider !== 'anonymous') {
      throw new Error('NatCut visitor authentication requires an anonymous Firebase identity.');
    }
    return { uid: decoded.uid };
  };
}

export function bearerTokenFromHeader(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  return match?.[1] ?? null;
}
