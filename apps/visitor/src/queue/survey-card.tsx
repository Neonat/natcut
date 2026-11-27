import { useEffect, useState } from 'react';
import type { SurveyRequest, VisitorApi } from '../api.ts';

const ratings = [1, 2, 3, 4, 5] as const;
const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function SurveyCard(props: { stickerSubmissionId: string; api: VisitorApi }) {
  const [rating, setRating] = useState<SurveyRequest['cuteRating'] | null>(null);
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [eligible, setEligible] = useState(false);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailIsValid = validEmail.test(email.trim());

  useEffect(() => {
    let current = true;
    void props.api.getSurveyStatus(props.stickerSubmissionId)
      .then((status) => {
        if (!current) return;
        setEligible(status.eligible);
        setSubmitted(status.submitted);
        setChecked(true);
      })
      .catch(() => { if (current) setChecked(true); });
    return () => { current = false; };
  }, [props.api, props.stickerSubmissionId]);

  if (!checked || !eligible) return null;

  if (submitted) {
    return <section className="survey-card survey-thanks" aria-live="polite"><strong>Thanks for your feedback!</strong></section>;
  }

  const submit = async () => {
    if (!rating || (marketingOptIn && !emailIsValid)) return;
    setSubmitting(true);
    setError(null);
    const request: SurveyRequest = marketingOptIn
      ? { stickerSubmissionId: props.stickerSubmissionId, cuteRating: rating, marketingOptIn: true, email }
      : { stickerSubmissionId: props.stickerSubmissionId, cuteRating: rating, marketingOptIn: false };
    try {
      await props.api.submitSurvey(request);
      setSubmitted(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not send feedback. Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="survey-card" aria-labelledby="survey-title">
      <p className="eyebrow">One quick question</p>
      <h2 id="survey-title">Are the stickers cute?</h2>
      <fieldset className="rating-field">
        <legend>Rate from 1 to 5 stars</legend>
        <div className="rating-options">
          {ratings.map((value) => (
            <label key={value}>
              <input type="radio" name="cute-rating" value={value} aria-label={`${value} ${value === 1 ? 'star' : 'stars'}`} disabled={submitting}
                checked={rating === value} onChange={() => setRating(value)} />
              <span aria-hidden="true">★</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="marketing-choice">
        <input type="checkbox" checked={marketingOptIn} disabled={submitting} onChange={(event) => setMarketingOptIn(event.target.checked)} />
        <span>Email me Sprout product updates <small>Optional</small></span>
      </label>
      {marketingOptIn ? (
        <label className="email-field">Email
          <input type="email" value={email} autoComplete="email" disabled={submitting} onChange={(event) => setEmail(event.target.value)} />
        </label>
      ) : null}
      {error ? <div className="notice error" role="alert">{error}</div> : null}
      <button className="primary-action" type="button" disabled={submitting || !rating || (marketingOptIn && !emailIsValid)} onClick={() => void submit()}>
        {submitting ? 'Sending…' : 'Send feedback'}
      </button>
    </section>
  );
}
