import { useCallback, useEffect, useRef, useState } from 'react';
import SkillsView from './SkillsView.jsx';
import TimelineView from './TimelineView.jsx';
import ProgressionChat from './ProgressionChat.jsx';
import OverviewView from './OverviewView.jsx';
import useSkillResource from './useSkillResource.js';
import CollectionsView from './CollectionsView.jsx';

const DATA_TABS = ['Overview', 'Skills', 'Collections', 'Inventory', 'Armor', 'Equipment',
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

// Keep Skills mounted while the planner resets with its player/profile/snapshot.
function ProfileData({ profile, playerUuid, selectedTab, onSelectTab, onItemClick }) {
  const skillResource = useSkillResource();
  const scope = `${playerUuid}:${profile.profileId}:${profile.fetchedAt ?? ''}`;
  const [selection, setSelection] = useState(null);
  const target = selection?.scope === scope ? selection : null;
  const activeTab = selectedTab === 'Planner' && !target ? 'Overview' : selectedTab;
  const returnTab = target?.kind === 'collection' ? 'Collections' : 'Skills';
  function openPlanner(kind, entry) {
    setSelection(current => current?.scope === scope && current.kind === kind && current.id === entry.id
      ? current : { scope, kind, id: entry.id, label: entry.label });
    onSelectTab('Planner');
  }
  const heading = useRef(null);
  const navigation = useRef(null);

  useEffect(() => { setSelection(null); }, [scope]);

  useEffect(() => {
    navigation.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === 'Planner') {
      heading.current?.focus();
      heading.current?.scrollIntoView({ block: 'start' });
    }
  }, [activeTab, target?.kind, target?.id]);

  return <section className="data-section" aria-label="Profile data">
    <nav ref={navigation} className="data-tabs" aria-label="Data categories">{DATA_TABS.map((tab) => <button type="button" key={tab}
      className={activeTab === tab ? 'active' : ''} aria-pressed={activeTab === tab}
      onClick={() => onSelectTab(tab)}>{tab}</button>)}</nav>
    <div className="planner-page-header">
      <h2 ref={heading} tabIndex={-1}>{activeTab === 'Planner' ? `Next steps for ${target.label}`
        : activeTab === 'Enderchest' ? 'Ender chest' : activeTab}</h2>
      {activeTab === 'Planner' && <button type="button" className="secondary" onClick={() => onSelectTab(returnTab)}>Back to {returnTab}</button>}
    </div>
    {activeTab !== 'Timeline' && profile.sourceSchemaVersion < 2 && <p className="hint">Older snapshot: some unavailable values cannot be recovered. Fetch fresh data for explicit availability.</p>}
    {activeTab === 'Overview' && <OverviewView data={profile.data} skillResource={skillResource} onSelectTab={onSelectTab} />}
    {activeTab === 'Timeline' && <TimelineView key={`${playerUuid}:${profile.profileId}`}
      playerUuid={playerUuid} profileId={profile.profileId} />}
    <div hidden={activeTab !== 'Skills'}><SkillsView data={profile.data.Skills}
      {...skillResource} onPlan={skill => openPlanner('skill', profile.data.Skills.entries.find(entry => entry.id === skill))} /></div>
    <div hidden={activeTab !== 'Planner'}>{target && <ProgressionChat key={`${scope}:${target.kind}:${target.id}`}
      playerUuid={playerUuid} profileId={profile.profileId}
      skill={target.kind === 'skill' ? target.id : null} collectionId={target.kind === 'collection' ? target.id : null} />}</div>
    <div hidden={activeTab !== 'Collections'}><CollectionsView key={scope} data={profile.data.Collections}
      onPlan={entry => openPlanner('collection', entry)} /></div>
    {ITEM_TABS.has(activeTab) && <InventoryView data={profile.data[activeTab]} onItemClick={onItemClick} />}
    {activeTab === 'Pets' && <PetsView data={profile.data.Pets} />}
  </section>;
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
  const [selectedTab, setSelectedTab] = useState('Overview');
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
  const fetchedAt = profile?.fetchedAt ? new Date(profile.fetchedAt) : null;
  const hasSavedTime = fetchedAt && Number.isFinite(fetchedAt.getTime());

  return <main className="skyblock-page">
    <header className="skyblock-header">
      <div className="player-context"><p className="eyebrow">SkyAdvisor</p>
        <div className="player-title"><h1>{player.name}</h1>
          <button type="button" className="category-link" onClick={onBack} disabled={isFetching}>Change player</button></div>
        {profile && <div className="profile-context"><label htmlFor="dashboard-profile">Profile</label>
          <select id="dashboard-profile" value={selectedProfileId}
            onChange={event => { setSelectedProfileId(event.target.value); setSelectedItem(null); }}>
            {storedData.profiles.map(entry => <option key={entry.profileId} value={entry.profileId}>{entry.profile}</option>)}
          </select>
          <p className="snapshot-time">Saved: {hasSavedTime
            ? <time dateTime={profile.fetchedAt}>{fetchedAt.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time>
            : 'Time unavailable'}</p></div>}
      </div>
      <div className="header-utilities">
        <div className="skyblock-actions">
          <button type="button" onClick={fetchFreshData} disabled={isFetching || isLoading}>
            {isFetching ? 'Fetching fresh data…' : 'Fetch fresh data'}
          </button>
          <button type="button" className="secondary" onClick={() => loadStoredData()} disabled={isFetching || isLoading}>Reload saved data</button>
        </div>
        <details className="data-details"><summary>Data details &amp; fetch limits</summary>
          <p className="player-uuid">Player UUID: <code>{player.uuid}</code></p>
          {profile && <p className="profile-id">Profile ID: <code>{profile.profileId}</code></p>}
          <p className="hint">Fresh data is fetched only when you request it. Limit: once per hour and four times per 24 hours per player. Reload saved data reads stored snapshots.</p>
        </details>
      </div>
    </header>
    {error && <p className="availability error" role="alert">{error}</p>}
    {fetchMessage && <p className="status online" role="status">{fetchMessage}</p>}
    {(isLoading || isFetching) && <p role="status">{isFetching ? 'Fetching and saving this player’s profiles…' : 'Loading saved profiles…'}</p>}
    {!isLoading && storedData?.profiles.length === 0 && <section className="empty-state">
      <h2>No saved profiles yet</h2><p>Choose “Fetch fresh data” to retrieve this player’s SkyBlock profiles and save a snapshot.</p>
    </section>}
    {profile && <>
      <ProfileData profile={profile} playerUuid={player.uuid} selectedTab={selectedTab}
        onSelectTab={(tab) => { setSelectedTab(tab); setSelectedItem(null); }} onItemClick={setSelectedItem} />
      {selectedItem && <ItemDetails item={selectedItem} onClose={() => setSelectedItem(null)} />}
    </>}
  </main>;
}
