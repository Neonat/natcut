import { expect, it } from 'vitest';
import { DEVFEST_SG_V1, printProfileHash, resolvePrintProfile } from '../src/index.ts';

it('resolves only a published profile and keeps the shared entry frozen', () => {
  const profile = resolvePrintProfile('devfest-sg-v1', 1);
  expect(profile).toBe(DEVFEST_SG_V1);
  expect(Object.isFrozen(profile)).toBe(true);
  expect(() => resolvePrintProfile('devfest-sg-v1', 2)).toThrow(/profile/i);
  expect(() => resolvePrintProfile('other', 1)).toThrow(/profile/i);
});

it('pins the canonical hash independently of snapshot key order', async () => {
  const reordered = Object.fromEntries(Object.entries(DEVFEST_SG_V1).reverse());
  const digest = 'f4812e005f9118f42906afdf8fd3c99d0dd60a0fddca9f7875e12eaffca68890';
  expect(await printProfileHash(reordered)).toBe(digest);
  expect(await printProfileHash({ ...DEVFEST_SG_V1, knifePressure: 41 })).not.toBe(digest);
});
