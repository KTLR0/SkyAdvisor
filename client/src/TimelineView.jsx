import { useCallback, useEffect, useRef, useState } from 'react';

const number = value => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
const date = value => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });

async function readSaved(url, signal) {
  const response = await fetch(url, {
    method: 'GET', cache: 'no-store',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Saved snapshots could not be loaded.');
  return data;
}

function Change({ entry, hasPrevious }) {
  if (!hasPrevious) return <span aria-label="First recorded snapshot">—</span>;
  if (entry.status === 'unavailable' || entry.delta === null) return <span className="hint">Comparison unavailable</span>;
  if (entry.status === 'decrease' || entry.unexpectedDecrease) {
    return <span className="timeline-decrease">Unexpected decrease: −{number(Math.abs(entry.delta))} {entry.unit}</span>;
  }
  return <span>{entry.delta === 0 ? 'No change (0' : `+${number(entry.delta)}`} {entry.unit}{entry.delta === 0 ? ')' : ''}</span>;
}

function HistoryCategory({ name, data, changes, hasPrevious }) {
  const entries = changes?.entries || [];
  return <section className="timeline-category" aria-label={`Historical ${name}`}>
    <h3>{name}</h3>
    {!['available', 'partial'].includes(data?.status) && <p className="hint">
      {data?.reason || (data?.status === 'empty' ? 'No saved entries.' : 'Saved values are unavailable for this snapshot.')}
    </p>}
    {hasPrevious && changes?.status === 'unavailable' && <p className="hint">Comparison unavailable</p>}
    {entries.length > 0 && <table className="collection-table timeline-table">
      <caption>Saved {name === 'Skills' ? 'skill XP' : 'collection counts'} and changes</caption>
      <thead><tr><th scope="col">{name === 'Skills' ? 'Skill' : 'Collection'}</th>
        <th scope="col">{name === 'Skills' ? 'Saved XP' : 'Saved count'}</th>
        <th scope="col">Change since previous</th></tr></thead>
      <tbody>{entries.map(entry => <tr key={entry.id} data-history-entry={entry.id}>
        <th scope="row">{entry.label}</th>
        <td>{entry.current === null ? 'Unavailable' : number(entry.current)}</td>
        <td><Change entry={entry} hasPrevious={hasPrevious} /></td>
      </tr>)}</tbody>
    </table>}
  </section>;
}

export default function TimelineView({ playerUuid, profileId }) {
  const base = `/api/players/${encodeURIComponent(playerUuid)}/profiles/${encodeURIComponent(profileId)}/snapshots`;
  const [snapshots, setSnapshots] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailAttempt, setDetailAttempt] = useState(0);
  const listRequest = useRef(null);
  const strip = useRef(null);

  const loadPage = useCallback(async (cursor = null, selectFirst = false) => {
    listRequest.current?.abort();
    const controller = new AbortController();
    listRequest.current = controller;
    setListLoading(true);
    setListError('');
    try {
      const result = await readSaved(`${base}?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, controller.signal);
      if (controller.signal.aborted) return;
      setSnapshots(current => cursor ? [...current, ...result.snapshots] : result.snapshots);
      setNextCursor(result.page.nextCursor);
      setSelectedId(current => selectFirst ? result.snapshots[0]?.snapshotId ?? current
        : current ?? result.snapshots[0]?.snapshotId ?? null);
    } catch (error) {
      if (!controller.signal.aborted) setListError(error.name === 'TimeoutError'
        ? 'Loading saved dates timed out. Please try again.' : 'Could not load saved dates. ' + error.message);
    } finally {
      if (!controller.signal.aborted) setListLoading(false);
    }
  }, [base]);

  useEffect(() => {
    loadPage();
    return () => listRequest.current?.abort();
  }, [loadPage]);

  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    setDetail(null);
    setDetailError('');
    setDetailLoading(true);
    readSaved(`${base}/${encodeURIComponent(selectedId)}`, controller.signal)
      .then(result => { if (!controller.signal.aborted) setDetail(result); })
      .catch(error => {
        if (!controller.signal.aborted) setDetailError(error.name === 'TimeoutError'
          ? 'Loading the saved snapshot timed out. Please try again.' : 'Could not load this snapshot. ' + error.message);
      })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [base, selectedId, detailAttempt]);

  useEffect(() => {
    strip.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selectedId]);

  const selectedIndex = snapshots.findIndex(snapshot => snapshot.snapshotId === selectedId);
  const visibleDetail = detail?.snapshot.snapshotId === selectedId ? detail : null;
  function previous() {
    if (selectedIndex + 1 < snapshots.length) setSelectedId(snapshots[selectedIndex + 1].snapshotId);
    else if (nextCursor) loadPage(nextCursor, true);
  }

  return <div className="timeline-view">
    <p className="hint">Browse saved snapshots for this profile, newest first. Dates include local times. Changes use the immediately previous saved snapshot.</p>
    <div className="timeline-controls">
      <button type="button" className="secondary" onClick={previous} aria-label="Previous snapshot (older)"
        disabled={listLoading || selectedIndex < 0 || (selectedIndex === snapshots.length - 1 && !nextCursor)}>Previous</button>
      <button type="button" className="secondary" onClick={() => setSelectedId(snapshots[selectedIndex - 1].snapshotId)}
        aria-label="Next snapshot (newer)" disabled={selectedIndex <= 0}>Next</button>
      <span className="hint">Previous: older · Next: newer</span>
    </div>
    {snapshots.length > 0 && <div className="timeline-strip" ref={strip} role="group" aria-label="Saved snapshot dates">
      {snapshots.map(snapshot => <button type="button" key={snapshot.snapshotId}
        className={`timeline-date${selectedId === snapshot.snapshotId ? ' active' : ''}`}
        aria-pressed={selectedId === snapshot.snapshotId} onClick={() => setSelectedId(snapshot.snapshotId)}>
        <time dateTime={snapshot.fetchedAt}>{date(snapshot.fetchedAt)}</time>
      </button>)}
    </div>}
    {listLoading && <p role="status">Loading saved dates…</p>}
    {listError && <div className="timeline-error" role="alert"><p>{listError}</p>
      <button type="button" className="secondary" onClick={() => loadPage(nextCursor)} disabled={listLoading}>Retry dates</button>
    </div>}
    {!listLoading && !listError && snapshots.length === 0 && <p className="empty-state">No saved snapshots for this profile.</p>}
    {nextCursor && !listError && <button type="button" className="secondary timeline-load"
      onClick={() => loadPage(nextCursor)} disabled={listLoading}>Load older snapshots</button>}
    {selectedId && (detailLoading || (!visibleDetail && !detailError)) && <p role="status">Loading saved snapshot…</p>}
    {detailError && <div className="timeline-error" role="alert"><p>{detailError}</p>
      <button type="button" className="secondary" onClick={() => setDetailAttempt(current => current + 1)}>Retry snapshot</button>
    </div>}
    {visibleDetail && <div className="timeline-detail">
      <h3>Snapshot from <time dateTime={visibleDetail.snapshot.fetchedAt}>{date(visibleDetail.snapshot.fetchedAt)}</time></h3>
      {visibleDetail.previousSnapshot ? <p className="hint">Compared with <time dateTime={visibleDetail.previousSnapshot.fetchedAt}>
        {date(visibleDetail.previousSnapshot.fetchedAt)}</time></p> : <p className="timeline-first">First recorded snapshot</p>}
      {['Skills', 'Collections'].map(name => <HistoryCategory key={name} name={name}
        data={visibleDetail.snapshot.data[name]} changes={visibleDetail.changes[name]}
        hasPrevious={Boolean(visibleDetail.previousSnapshot)} />)}
    </div>}
  </div>;
}
