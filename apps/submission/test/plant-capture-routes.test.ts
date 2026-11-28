import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { registerPlantCaptureRoute } from '../src/plant-capture-routes.ts';
import { PlantCaptureConflictError } from '../src/plant-capture-store.ts';

it('authenticates, validates and scopes plant photo confirmation', async () => {
  const app = Fastify();
  const confirm = vi.fn(async () => ({ captureId: 'capture-1', status: 'confirmed' as const }));
  registerPlantCaptureRoute(app, '/api', { eventId: 'event-1', verifyBearerToken: async token => {
    if (token !== 'valid') throw new Error('invalid');
    return { uid: 'visitor-1' };
  }, confirm });
  const body = { captureId: 'capture-1', imageBase64: Buffer.from('image').toString('base64') };
  const post = (authorization: string | undefined, payload: Record<string, unknown>) => app.inject({ method: 'POST',
    url: '/api/v1/plant-captures', headers: authorization ? { authorization } : {}, payload });
  expect((await post(undefined, body)).statusCode).toBe(401);
  expect((await post('Bearer invalid', body)).statusCode).toBe(401);
  expect((await post('Bearer valid', { ...body, extra: true })).statusCode).toBe(400);
  const response = await post('Bearer valid', body);
  expect(response.statusCode).toBe(201);
  expect(response.json()).toEqual({ captureId: 'capture-1', status: 'confirmed' });
  expect(confirm).toHaveBeenCalledWith('visitor-1', 'event-1', 'capture-1', Buffer.from('image'));
  confirm.mockRejectedValueOnce(new PlantCaptureConflictError());
  expect((await post('Bearer valid', body)).statusCode).toBe(409);
  await app.close();
});
