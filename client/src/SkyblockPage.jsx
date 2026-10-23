import { useCallback, useEffect, useRef, useState } from 'react';
import SkillsView from './SkillsView.jsx';
import TimelineView from './TimelineView.jsx';

const DATA_TABS = ['Skills', 'Collections', 'Inventory', 'Armor', 'Equipment',
  'Backpacks', 'Enderchest', 'Talismans', 'Pets', 'Timeline'];
const ITEM_TABS = new Set(['Inventory', 'Armor', 'Equipment', 'Backpacks', 'Enderchest', 'Talismans']);
const STATUS_LABELS = {
  available: 'Available', partial: 'Partially available', empty: 'Empty',
  missing: 'Not provided', private: 'API sharing disabled', unavailable: 'Unavailable',
};
const formatNumber = (value) => value === null || value === undefined ? 'Not provided'
  : new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);

function Availability({ data }) {
  if (!data || data.status === 'available') return null;
  return (
    <p className={`availability ${data.status}`} role="status">
      <strong>{STATUS_LABELS[data.status] || 'Unavailable'}.</strong>{' '}
      {data.reason || (data.status === 'empty' ? 'The API returned no entries for this category.'
        : 'This information was not provided. Check the player’s in-game API sharing settings.')}
    </p>
  );
}

function CollectionsView({ data }) {
  return <>
    <p className="hint">Personal item collection counts reported for this profile. These are counts, not collection tiers.</p>
    <Availability data={data} />
    {!!data?.entries?.length && <div className="table-scroll">
      <table className="collection-table">
        <caption>Items collected by this player</caption>
        <thead><tr><th scope="col">Collection</th><th scope="col">Items collected</th></tr></thead>
        <tbody>{data.entries.map((entry) => <tr key={entry.id} data-collection-id={entry.id}>
          <th scope="row">{entry.label}</th><td>{formatNumber(entry.amount)}</td>
        </tr>)}</tbody>
      </table>
    </div>}
  </>;
}

function ItemCard({ item, onClick }) {
  const [imageFailed, setImageFailed] = useState(false);
  const textureUrl = item.minecraftId && /^[a-z0-9_]+$/i.test(item.minecraftId)
    ? `https://mcasset.cloud/1.21.4/assets/minecraft/textures/item/${item.minecraftId.toLowerCase()}.png` : null;
  return <button type="button" className="mc-item" onClick={() => onClick(item)}
    title={`${item.name} · ${item.container}, slot ${item.slot}`}>
    <span className="mc-item-icon">
      {textureUrl && !imageFailed ? <img src={textureUrl} alt="" onError={() => setImageFailed(true)} />
        : <span aria-hidden="true">{item.name.slice(0, 2).toUpperCase()}</span>}
    </span>
    {item.count !== null && item.count > 1 && <span className="mc-item-count">{formatNumber(item.count)}</span>}
    <span className="mc-item-name">{item.name}</span>
  </button>;
}

// The optional item inspector preserves the existing advanced NBT inspection feature.
function JsonValue({ value, name, depth = 0 }) {
  const [expanded, setExpanded] = useState(depth < 1);
  if (value === null || typeof value !== 'object') {
    return <div className="json-row"><strong>{name}</strong><span>{String(value)}</span></div>;
  }
  const entries = Object.entries(value);
  return <div className="json-node">
    <button type="button" className="json-toggle" aria-expanded={expanded}
      onClick={() => setExpanded((current) => !current)}>
      {expanded ? '▼' : '▶'} {name || 'Item data'} ({entries.length})
    </button>
    {expanded && <div className="json-children">{entries.map(([key, child]) => (
      <JsonValue key={key} name={key} value={child} depth={depth + 1} />
    ))}</div>}
  </div>;
}

function ItemDetails({ item, onClose }) {
  useEffect(() => {
    const closeOnEscape = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);
  return <aside className="item-details" aria-labelledby="item-details-title">
    <div className="item-details-header"><h3 id="item-details-title">{item.name}</h3>
      <button type="button" onClick={onClose}>Close</button></div>
    <dl className="item-facts">
      <dt>Item ID</dt><dd><code>{item.id}</code></dd>
      <dt>Count</dt><dd>{formatNumber(item.count)}</dd>
      <dt>Location</dt><dd>{item.container}, slot {item.slot}</dd>
    </dl>
    {!!item.lore.length && <ul className="item-lore">{item.lore.map((line, index) => <li key={index}>{line}</li>)}</ul>}
    <details className="item-detail-json"><summary>Advanced NBT details</summary><JsonValue value={item.raw} /></details>
  </aside>;
}

function InventoryView({ data, onItemClick }) {
  return <>
    <Availability data={data} />
    {!!data?.items?.length && <>
      <p className="hint">{data.items.length} item stacks. Select an item to see its count, location, lore, and details.</p>
      <div className="item-grid">{data.items.map((item, index) => (
        <ItemCard key={`${item.container}:${item.slot}:${index}`} item={item} onClick={onItemClick} />
      ))}</div>
    </>}
  </>;
}

function PetsView({ data }) {
  return <><Availability data={data} /><div className="skill-grid">
    {(data?.entries || []).map((pet) => <article key={pet.id} className="skill-card">
      <h3>{pet.name}</h3><p>{pet.rarity}{pet.active ? ' · Active pet' : ''}</p><p>{formatNumber(pet.xp)} XP</p>
    </article>)}
  </div></>;
}

async function readResponse(response) {
  let data;
  try { data = await response.json(); } catch { throw new Error('Could not read the server response. Check the server and try again.'); }
  if (!response.ok) {
    const retry = data.retryAfterMs ? ` Try again in about ${Math.ceil(data.retryAfterMs / 60000)} minutes.` : '';
    throw new Error((data.error || 'The request failed. Please try again.') + retry);
  }
  return data;
}

export default function SkyBlockPage({ player, onBack }) {
  const [storedData, setStoredData] = useState(null);
  const [selectedProfileId, setSelectedProfileId] = useState(null);
  const [selectedTab, setSelectedTab] = useState('Skills');
  const [selectedItem, setSelectedItem] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isFetching, setIsFetching] = useState(false);
  const [error, setError] = useState('');
  const [fetchMessage, setFetchMessage] = useState('');
  const refreshController = useRef(null);
  const endpoint = `/api/player/${encodeURIComponent(player.name)}/skyblock`;

  const loadStoredData = useCallback(async (signal) => {
    setIsLoading(true);
    setError('');
    try {
      const response = await fetch(`/api/player/${encodeURIComponent(player.name)}/skyblock?uuid=${player.uuid}`, {
        cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      });
      const data = await readResponse(response);
      if (signal?.aborted) return false;
      setStoredData(data);
      setSelectedProfileId((current) => data.profiles.some((entry) => entry.profileId === current) ? current
        : (data.profiles.find((entry) => entry.selected) || data.profiles[0])?.profileId ?? null);
      setSelectedItem(null);
      return true;
    } catch (requestError) {
      if (!signal?.aborted) setError(requestError.name === 'TimeoutError' ? 'Loading saved data timed out. Try again.'
        : requestError.message || 'Could not load saved data.');
      return false;
    } finally {
      if (!signal?.aborted) setIsLoading(false);
    }
  }, [player.name, player.uuid]);

  useEffect(() => {
    const controller = new AbortController();
    loadStoredData(controller.signal);
    return () => { controller.abort(); refreshController.current?.abort(); };
  }, [loadStoredData]);

  async function fetchFreshData() {
    setError('');
    setFetchMessage('');
    setIsFetching(true);
    refreshController.current = new AbortController();
    try {
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uuid: player.uuid }),
        signal: AbortSignal.any([refreshController.current.signal, AbortSignal.timeout(45000)]),
      });
      const data = await readResponse(response);
      if (await loadStoredData(refreshController.current.signal)) {
        setFetchMessage(`Saved and loaded ${data.profiles.length} profile${data.profiles.length === 1 ? '' : 's'}.`);
      }
    } catch (requestError) {
      if (!refreshController.current.signal.aborted) setError(requestError.name === 'TimeoutError'
        ? 'Fetching timed out. Reload saved data before trying another fetch.' : requestError.message);
    } finally {
      setIsFetching(false);
    }
  }

  const profile = storedData?.profiles.find((entry) => entry.profileId === selectedProfileId);
  const currentData = profile?.data[selectedTab];
  const fetchedAt = profile?.fetchedAt ? new Date(profile.fetchedAt) : null;

  return <main className="skyblock-page">
    <header className="skyblock-header">
      <div><p className="eyebrow">SkyAdvisor · Player dashboard</p><h1>{player.name}</h1>
        <p className="player-uuid">Player UUID: <code>{player.uuid}</code></p>
        {profile && <><h2 className="selected-profile">{profile.profile} profile</h2>
          <p className="snapshot-time">Last fetched: {fetchedAt
            ? <time dateTime={profile.fetchedAt}>{fetchedAt.toLocaleString()}</time> : 'Unknown for this saved snapshot'}</p></>}
      </div>
      <div className="skyblock-actions">
        <button type="button" onClick={fetchFreshData} disabled={isFetching || isLoading}>
          {isFetching ? 'Fetching fresh data…' : 'Fetch fresh data'}
        </button>
        <button type="button" className="secondary" onClick={() => loadStoredData()} disabled={isFetching || isLoading}>Reload saved data</button>
        <button type="button" className="secondary" onClick={onBack} disabled={isFetching}>Back</button>
      </div>
    </header>
    <p className="hint">Fresh data is fetched only when you request it. Limit: once per hour and four times per 24 hours per player.</p>
    {error && <p className="availability error" role="alert">{error}</p>}
    {fetchMessage && <p className="status online" role="status">{fetchMessage}</p>}
    {(isLoading || isFetching) && <p role="status">{isFetching ? 'Fetching and saving this player’s profiles…' : 'Loading saved profiles…'}</p>}
    {!isLoading && storedData?.profiles.length === 0 && <section className="empty-state">
      <h2>No saved profiles yet</h2><p>Choose “Fetch fresh data” to retrieve this player’s SkyBlock profiles and save a snapshot.</p>
    </section>}
    {profile && <>
      <section className="profile-section" aria-labelledby="profiles-heading">
        <h2 id="profiles-heading">Select a profile</h2>
        <div className="profile-tabs">{storedData.profiles.map((entry) => <button type="button"
          key={entry.profileId} className={selectedProfileId === entry.profileId ? 'active' : ''}
          aria-pressed={selectedProfileId === entry.profileId}
          onClick={() => { setSelectedProfileId(entry.profileId); setSelectedItem(null); }}>
          {entry.profile}
        </button>)}</div>
        <p className="hint profile-id">Profile ID: <code>{profile.profileId}</code></p>
      </section>
      <section className="data-section" aria-label="Profile data">
        <nav className="data-tabs" aria-label="Data categories">{DATA_TABS.map((tab) => <button type="button" key={tab}
          className={selectedTab === tab ? 'active' : ''} aria-pressed={selectedTab === tab}
          onClick={() => { setSelectedTab(tab); setSelectedItem(null); }}>{tab}</button>)}</nav>
        <h2>{selectedTab === 'Enderchest' ? 'Ender chest' : selectedTab}</h2>
        {selectedTab !== 'Timeline' && profile.sourceSchemaVersion < 2 && <p className="hint">Older snapshot: some unavailable values cannot be recovered. Fetch fresh data for explicit availability.</p>}
        {selectedTab === 'Timeline' && <TimelineView key={`${player.uuid}:${profile.profileId}`}
          playerUuid={player.uuid} profileId={profile.profileId} />}
        {selectedTab === 'Skills' && <SkillsView data={currentData} />}
        {selectedTab === 'Collections' && <CollectionsView data={currentData} />}
        {ITEM_TABS.has(selectedTab) && <InventoryView data={currentData} onItemClick={setSelectedItem} />}
        {selectedTab === 'Pets' && <PetsView data={currentData} />}
      </section>
      {selectedItem && <ItemDetails item={selectedItem} onClose={() => setSelectedItem(null)} />}
    </>}
  </main>;
}
