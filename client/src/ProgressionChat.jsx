import { useEffect, useRef, useState } from 'react';

function exportGuide(session) {
  const lines = [
    'SKYADVISOR — PROGRESSION GUIDE',
    `Skill: ${session.skill}`,
    `Path: ${session.mode === 'item' ? 'Next item' : 'Next collection'}`,
    `Objective: ${session.objective.name} (${session.objective.id})`,
    `Saved snapshot: ${session.snapshot.fetchedAt || 'Unknown'}`,
    `Source: ${session.objective.wiki.url}`,
    '',
  ];
  if (session.objective.verification === 'not_in_readable_saved_inventory') {
    lines.push('Note: This item is not in readable saved containers; other storage may be unavailable.', '');
  }
  if (session.mode === 'collection') {
    lines.push(`Recorded collection: ${session.objective.currentAmount}`,
      `Next tier: ${session.objective.nextTier}; target: ${session.objective.targetAmount}; remaining: ${session.objective.remaining}`, '');
  }
  session.turns.forEach((turn, index) => {
    lines.push(`PART ${index + 1}: ${turn.heading}`);
    if (turn.choice) lines.push(`Selected topic: ${turn.choice}`);
    lines.push(turn.summary, '');
    turn.steps.forEach((step, stepIndex) => lines.push(`${stepIndex + 1}. ${step.title}`, `   ${step.detail}`, ''));
    lines.push('');
  });
  lines.push('This guide reflects a saved snapshot. Verify requirements against the linked Wiki before acting.');
  const blob = new Blob([lines.join('\r\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `SkyAdvisor-${session.skill}-${session.mode}-guide.txt`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function ProgressionChat({ playerUuid, profileId, skill, collectionId = null }) {
  const [mode, setMode] = useState(collectionId ? 'collection' : null);
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef(null);

  useEffect(() => () => controller.current?.abort(), []);

  function changeMode(nextMode) {
    controller.current?.abort();
    controller.current = null;
    setMode(nextMode);
    setSession(null);
    setLoading(false);
    setError('');
  }

  async function send(optionId = null) {
    if (!mode || controller.current || (optionId && !session?.canContinue)) return;
    const active = new AbortController();
    controller.current = active;
    setLoading(true);
    setError('');
    try {
      const endpoint = `/api/players/${encodeURIComponent(playerUuid)}/profiles/${encodeURIComponent(profileId)}/progression`;
      const response = await fetch(optionId ? `${endpoint}/${encodeURIComponent(session.sessionId)}/continue` : endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(optionId ? { optionId } : collectionId ? { collectionId } : { skill, mode }),
        cache: 'no-store', signal: AbortSignal.any([active.signal, AbortSignal.timeout(130000)]),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not generate this progression guide.');
      if (active.signal.aborted || controller.current !== active) return;
      if (data.contractVersion !== 1 || data.playerUuid !== playerUuid.replaceAll('-', '').toLowerCase()
          || data.profileId !== profileId.replaceAll('-', '').toLowerCase()
          || (collectionId ? data.objective?.id !== collectionId : data.skill !== skill)
          || data.mode !== mode || !Array.isArray(data.turns)) {
        throw new Error('The progression response was invalid. Please try again.');
      }
      setSession(data);
    } catch (requestError) {
      if (!active.signal.aborted && controller.current === active) {
        setError(requestError.name === 'TimeoutError' ? 'The request timed out. Try again.'
          : requestError instanceof SyntaxError ? 'The server sent an invalid response.'
            : requestError.message || 'Unable to reach the server.');
      }
    } finally {
      if (controller.current === active) {
        controller.current = null;
        setLoading(false);
      }
    }
  }

  return <div className="progression-chat">
    {session && <div className="progression-header"><button type="button" className="secondary" disabled={loading}
      onClick={() => changeMode(collectionId ? 'collection' : null)}>Start over</button></div>}
    {!session && <p className="hint">{collectionId ? 'Build a guide for this collection’s next verified tier.' : 'Choose an item or collection path.'}</p>}
    {!session && !collectionId && <div className="progression-modes" role="group" aria-label="Choose a progression route">
      <button type="button" className={mode === 'item' ? 'active' : 'secondary'} disabled={loading}
        aria-pressed={mode === 'item'} onClick={() => changeMode('item')}>Find my next item</button>
      <button type="button" className={mode === 'collection' ? 'active' : 'secondary'} disabled={loading}
        aria-pressed={mode === 'collection'} onClick={() => changeMode('collection')}>Choose my next collection</button>
    </div>}
    {!session && mode && <button type="button" disabled={loading} onClick={() => send()}>
      {loading ? 'Building your guide…' : 'Build step-by-step guide'}
    </button>}
    {loading && <p role="status" className="progression-busy">{session
      ? 'Continuing your selected topic…' : 'Checking saved data, Wiki information, and progression paths…'}</p>}
    {error && <p className="availability error" role="alert">{error}</p>}
    {session && <>
      <div className="progression-objective">
        {!collectionId && <><span className="recommendation-priority">{mode === 'item' ? 'Recommended item' : 'Recommended collection'}</span>
          <h3>{session.objective.name}</h3></>}
        {mode === 'collection' && <p>Recorded: {session.objective.currentAmount.toLocaleString()} · Next tier: {session.objective.nextTier}
          {' '}· {session.objective.remaining.toLocaleString()} more required</p>}
        {session.objective.verification === 'not_in_readable_saved_inventory' && <p className="availability partial">
          This item was not found in readable saved inventory. Unavailable containers may contain it; absence cannot be confirmed.</p>}
        <p className="hint">Wiki reference: <a target="_blank" rel="noreferrer" href={session.objective.wiki.url}>
          {session.objective.wiki.title}</a>. Advice reflects your saved snapshot, not live inventory.</p>
      </div>
      <div className="progression-turns">
        {session.turns.map((turn, index) => <article className="progression-turn" key={index}>
          {turn.choice && <p className="progression-choice">You chose: {turn.choice}</p>}
          <h3>{turn.heading}</h3><p>{turn.summary}</p>
          <ol className="progression-steps">{turn.steps.map((step, stepIndex) => <li key={stepIndex}>
            <strong>{step.title}</strong><p>{step.detail}</p>
          </li>)}</ol>
          {index === session.turns.length - 1 && session.canContinue && <div className="progression-next">
            <h5>What would you like to explore next?</h5>
            <div className="progression-options">{turn.options.map(option => <button type="button"
              key={option.id} className="secondary" disabled={loading} onClick={() => send(option.id)}>{option.label}</button>)}</div>
          </div>}
        </article>)}
      </div>
      {!session.canContinue && <p className="hint">You have reached the end of this guide. Export your steps or start another.</p>}
      <div className="progression-export"><button type="button" className="secondary" onClick={() => exportGuide(session)}>
        Download steps (.txt)</button></div>
    </>}
  </div>;
}
