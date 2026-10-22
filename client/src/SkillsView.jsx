import { useCallback, useEffect, useId, useState } from 'react';
import { calculateSkillProgress, displayPercent } from './skill-progress.js';

const number = (value) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);

function SkillCard({ entry, definition, categoryStatus, loading }) {
  const titleId = useId();
  const descriptionId = useId();
  const progress = calculateSkillProgress(entry, definition, categoryStatus);
  const reliableXp = entry.status === 'available' && typeof entry.xp === 'number'
    && Number.isFinite(entry.xp) && entry.xp >= 0
    && !['private', 'missing', 'unavailable', 'empty'].includes(categoryStatus);
  const available = progress.status !== 'unavailable';
  const maxed = progress.status === 'max';
  const percentage = maxed ? 100 : Math.min(99.9, Math.max(0, Math.round(progress.percent * 10) / 10));
  const remaining = available ? Math.ceil(progress.xpRemaining) : null;
  const description = maxed ? `${entry.label}, level ${progress.level}. Max level reached.`
    : available ? `${entry.label}, level ${progress.level}. ${displayPercent(progress.percent)} percent toward level ${progress.nextLevel}. ${number(remaining)} XP remaining.` : null;

  return <article className={`skill-card skill-progress-card${maxed ? ' is-maxed' : ''}`}
    data-skill-id={entry.id}>
    <div className="skill-card-heading">
      <h3 id={titleId}>{entry.label}</h3>
      <span className={`skill-level${available ? '' : ' is-unavailable'}`}>
        {available ? `Level ${progress.level}` : loading && reliableXp ? 'Loading level…' : 'Unavailable'}
      </span>
    </div>
    <p className="skill-total-xp">Total XP <strong>{reliableXp
      ? `${Math.round(entry.xp * 100) / 100 !== entry.xp ? '≈ ' : ''}${number(entry.xp)}` : 'Unavailable'}</strong></p>
    {available ? <>
      <div className="skill-progress-label">
        <strong>{maxed ? 'Max level' : `${displayPercent(progress.percent)}%`}</strong>
        <span>{maxed ? 'Skill cap reached' : `toward level ${progress.nextLevel}`}</span>
      </div>
      <div className="skill-progress-track" role="progressbar" aria-labelledby={titleId}
        aria-describedby={descriptionId} aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={percentage} aria-valuetext={description}>
        <span className="skill-progress-fill" style={{ width: `${progress.percent}%` }} />
      </div>
      <p id={descriptionId} className="skill-remaining">
        {maxed ? <>No XP remaining at level {progress.level}.</>
          : <><strong>{number(remaining)} XP</strong> remaining to level {progress.nextLevel}</>}
      </p>
    </> : <p className="skill-progress-unavailable" role="status">
      {loading && reliableXp ? 'Loading official skill thresholds…' : progress.reason}
    </p>}
  </article>;
}

export default function SkillsView({ data }) {
  const [resource, setResource] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const loadResource = useCallback(async (signal) => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/resources/skills', {
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000),
      });
      if (!response.ok) throw new Error('Official skill thresholds are unavailable. XP totals are still shown.');
      const result = await response.json();
      if (!result.skills || typeof result.skills !== 'object') throw new Error('Official skill thresholds are unavailable.');
      if (!signal?.aborted) setResource(result);
    } catch (requestError) {
      if (!signal?.aborted) {
        setResource(null);
        setError(requestError.name === 'TimeoutError' ? 'Loading skill thresholds timed out. Please try again.'
          : requestError.message);
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadResource(controller.signal);
    return () => controller.abort();
  }, [loadResource]);

  return <>
    <p className="hint skill-section-intro">Your XP toward each skill’s next level. Missing XP and unknown level caps are never treated as zero.</p>
    {data?.status !== 'available' && <p className={`availability ${data?.status || 'unavailable'}`}>
      <strong>{data?.status === 'partial' ? 'Some skills are unavailable.' : 'Unavailable.'}</strong>{' '}
      {data?.status === 'partial' ? 'Each card explains any missing XP or cap information.'
        : data?.reason || 'Reliable skill XP was not provided for this profile.'}
    </p>}
    {error && <div className="skill-resource-error" role="status">
      <p>{error}</p><button type="button" className="secondary" onClick={() => loadResource()} disabled={loading}>Retry thresholds</button>
    </div>}
    {resource?.stale && <p className="availability partial" role="status">Hypixel is unavailable. Showing progress using previously verified, cached thresholds.</p>}
    <div className="skill-grid skill-progress-grid" aria-busy={loading}>
      {(data?.entries || []).map((entry) => <SkillCard key={entry.id} entry={entry}
        definition={resource?.skills[entry.id]} categoryStatus={data.status} loading={loading} />)}
    </div>
    <p className="hint skill-source">Level thresholds: <a href="https://api.hypixel.net/v2/resources/skyblock/skills" target="_blank" rel="noreferrer">Hypixel Skills resource</a>.
      {' '}Remaining XP is rounded up to a whole XP.</p>
  </>;
}
