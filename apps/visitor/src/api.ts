import type { CompositionManifest, PublicStatus } from '@natcut/domain';
import { getApps, initializeApp, type FirebaseOptions } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInAnonymously } from 'firebase/auth';

export type WarningAcknowledgement = {
  geometryVersion: string;
  rasterHash: string;
  manifestHash: string;
  issuesHash: string;
};
export type SubmissionRequest = {
  manifest: CompositionManifest;
  idempotencyKey: string;
  warningAcknowledgement?: WarningAcknowledgement;
  requeuedFrom?: string;
};

export type SubmissionResponse = {
  submissionId: string;
  queueNumber: number;
  jobsAhead: number;
  publicStatus: PublicStatus;
  statusToken: string;
};

export type PublicQueueStatus = {
  submissionId: string;
  publicStatus: PublicStatus;
  queueNumber: number;
  jobsAhead: number;
  canLeaveQueue: boolean;
  updatedAt: string;
};

export type SurveyRequest = {
  stickerSubmissionId: string;
  cuteRating: 1 | 2 | 3 | 4 | 5;
} & ({ marketingOptIn: false } | { marketingOptIn: true; email: string });

export type SurveyResponse = { surveyId: string; created: boolean };
export type SurveyStatus = { eligible: boolean; submitted: boolean };

export type PlantFlowStatus =
  | { state: 'needs_create_retry' | 'needs_reconciliation'; generationIntentId: string }
  | { state: 'waiting'; generationIntentId: string; remainingMs: number }
  | { state: 'identification_review'; generationIntentId: string; suggestions: { name: string; scoreBps: number }[] }
  | { state: 'candidate_available'; generationIntentId: string; candidateId: string; remainingMs: number }
  | { state: 'accepted'; generationIntentId: string; decision:
      | { outcome: 'generated_accepted'; natcutAssetId: string }
      | { outcome: 'catalog_fallback_accepted'; catalogAssetId: string };
      sproutAck: 'confirmed' | 'pending' | 'needs_reconciliation' };

export interface PlantVisitorApi {
  capture(captureId: string, image: Blob): Promise<{ captureId: string; status: 'confirmed' }>;
  begin(captureId: string, fallbackAssetId: string): Promise<PlantFlowStatus>;
  plantStatus(captureId: string): Promise<PlantFlowStatus>;
  acceptGenerated(captureId: string, candidateId: string): Promise<PlantFlowStatus>;
  acceptFallback(captureId: string): Promise<PlantFlowStatus>;
  syncOutcome(captureId: string): Promise<PlantFlowStatus>;
  acceptedSprite(captureId: string): Promise<Blob>;
  candidatePreview(captureId: string, candidateId: string): Promise<Blob>;
  submitPlant(captureId: string, request: SubmissionRequest): Promise<SubmissionResponse>;
}

export interface VisitorApi {
  submit(request: SubmissionRequest): Promise<SubmissionResponse>;
  getStatus(submissionId: string, statusToken: string): Promise<PublicQueueStatus>;
  leave(submissionId: string, statusToken: string): Promise<{ submissionId: string; publicStatus: 'cancelled' }>;
  submitSurvey(request: SurveyRequest): Promise<SurveyResponse>;
  getSurveyStatus(stickerSubmissionId: string): Promise<SurveyStatus>;
  plant?: PlantVisitorApi;
}

async function parseResponse<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

export function createVisitorApi(options: {
  firebase: FirebaseOptions;
  submissionApiUrl: string;
  authEmulatorUrl?: string | undefined;
}): VisitorApi {
  const app = getApps()[0] ?? initializeApp(options.firebase);
  const auth = getAuth(app);
  if (options.authEmulatorUrl) connectAuthEmulator(auth, options.authEmulatorUrl, { disableWarnings: true });
  const identityToken = async () => {
    const user = auth.currentUser ?? (await signInAnonymously(auth)).user;
    return user.getIdToken();
  };
  const url = (path: string) => `${options.submissionApiUrl.replace(/\/$/, '')}${path}`;

  const plantJson = async <T>(path: string, method: 'GET' | 'POST', body?: object): Promise<T> =>
    parseResponse<T>(await fetch(url(path), {
      method,
      headers: { authorization: `Bearer ${await identityToken()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }));
  const plantPath = (captureId: string) => `/v1/plant-jobs/${encodeURIComponent(captureId)}`;

  return {
    plant: {
      async capture(captureId, image) {
        const bytes = new Uint8Array(await image.arrayBuffer());
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 8192) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        }
        return plantJson('/v1/plant-captures', 'POST', { captureId, imageBase64: btoa(binary) });
      },
      begin: (captureId, fallbackAssetId) => plantJson('/v1/plant-jobs', 'POST', { captureId, fallbackAssetId }),
      plantStatus: captureId => plantJson(plantPath(captureId), 'GET'),
      acceptGenerated: (captureId, candidateId) => plantJson(`${plantPath(captureId)}/accept-generated`, 'POST', { candidateId }),
      acceptFallback: captureId => plantJson(`${plantPath(captureId)}/accept-fallback`, 'POST', {}),
      syncOutcome: captureId => plantJson(`${plantPath(captureId)}/sync-outcome`, 'POST', {}),
      async acceptedSprite(captureId) {
        const response = await fetch(url(`${plantPath(captureId)}/accepted-sprite`), {
          headers: { authorization: `Bearer ${await identityToken()}` },
        });
        if (!response.ok) throw new Error(`Sprite preview unavailable (${response.status})`);
        return response.blob();
      },
      async candidatePreview(captureId, candidateId) {
        const response = await fetch(url(`${plantPath(captureId)}/candidates/${encodeURIComponent(candidateId)}`), {
          headers: { authorization: `Bearer ${await identityToken()}` },
        });
        if (!response.ok) throw new Error(`Sprite preview unavailable (${response.status})`);
        return response.blob();
      },
      submitPlant: (captureId, request) => plantJson(`${plantPath(captureId)}/submissions`, 'POST', request),
    },
    async submit(request) {
      return parseResponse<SubmissionResponse>(await fetch(url('/v1/submissions'), {
        method: 'POST',
        headers: { authorization: `Bearer ${await identityToken()}`, 'content-type': 'application/json' },
        body: JSON.stringify(request),
      }));
    },
    async getStatus(submissionId, statusToken) {
      return parseResponse<PublicQueueStatus>(await fetch(url(`/v1/submissions/${encodeURIComponent(submissionId)}/status`), {
        headers: { 'X-NatCut-Status-Token': statusToken },
      }));
    },
    async leave(submissionId, statusToken) {
      return parseResponse(await fetch(url(`/v1/submissions/${encodeURIComponent(submissionId)}/leave`), {
        method: 'POST',
        headers: { 'X-NatCut-Status-Token': statusToken },
      }));
    },
    async submitSurvey(request) {
      return parseResponse<SurveyResponse>(await fetch(url('/v1/surveys'), {
        method: 'POST',
        headers: { authorization: `Bearer ${await identityToken()}`, 'content-type': 'application/json' },
        body: JSON.stringify(request),
      }));
    },
    async getSurveyStatus(stickerSubmissionId) {
      return parseResponse<SurveyStatus>(await fetch(url(`/v1/surveys/status?stickerSubmissionId=${encodeURIComponent(stickerSubmissionId)}`), {
        headers: { authorization: `Bearer ${await identityToken()}` },
      }));
    },
  };
}
