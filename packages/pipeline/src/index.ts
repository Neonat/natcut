import { validatedPng } from './png.ts';
import { sproutFrames, WireFailure } from './sse.ts';

export type SproutFallbackReason =
  | 'needs-name' | 'low-confidence' | 'upstream-error' | 'incomplete'
  | 'malformed' | 'cancelled' | 'degraded' | 'too-large';

type Plant = { plantName: string; totalTimeMs?: number };

export type SproutRunOutcome =
  | ({ kind: 'generated'; pngBase64: string } & Plant)
  | ({ kind: 'cached-reference'; untrustedUrl: string } & Plant)
  | { kind: 'fallback'; reason: SproutFallbackReason };

type Stage = 'start' | 'cache-hit' | 'rendered' | 'cut-out';
type Frame = Record<string, unknown>;

function fallback(reason: SproutFallbackReason): SproutRunOutcome {
  return { kind: 'fallback', reason };
}

function record(value: unknown): value is Frame {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeName(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 128) return;
  const name = value.normalize('NFC').trim();
  if (/^[\p{L}\p{M}\p{N} '’.,()×–-]+$/u.test(name)) return name;
}

function cachedUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4096) return false;
  if (!/^https:\/\//i.test(value) || /[\s\\\p{C}]/u.test(value)) return false;
  const url = URL.parse(value);
  return url !== null && !url.username && !url.password;
}

async function complete(frame: Frame, stage: Stage): Promise<SproutRunOutcome> {
  if (!record(frame.finalPlant)) return fallback('malformed');
  const plantName = safeName(frame.finalPlant.name);
  if (!plantName) return fallback('malformed');
  const { totalTimeMs, finalSpriteB64, finalSpriteUrl, spriteReused } = frame;
  if (totalTimeMs !== undefined && (typeof totalTimeMs !== 'number' || !Number.isSafeInteger(totalTimeMs) || totalTimeMs < 0)) {
    return fallback('malformed');
  }
  const plant: Plant = totalTimeMs === undefined ? { plantName } : { plantName, totalTimeMs };

  if (finalSpriteUrl !== undefined || spriteReused !== undefined) {
    if (stage !== 'start' && stage !== 'cache-hit') return fallback('malformed');
    if (spriteReused !== true || finalSpriteB64 !== undefined || !cachedUrl(finalSpriteUrl)) {
      return fallback('malformed');
    }
    return { kind: 'cached-reference', ...plant, untrustedUrl: finalSpriteUrl };
  }
  if (stage === 'cache-hit') return fallback('malformed');
  if (finalSpriteB64 === undefined || stage !== 'cut-out') return fallback('incomplete');
  return { kind: 'generated', ...plant, pngBase64: await validatedPng(finalSpriteB64) };
}

export async function readSproutRun(chunks: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<SproutRunOutcome> {
  let stage: Stage = 'start';
  let terminal: SproutRunOutcome | undefined;
  try {
    for await (const frame of sproutFrames(chunks, signal)) {
      if (signal?.aborted) return fallback('cancelled');
      if (terminal || !record(frame) || typeof frame.event !== 'string' || !frame.event) {
        return fallback('malformed');
      }

      switch (frame.event) {
        case 'sprite_cache_hit':
          if (stage !== 'start') return fallback('malformed');
          stage = 'cache-hit';
          break;
        case 'step_done':
          if (frame.step === '2b') {
            if (stage !== 'start') return fallback('malformed');
            if (frame.renderSource !== 'model' || frame.status !== 'success') return fallback('degraded');
            stage = 'rendered';
          } else if (frame.step === '2c') {
            if (frame.removeBgOk !== true || frame.status !== 'success') return fallback('degraded');
            if (stage !== 'rendered') return fallback('incomplete');
            stage = 'cut-out';
          }
          break;
        case 'needs_name':
        case 'low_confidence':
        case 'error':
        case 'pipeline_error':
          if (typeof frame.error !== 'string' || !frame.error.trim()) return fallback('malformed');
          if (frame.event === 'needs_name') terminal = fallback('needs-name');
          else if (frame.event === 'low_confidence') terminal = fallback('low-confidence');
          else terminal = fallback('upstream-error');
          break;
        case 'awaiting_stage2c_confirmation':
          terminal = fallback('incomplete');
          break;
        case 'complete':
          terminal = await complete(frame, stage);
          break;
      }
    }
    return terminal ?? fallback('incomplete');
  } catch (error) {
    if (signal?.aborted) return fallback('cancelled');
    return fallback(error instanceof WireFailure ? error.reason : 'upstream-error');
  }
}
