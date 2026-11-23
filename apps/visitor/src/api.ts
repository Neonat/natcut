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

export interface VisitorApi {
  submit(request: SubmissionRequest): Promise<SubmissionResponse>;
  getStatus(submissionId: string, statusToken: string): Promise<PublicQueueStatus>;
  leave(submissionId: string, statusToken: string): Promise<{ submissionId: string; publicStatus: 'cancelled' }>;
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

  return {
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
  };
}
