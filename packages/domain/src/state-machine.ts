import { z } from 'zod';

export const PublicStatusSchema = z.enum([
  'joining',
  'queued',
  'next',
  'printing',
  'ready',
  'collected',
  'cancelled',
]);

export type PublicStatus = z.infer<typeof PublicStatusSchema>;

const transitions: Readonly<Record<PublicStatus, readonly PublicStatus[]>> = {
  joining: ['queued', 'cancelled'],
  queued: ['next', 'cancelled'],
  next: ['printing'],
  printing: ['ready'],
  ready: ['collected'],
  collected: [],
  cancelled: [],
};

export function canTransitionPublicStatus(from: PublicStatus, to: PublicStatus): boolean {
  return transitions[from].includes(to);
}

export function canVisitorLeave(status: PublicStatus): boolean {
  return status === 'joining' || status === 'queued';
}
