import { calculateSkillProgress, displayPercent } from './skill-progress.js';

const number = value => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
const reliable = value => value.status === 'available' && typeof value.xp === 'number' && Number.isFinite(value.xp) && value.xp >= 0;
const readable = data => ['available', 'partial'].includes(data?.status);
const statusText = data => data?.status === 'private' ? 'API sharing is disabled.'
  : data?.status === 'empty' ? 'No entries recorded in this snapshot.'
    : data?.reason || 'Saved information is unavailable.';

export default function OverviewView({ data, skillResource, onSelectTab }) {
  const skills = readable(data.Skills) ? data.Skills.entries || [] : [];
  const collections = readable(data.Collections) ? data.Collections.entries || [] : [];
  const availableCollections = collections.filter(entry => entry.status === 'available'
    && typeof entry.amount === 'number' && Number.isFinite(entry.amount) && entry.amount >= 0);

  return <div className="overview-grid">
    <article className="overview-card overview-skills" aria-labelledby="overview-skills-heading">
      <div className="overview-card-heading"><h3 id="overview-skills-heading">Skills</h3>
        <button type="button" className="category-link" onClick={() => onSelectTab('Skills')}>View Skills</button></div>
      {skills.length ? <ul className="overview-skill-list">{skills.slice(0, 2).map(entry => {
        const progress = calculateSkillProgress(entry, skillResource.resource?.skills[entry.id], data.Skills.status);
        const hasProgress = progress.status !== 'unavailable';
        const percent = progress.status === 'max' ? 100 : Math.min(99.9, Math.round(progress.percent * 10) / 10);
        return <li key={entry.id} data-preview-skill={entry.id}>
          <div className="overview-skill-heading"><strong>{entry.label}</strong><span>{hasProgress ? `Level ${progress.level}`
            : reliable(entry) && skillResource.loading ? 'Loading level…' : 'Unavailable'}</span></div>
          {hasProgress ? <>
            <div className="skill-progress-track" role="progressbar" aria-label={`${entry.label} level progress`}
              aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
              aria-valuetext={progress.status === 'max' ? 'Skill cap reached' : `${displayPercent(progress.percent)}% toward level ${progress.nextLevel}`}>
              <span className="skill-progress-fill" style={{ width: `${progress.percent}%` }} /></div>
            <small>{progress.status === 'max' ? 'Skill cap reached' : `${number(Math.ceil(progress.xpRemaining))} XP to level ${progress.nextLevel}`}</small>
          </> : <small>{reliable(entry) ? `${number(entry.xp)} saved XP · Level unavailable` : 'XP not provided'}</small>}
        </li>;
      })}</ul> : <p className="overview-status">{statusText(data.Skills)}</p>}
      {data.Skills?.status === 'partial' && <p className="hint">Some skill information is unavailable.</p>}
      {skillResource.error && skills.length > 0 && <p className="hint">Level thresholds unavailable. Open Skills to retry.</p>}
      {skillResource.resource?.stale && skills.length > 0 && <p className="hint">Levels use previously verified, cached thresholds.</p>}
    </article>
    <article className="overview-card overview-collections" aria-labelledby="overview-collections-heading">
      <div className="overview-card-heading"><h3 id="overview-collections-heading">Collections</h3>
        <button type="button" className="category-link" onClick={() => onSelectTab('Collections')}>View Collections</button></div>
      {availableCollections.length ? <>
        <p className="overview-summary"><strong>{number(availableCollections.length)}</strong> collection counts available</p>
        <ul className="overview-collection-list">{availableCollections.slice(0, 2).map(entry => <li key={entry.id}>
          <span>{entry.label}</span><strong>{number(entry.amount)}</strong></li>)}</ul>
        {(data.Collections.status === 'partial' || availableCollections.length < collections.length)
          && <p className="hint">Some collection counts are unavailable.</p>}
      </> : <p className="overview-status">{readable(data.Collections) ? 'No reliable collection counts recorded.' : statusText(data.Collections)}</p>}
    </article>
    <article className="overview-card overview-timeline" aria-labelledby="overview-timeline-heading">
      <div><h3 id="overview-timeline-heading">Timeline</h3><p>Compare snapshots.</p></div>
      <button type="button" className="secondary" onClick={() => onSelectTab('Timeline')}>Open Timeline</button>
    </article>
  </div>;
}
