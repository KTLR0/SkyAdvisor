import { useEffect, useId, useRef, useState } from 'react';

const GOALS = { general: 'General progress', farming: 'Farming', mining: 'Mining', combat: 'Combat' };
const FALLBACK_MESSAGES = {
  not_configured: 'AI is not connected on this server. Showing basic suggestions.',
  model_unavailable: 'AI is temporarily busy or unavailable. Showing basic suggestions; try again shortly.',
  model_access_denied: 'AI access is unavailable for this account. Showing basic suggestions.',
  model_quota: 'The AI usage limit has been reached. Showing basic suggestions.',
  model_not_found: 'The AI model is unavailable. Showing basic suggestions.',
  model_request_invalid: 'AI could not process this request. Showing basic suggestions.',
  timeout: 'AI took too long to respond. Showing basic suggestions.',
  invalid_response: 'AI advice could not be verified. Showing basic suggestions.',
  model_failed: 'AI could not be reached. Showing basic suggestions.',
};
const number = value => new Intl.NumberFormat(undefined, { maximumFractionDigits: 20 }).format(value);
const knownNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const canonicalId = value => value.replaceAll('-', '').toLowerCase();
const label = value => value[0].toUpperCase() + value.slice(1);

function SnapshotTime({ value }) {
  const date = typeof value === 'string' ? new Date(value) : null;
  return date && Number.isFinite(date.getTime())
    ? <time dateTime={value}>{date.toLocaleString()}</time> : <>Time unavailable</>;
}

function SavedFact({ fact }) {
  if (typeof fact.skill === 'string' && knownNumber(fact.xp)) return <>
    <strong>{label(fact.skill)}</strong>: {number(fact.xp)} XP
    {knownNumber(fact.level) && <> · Level {number(fact.level)}</>}
    {fact.atCap ? ' · At recorded cap' : knownNumber(fact.nextLevel) && knownNumber(fact.xpRemaining)
      && <> · {number(fact.xpRemaining)} XP to level {number(fact.nextLevel)}</>}
  </>;
  if (typeof fact.collectionId === 'string' && knownNumber(fact.amount)) return <>
    <strong>Collection <code>{fact.collectionId}</code></strong>: {number(fact.amount)} items collected
    {knownNumber(fact.targetAmount) && <> · Target: {number(fact.targetAmount)}</>}
    {knownNumber(fact.remaining) && <> · Remaining: {number(fact.remaining)}</>}
  </>;
  if (typeof fact.itemId === 'string') return <>
    <strong>Item <code>{fact.itemId}</code></strong>
    {knownNumber(fact.count) ? <> · Count: {number(fact.count)}</> : ' · Count not recorded'}
    {typeof fact.container === 'string' && <> · {fact.container}</>}
    {knownNumber(fact.slot) && <> · Slot {number(fact.slot)}</>}
  </>;
  if (fact.factId === 'snapshot:time') return <>Snapshot fetched: <SnapshotTime value={fact.fetchedAt} /></>;
  return <>Saved fact unavailable</>;
}

// Check the envelope belongs to this selection before displaying server-rendered advice.
function matchesSelection(data, playerUuid, profileId, goal) {
  return data?.contractVersion === 2 && data.playerUuid === canonicalId(playerUuid)
    && data.profileId === canonicalId(profileId) && data.goal === goal
    && ['ai', 'fallback'].includes(data.source) && data.snapshot && Array.isArray(data.actions)
    && data.actions.length <= 3 && data.actions.every((action, index) => action?.priority === index + 1
      && ['title', 'whatToDo', 'whyItFitsGoal'].every(key => typeof action[key] === 'string' && action[key].trim())
      && Array.isArray(action.evidence) && action.evidence.length > 0
      && action.evidence.every(fact => fact && typeof fact.factId === 'string'));
}

export default function RecommendationsView({ playerUuid, profileId }) {
  const id = useId();
  const [goal, setGoal] = useState('general');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const activeRequest = useRef(null);

  // The dashboard keys this component by player, profile, and saved snapshot.
  useEffect(() => () => activeRequest.current?.abort(), []);

  function changeGoal(event) {
    activeRequest.current?.abort();
    activeRequest.current = null;
    setGoal(event.target.value);
    setResult(null);
    setError('');
    setLoading(false);
  }

  async function getRecommendations() {
    if (activeRequest.current) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    setLoading(true);
    setResult(null);
    setError('');
    try {
      const response = await fetch(`/api/players/${encodeURIComponent(playerUuid)}/profiles/${encodeURIComponent(profileId)}/recommendations`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal }),
        cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]),
      });
      if (!response.ok) throw new Error(response.status === 404
        ? 'No saved snapshot is available for this profile. Reload saved data or fetch fresh data, then try again.'
        : 'Recommendations could not be loaded. Please try again.');
      const data = await response.json();
      if (controller.signal.aborted || activeRequest.current !== controller) return;
      if (!matchesSelection(data, playerUuid, profileId, goal)) {
        throw new Error('The recommendation response could not be read. Please try again.');
      }
      setResult(data);
    } catch (requestError) {
      if (!controller.signal.aborted && activeRequest.current === controller) {
        setError(requestError.name === 'TimeoutError' ? 'Getting recommendations timed out. Please try again.'
          : requestError instanceof TypeError ? 'Could not reach the server. Check your connection and try again.'
            : requestError instanceof SyntaxError ? 'The recommendation response could not be read. Please try again.'
              : requestError.message);
      }
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        setLoading(false);
      }
    }
  }

  return <section className="recommendations-section" aria-labelledby={`${id}-heading`}>
    <h2 id={`${id}-heading`}>Recommendations</h2>
    <p className="hint" id={`${id}-help`}>Choose a goal for this profile. Suggestions use its latest saved snapshot.</p>
    <div className="recommendation-controls">
      <div className="recommendation-goal">
        <label htmlFor={`${id}-goal`}>Your goal</label>
        <select id={`${id}-goal`} value={goal} onChange={changeGoal} aria-describedby={`${id}-help`}>
          {Object.entries(GOALS).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
        </select>
      </div>
      <button type="button" onClick={getRecommendations} disabled={loading}>
        {loading ? 'Getting recommendations…' : error ? 'Try again' : 'Get recommendations'}
      </button>
    </div>
    <div className="recommendation-results" aria-busy={loading}>
      {loading && <p role="status">Finding next steps for {GOALS[goal].toLowerCase()}… This can take up to a minute.</p>}
      {error && <p className="availability error" role="alert">{error}</p>}
      {!loading && !result && !error && <p className="hint recommendation-intro">Choose “Get recommendations” when you’re ready for suggestions.</p>}
      {result && <>
        <div className="recommendation-result-heading">
          <p role="status"><span className={`recommendation-source ${result.source}`}>
            {result.source === 'ai' ? 'AI' : 'Basic fallback'}</span> · {GOALS[goal]}</p>
          <p className="snapshot-time">Snapshot fetched: <SnapshotTime value={result.snapshot.fetchedAt} /></p>
        </div>
        <p className="hint">{result.source === 'ai' ? 'Chosen by AI from your saved facts.'
          : 'Basic suggestions based on your saved facts.'} These describe the saved snapshot, so progress since then may differ.</p>
        {result.source === 'fallback' && result.actions.length > 0 && <p className="availability partial" role="status">
          {FALLBACK_MESSAGES[result.fallbackReason] || 'AI is unavailable. Showing basic suggestions.'}
        </p>}
        {result.actions.length ? <ol className="recommendation-list">
          {result.actions.map(action => <li key={action.priority}>
            <article className="recommendation-card" aria-labelledby={`${id}-action-${action.priority}`}>
              <p className="recommendation-priority">Priority {action.priority}</p>
              <h3 id={`${id}-action-${action.priority}`}>{action.title}</h3>
              <h4>What to do</h4><p>{action.whatToDo}</p>
              <h4>Why it fits your goal</h4><p>{action.whyItFitsGoal}</p>
              <h4>Saved player facts</h4>
              <ul className="recommendation-evidence">{action.evidence.map(fact => <li key={fact.factId}>
                <SavedFact fact={fact} />
              </li>)}</ul>
            </article>
          </li>)}
        </ol> : <div className="availability" role="status">
          <strong>{result.fallbackReason === 'insufficient_evidence' ? 'No usable saved data for this goal.'
            : 'No next steps were suggested for this goal.'}</strong>
          <p>Try another goal or update your saved data with “Fetch fresh data” when you’re ready.</p>
        </div>}
      </>}
    </div>
  </section>;
}
