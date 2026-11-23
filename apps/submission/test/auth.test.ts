import { describe, expect, it, vi } from 'vitest';
import type { Auth } from 'firebase-admin/auth';
import { createFirebaseBearerVerifier } from '../src/auth.ts';

describe('Firebase bearer verification', () => {
  it('accepts anonymous Firebase identities', async () => {
    const auth = {
      verifyIdToken: vi.fn().mockResolvedValue({
        uid: 'anonymous-visitor',
        firebase: { sign_in_provider: 'anonymous' },
      }),
    } as unknown as Auth;

    await expect(createFirebaseBearerVerifier(auth)('token')).resolves.toEqual({ uid: 'anonymous-visitor' });
  });

  it('rejects non-anonymous Firebase identities', async () => {
    const auth = {
      verifyIdToken: vi.fn().mockResolvedValue({
        uid: 'password-user',
        firebase: { sign_in_provider: 'password' },
      }),
    } as unknown as Auth;

    await expect(createFirebaseBearerVerifier(auth)('token')).rejects.toThrow('anonymous');
  });
});
