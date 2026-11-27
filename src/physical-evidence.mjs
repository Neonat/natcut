import { isAbsolute } from 'node:path';
import { InvalidObservation, ObservationConflict, SqlitePhysicalQcJournal } from '@natcut/printer/physical-qc';

export function journalUnavailable() {
  return Object.assign(new Error('The original transport journal is unavailable. Check its configured absolute path.'), { code: 'JOURNAL_UNAVAILABLE' });
}

export function existingAttemptError(evidence) {
  if (evidence?.outcome) {
    return Object.assign(new Error('Attempt locked. No resend.'), { code: 'ATTEMPT_LOCKED' });
  }
  return Object.assign(new Error('This journal already contains a physical attempt. Inspect its evidence.'), { code: 'ATTEMPT_ALREADY_STARTED' });
}

export function requireMutableAttempt(getEvidence, starting) {
  const evidence = getEvidence();
  if (evidence?.outcome || (evidence?.attempt && (starting || evidence.attempt.fullyUploaded))) {
    throw existingAttemptError(evidence);
  }
}

export function createPhysicalEvidenceRuntime({
  journalPath, createQcJournal = file => new SqlitePhysicalQcJournal(file),
}) {
  function withJournal(operation) {
    if (typeof journalPath !== 'string' || !isAbsolute(journalPath)) throw journalUnavailable();
    let journal;
    try {
      journal = createQcJournal(journalPath);
      return operation(journal);
    } catch (error) {
      if (error instanceof InvalidObservation) throw Object.assign(error, { code: 'BAD_REQUEST' });
      if (error instanceof ObservationConflict) throw Object.assign(error, { code: 'OBSERVATION_CONFLICT' });
      // Never return raw database errors, paths, or validation input from the transport row.
      throw journalUnavailable();
    } finally {
      journal?.close();
    }
  }
  return {
    getPhysicalAttemptEvidence: () => withJournal(journal => journal.getPhysicalAttemptEvidence()),
    recordCompletedAttempt: input => withJournal(journal => journal.recordCompletedAttempt(input)),
    recordRibbonRegistrationQc: input => withJournal(journal => journal.recordRibbonRegistrationQc(input)),
  };
}
