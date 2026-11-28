import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { catalogManifest } from '@natcut/render/browser';
import { PlantJourney } from '../src/plant/plant-journey.tsx';
import type { PlantVisitorApi } from '../src/api.ts';

afterEach(() => { cleanup(); sessionStorage.clear(); vi.restoreAllMocks(); });

it('opens the approved sprite editor without starting a plant generation job', () => {
  const onNavigate = vi.fn();
  const api = { capture: vi.fn(), begin: vi.fn(), plantStatus: vi.fn(), acceptGenerated: vi.fn(),
    acceptFallback: vi.fn(), syncOutcome: vi.fn(), acceptedSprite: vi.fn(), candidatePreview: vi.fn(),
    submitPlant: vi.fn() } satisfies PlantVisitorApi;
  render(<PlantJourney api={api} onNavigate={onNavigate} />);
  fireEvent.click(screen.getByRole('button', { name: 'Browse approved sprites' }));
  expect(onNavigate).toHaveBeenCalledWith('/studio');
  expect(api.capture).not.toHaveBeenCalled();
  expect(api.begin).not.toHaveBeenCalled();
});

it('keeps the generation wait open and offers the approved backup immediately', async () => {
  const acceptFallback = vi.fn().mockResolvedValue({ state: 'accepted', generationIntentId: 'intent',
    decision: { outcome: 'catalog_fallback_accepted', catalogAssetId: catalogManifest.spriteAssetId },
    sproutAck: 'confirmed' });
  const api = { capture: vi.fn().mockResolvedValue({ captureId: 'capture', status: 'confirmed' }),
    begin: vi.fn().mockResolvedValue({ state: 'waiting', generationIntentId: 'intent', remainingMs: 120_000 }),
    plantStatus: vi.fn(), acceptGenerated: vi.fn(), acceptFallback, syncOutcome: vi.fn(),
    acceptedSprite: vi.fn(), candidatePreview: vi.fn(), submitPlant: vi.fn() } satisfies PlantVisitorApi;
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL() { return 'blob:plant-photo'; }
    static revokeObjectURL() {}
  });
  vi.stubGlobal('Worker', class extends EventTarget { postMessage() {} });
  render(<PlantJourney api={api} onNavigate={vi.fn()} />);
  fireEvent.change(screen.getByLabelText(/tap to take or upload/i), {
    target: { files: [new File(['plant'], 'plant.jpg', { type: 'image/jpeg' })] },
  });
  fireEvent.click(screen.getByRole('button', { name: /create my sprite/i }));
  const backup = await screen.findByRole('button', { name: 'Use my backup sprite now' });
  expect(screen.getByText('We’ll show your sprite as soon as it’s ready.')).toBeTruthy();
  fireEvent.click(backup);
  expect(acceptFallback).toHaveBeenCalledWith(expect.any(String));
  expect(await screen.findByRole('heading', { name: /your sprite sticker/i })).toBeTruthy();
});

it('uploads a plant, starts the private job, and opens the accepted fallback in the sticker editor', async () => {
  const capture = vi.fn().mockResolvedValue({ captureId: 'capture-one', status: 'confirmed' });
  const begin = vi.fn().mockResolvedValue({ state: 'accepted', generationIntentId: 'intent-one',
    decision: { outcome: 'catalog_fallback_accepted', catalogAssetId: catalogManifest.spriteAssetId }, sproutAck: 'confirmed' });
  const api = { capture, begin, plantStatus: vi.fn(), acceptGenerated: vi.fn(), acceptFallback: vi.fn(),
    syncOutcome: vi.fn(), acceptedSprite: vi.fn(), candidatePreview: vi.fn(), submitPlant: vi.fn() } satisfies PlantVisitorApi;
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL() { return 'blob:plant-photo'; }
    static revokeObjectURL() {}
  });
  vi.stubGlobal('Worker', class extends EventTarget { postMessage() {} });
  render(<PlantJourney api={api} onNavigate={vi.fn()} />);
  fireEvent.change(screen.getByLabelText(/tap to take or upload/i), {
    target: { files: [new File(['plant'], 'plant.jpg', { type: 'image/jpeg' })] },
  });
  fireEvent.click(screen.getByRole('button', { name: /create my sprite/i }));
  expect(await screen.findByRole('heading', { name: /your sprite sticker/i })).toBeTruthy();
  expect(capture).toHaveBeenCalledOnce();
  expect(begin).toHaveBeenCalledWith(expect.any(String), catalogManifest.spriteAssetId);
});

it('previews the accepted generated sprite through its private blob URL', async () => {
  const decision = { state: 'accepted' as const, generationIntentId: 'intent-two',
    decision: { outcome: 'generated_accepted' as const, natcutAssetId: `sprite/runtime/${'a'.repeat(64)}` },
    sproutAck: 'confirmed' as const };
  const api = { capture: vi.fn().mockResolvedValue({ captureId: 'capture-two', status: 'confirmed' }),
    begin: vi.fn().mockResolvedValue(decision), plantStatus: vi.fn(), acceptGenerated: vi.fn(), acceptFallback: vi.fn(),
    syncOutcome: vi.fn(), acceptedSprite: vi.fn().mockResolvedValue(new Blob(['png'], { type: 'image/png' })),
    candidatePreview: vi.fn(), submitPlant: vi.fn() } satisfies PlantVisitorApi;
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL() { return 'blob:accepted-sprite'; }
    static revokeObjectURL() {}
  });
  vi.stubGlobal('Worker', class extends EventTarget { postMessage() {} });
  render(<PlantJourney api={api} onNavigate={vi.fn()} />);
  fireEvent.change(screen.getByLabelText(/tap to take or upload/i), {
    target: { files: [new File(['plant'], 'plant.jpg', { type: 'image/jpeg' })] },
  });
  fireEvent.click(screen.getByRole('button', { name: /create my sprite/i }));
  expect(await screen.findByRole('heading', { name: /your sprite sticker/i })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Three memes' })).toBeTruthy();
  expect(Array.from(document.querySelectorAll('.sticker-preview image')).some(
    image => image.getAttribute('href') === 'blob:accepted-sprite',
  )).toBe(true);
  expect(api.acceptedSprite).toHaveBeenCalledOnce();
});

it('shows a generated candidate before the visitor chooses it or the approved backup', async () => {
  const acceptGenerated = vi.fn().mockResolvedValue({ state: 'waiting', generationIntentId: 'intent', remainingMs: 1000 });
  const api = { capture: vi.fn().mockResolvedValue({ captureId: 'capture', status: 'confirmed' }),
    begin: vi.fn().mockResolvedValue({ state: 'candidate_available', generationIntentId: 'intent',
      candidateId: 'candidate', remainingMs: 1000 }), plantStatus: vi.fn(), acceptGenerated,
    acceptFallback: vi.fn(), syncOutcome: vi.fn(), acceptedSprite: vi.fn(),
    candidatePreview: vi.fn().mockResolvedValue(new Blob(['png'], { type: 'image/png' })),
    submitPlant: vi.fn() } satisfies PlantVisitorApi;
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL() { return 'blob:candidate-preview'; }
    static revokeObjectURL() {}
  });
  render(<PlantJourney api={api} onNavigate={vi.fn()} />);
  fireEvent.change(screen.getByLabelText(/tap to take or upload/i), {
    target: { files: [new File(['plant'], 'plant.jpg', { type: 'image/jpeg' })] },
  });
  fireEvent.click(screen.getByRole('button', { name: /create my sprite/i }));
  expect(await screen.findByAltText(/generated plant sprite/i)).toHaveProperty('src', 'blob:candidate-preview');
  expect(acceptGenerated).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: /yes, use this sprite/i }));
  expect(acceptGenerated).toHaveBeenCalledWith(expect.any(String), 'candidate');
});

it('recovers a confirmed capture after reload when the first job create response was lost', async () => {
  sessionStorage.setItem('natcut:plant-capture', 'capture-resume');
  sessionStorage.setItem('natcut:plant-fallback', catalogManifest.spriteAssetId);
  const begin = vi.fn().mockResolvedValue({ state: 'waiting', generationIntentId: 'intent', remainingMs: 14000 });
  const api = { capture: vi.fn(), begin,
    plantStatus: vi.fn().mockRejectedValue(new Error('PLANT_JOB_NOT_FOUND')),
    acceptGenerated: vi.fn(), acceptFallback: vi.fn(), syncOutcome: vi.fn(),
    acceptedSprite: vi.fn(), candidatePreview: vi.fn(), submitPlant: vi.fn() } satisfies PlantVisitorApi;
  render(<PlantJourney api={api} onNavigate={vi.fn()} />);
  expect(await screen.findByText(/a little magic is growing/i)).toBeTruthy();
  expect(begin).toHaveBeenCalledWith('capture-resume', catalogManifest.spriteAssetId);
});

it('lets an accepted catalog fallback proceed while Sprout acknowledgement is pending', async () => {
  const api = { capture: vi.fn().mockResolvedValue({ captureId: 'capture', status: 'confirmed' }),
    begin: vi.fn().mockResolvedValue({ state: 'accepted', generationIntentId: 'intent',
      decision: { outcome: 'catalog_fallback_accepted', catalogAssetId: catalogManifest.spriteAssetId },
      sproutAck: 'pending' }), plantStatus: vi.fn(), acceptGenerated: vi.fn(), acceptFallback: vi.fn(),
    syncOutcome: vi.fn().mockRejectedValue(new Error('Sprout unavailable')),
    acceptedSprite: vi.fn(), candidatePreview: vi.fn(), submitPlant: vi.fn() } satisfies PlantVisitorApi;
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL() { return 'blob:plant-photo'; }
    static revokeObjectURL() {}
  });
  vi.stubGlobal('Worker', class extends EventTarget { postMessage() {} });
  render(<PlantJourney api={api} onNavigate={vi.fn()} />);
  fireEvent.change(screen.getByLabelText(/tap to take or upload/i), {
    target: { files: [new File(['plant'], 'plant.jpg', { type: 'image/jpeg' })] },
  });
  fireEvent.click(screen.getByRole('button', { name: /create my sprite/i }));
  expect(await screen.findByRole('heading', { name: /your sprite sticker/i })).toBeTruthy();
});
