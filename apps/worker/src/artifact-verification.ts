import { isDeepStrictEqual } from 'node:util';
import { ArtifactIntegrityError, parseArtifactReceipt, verifyArtifactBytes, type ArtifactReader, type VerifiedArtifact } from '@natcut/artifacts';
import { GeometryReportSchema, SubmissionSchema, manifestHash } from '@natcut/domain';
import type { ClaimedSubmission, ExecutionEvidence } from './cloud-queue.ts';
import type { LocalPrintJob } from './job-store.ts';

const verifiedClaim = Symbol('verifiedClaim');
export type VerifiedClaim = ClaimedSubmission & { [verifiedClaim]: true; artifact: VerifiedArtifact; verifiedAt: string };

export async function verifyClaim(
  claim: ClaimedSubmission, reader: ArtifactReader, signal: AbortSignal, now: () => string,
): Promise<VerifiedClaim> {
  signal.throwIfAborted();
  const parsed = SubmissionSchema.safeParse(claim.submission);
  if (!parsed.success || parsed.data.recordVersion !== 2 || !parsed.data.artifact) {
    throw new ArtifactIntegrityError('Missing or unsupported version 2 submission evidence.');
  }
  const submission = parsed.data;
  const receipt = parsed.data.artifact;
  const report = submission.validation;
  if (!report.valid || report.severity === 'error' || report.issues.some(issue => issue.severity === 'error') ||
      ((report.severity === 'warning' || report.issues.length > 0) && (!report.acknowledgedByVisitor || !report.acknowledgedAt))) {
    throw new ArtifactIntegrityError('Submission is missing an accepted geometry validation.');
  }
  if (await manifestHash(submission.manifest) !== submission.manifestHash) {
    throw new ArtifactIntegrityError('Canonical submission manifest digest mismatch.');
  }
  const artifact = await reader.read(structuredClone(receipt), { signal });
  signal.throwIfAborted();
  if (!isDeepStrictEqual(artifact.receipt, receipt)) {
    throw new ArtifactIntegrityError('Reader returned a different artifact receipt.');
  }
  // Bind even an injected reader's bytes to the accepted receipt before journalling.
  const verified = await verifyArtifactBytes(artifact.bytes, receipt);
  signal.throwIfAborted();
  return { ...claim, submission, artifact: verified, verifiedAt: now(), [verifiedClaim]: true };
}

export async function verifyJournalArtifact(job: LocalPrintJob, expectedReceiptJson: string | null): Promise<ExecutionEvidence> {
  if (!job.artifactBytes || !job.artifactVerifiedAt || !job.artifactReceiptJson ||
      job.artifactReceiptJson !== expectedReceiptJson) throw new ArtifactIntegrityError('Missing or changed journal artifact.');
  const receipt = parseArtifactReceipt(JSON.parse(job.artifactReceiptJson));
  const { descriptor } = receipt;
  const validation = GeometryReportSchema.parse(JSON.parse(job.geometryReportJson));
  if (job.colorSha256 !== descriptor.colorSha256 || job.cutMaskSha256 !== descriptor.maskSha256 ||
      job.bundleSha256 !== descriptor.bundleSha256 || job.rasterHash !== validation.rasterHash ||
      validation.rasterHash !== descriptor.maskSha256 || validation.geometryVersion !== descriptor.geometryVersion ||
      !isDeepStrictEqual(JSON.parse(job.printProfileSnapshotJson), descriptor.profile)) {
    throw new ArtifactIntegrityError('Journal hashes or print profile differ from the receipt.');
  }
  await verifyArtifactBytes(job.artifactBytes, receipt);
  return { receipt, manifestHash: job.manifestHash, validation };
}
