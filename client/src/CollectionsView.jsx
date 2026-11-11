import { useId, useState } from 'react';
import { groupCollections, savedCount } from './collection-groups.js';
import farming from './assets/collections/farming.svg';
import mining from './assets/collections/mining.svg';
import combat from './assets/collections/combat.svg';
import foraging from './assets/collections/foraging.svg';
import fishing from './assets/collections/fishing.svg';
import rift from './assets/collections/rift.svg';
import collection from './assets/collections/collection.svg';

const icons = { FARMING: farming, MINING: mining, COMBAT: combat, FORAGING: foraging, FISHING: fishing, RIFT: rift };
const number = value => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);

function CategoryIcon({ category }) {
  const [failed, setFailed] = useState(false);
  return <span className="collection-icon" aria-hidden="true">
    {failed ? <svg data-collection-fallback="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
    </svg> : <img src={icons[category] || collection} alt="" onError={() => setFailed(true)} />}
  </span>;
}

export default function CollectionsView({ data, onPlan }) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('name-asc');
  const readable = ['available', 'partial'].includes(data?.status);
  const groups = groupCollections(data, query, sort);
  const resultCount = groups.reduce((count, group) => count + group.entries.length, 0);

  if (!readable || !data.entries?.length) {
    const title = data?.status === 'private' ? 'Collection sharing is disabled'
      : data?.status === 'empty' ? 'No collections recorded' : 'Collection data unavailable';
    return <div className="collections-view collections-state" role="status"><h3>{title}</h3>
      <p>{data?.reason || (data?.status === 'private' ? 'Enable collection API sharing in-game, then fetch a new snapshot when available.'
        : 'There are no reliable collection records in this saved snapshot.')}</p></div>;
  }

  return <div className="collections-view">
    <p className="hint">Saved collection counts, grouped by category. Search by name or sort within each group.</p>
    {data.status === 'partial' && <p className="availability partial" role="status">{data.reason || 'Some collection counts are unavailable. Recorded values are shown below.'}</p>}
    <div className="collections-controls">
      <div><label htmlFor={`${id}-search`}>Search collections</label>
        <input id={`${id}-search`} type="search" value={query} placeholder="Search by collection name"
          onChange={event => setQuery(event.target.value)} /></div>
      <div><label htmlFor={`${id}-sort`}>Sort within categories</label>
        <select id={`${id}-sort`} value={sort} onChange={event => setSort(event.target.value)}>
          <option value="name-asc">Name: A–Z</option><option value="name-desc">Name: Z–A</option>
          <option value="count-desc">Count: high to low</option><option value="count-asc">Count: low to high</option>
        </select></div>
    </div>
    <p className="collections-results" role="status">{resultCount} of {data.entries.length} saved collections</p>
    {!groups.length && <div className="collections-state"><h3>No matching collections</h3>
      <p>Try another name or clear your search.</p><button type="button" className="secondary" onClick={() => setQuery('')}>Clear search</button></div>}
    {groups.map(group => <section key={group.key} className="collection-group" data-collection-category={group.key || 'uncategorized'}
      aria-label={`${group.name} collections`}>
      <h3>{group.name}<span>{group.entries.length}</span></h3>
      <ul className="collection-list">{group.entries.map(entry => {
        const count = savedCount(entry, data);
        return <li key={entry.id} className="collection-row" data-collection-id={entry.id}>
          <CategoryIcon category={group.key} />
          <h4>{entry.label}</h4>
          <p className={`collection-count${count === null ? ' is-unavailable' : ''}`}>
            <strong>{count === null ? 'Not provided' : number(count)}</strong><span>{count === null ? 'Count unavailable' : 'Items collected'}</span></p>
          {count !== null ? <button type="button" className="secondary collection-plan" aria-label={`Plan next steps for ${entry.label}`}
            onClick={() => onPlan(entry)}>Plan next steps</button> : <span className="collection-plan-unavailable">Planning unavailable</span>}
        </li>;
      })}</ul>
    </section>)}
  </div>;
}
