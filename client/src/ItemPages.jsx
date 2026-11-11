import { useState } from 'react';
import { categoryLabel, itemLocation, itemTexture, orderedItems, savedNumber } from './item-display.js';

const number = value => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
const readable = data => ['available', 'partial'].includes(data?.status);

function ItemVisual({ item, pet = false }) {
  const [failed, setFailed] = useState(false);
  const src = pet ? null : itemTexture(item);
  return <span className="asset-visual mc-item-icon" aria-hidden="true">
    {src && !failed ? <img src={src} alt="" onError={() => setFailed(true)} />
      : <svg className="asset-fallback" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        {pet ? <><ellipse cx="6" cy="7" rx="2" ry="3" /><ellipse cx="18" cy="7" rx="2" ry="3" />
          <ellipse cx="12" cy="5" rx="2" ry="3" /><path d="M5 17c0-3 4-7 7-7s7 4 7 7c0 6-5 2-7 2s-7 4-7-2Z" /></>
          : <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>}
      </svg>}
  </span>;
}

function ItemAvailability({ data, category, hasEntries }) {
  if (data?.status === 'available' && hasEntries) return null;
  const label = categoryLabel(category);
  const title = data?.status === 'private' ? `${label} sharing is disabled`
    : data?.status === 'partial' ? 'Some saved details are unavailable'
      : data?.status === 'empty' || (data?.status === 'available' && !hasEntries) ? `No saved ${category === 'Pets' ? 'pets' : 'items'}`
        : data?.status === 'missing' ? `${label} not recorded` : `${label} unavailable`;
  const detail = data?.status === 'private' ? 'Enable the relevant API sharing in-game, then fetch a new snapshot when available.'
    : data?.status === 'partial' ? `${hasEntries ? 'Showing readable saved entries.' : 'No readable entries were saved.'} ${category === 'Pets' ? 'Unrecorded pet details are not assumed to be zero.' : 'Unreadable containers are not assumed to be empty.'}`
      : data?.status === 'empty' || (data?.status === 'available' && !hasEntries) ? `This saved snapshot records an empty ${label.toLowerCase()} list.`
        : data?.reason || 'This information is not available in the saved snapshot. Reload saved data or fetch a new snapshot when available.';
  return <div className={`asset-state ${data?.status || 'unavailable'}`} role="status"><h3>{title}</h3><p>{detail}</p></div>;
}

export function InventoryView({ data, category, onItemClick }) {
  const items = readable(data) ? orderedItems(data.items || [], category) : [];
  return <div className="item-page">
    <ItemAvailability data={data} category={category} hasEntries={items.length > 0} />
    {items.length > 0 && <>
      <p className="hint">{items.length} {data.status === 'partial' ? 'readable ' : ''}saved item stacks. Select an item for lore and details.
        {['Armor', 'Equipment'].includes(category) && ' Explicit saved slots are listed first, in slot order.'}</p>
      <div className="asset-grid item-grid">{items.map((item, index) => {
        const count = savedNumber(item.count);
        return <button type="button" className="asset-card mc-item" key={`${item.container}:${item.slot}:${item.id}:${item.minecraftId}:${index}`}
          onClick={() => onItemClick(item)}>
          <span className="asset-card-top"><ItemVisual item={item} />
            <span className="asset-badge mc-item-count">{count === null ? 'Count not recorded' : `×${number(count)}`}</span></span>
          <span className="asset-name mc-item-name">{item.name || 'Name unavailable'}</span>
          <span className="asset-location">{itemLocation(item, category)}</span>
          <span className="asset-detail-link">View details</span>
        </button>;
      })}</div>
    </>}
  </div>;
}

export function PetsView({ data }) {
  const pets = readable(data) ? [...(data.entries || [])].sort((a, b) => Number(b.active === true) - Number(a.active === true)) : [];
  return <div className="item-page">
    <ItemAvailability data={data} category="Pets" hasEntries={pets.length > 0} />
    {pets.length > 0 && <><p className="hint">Saved pets. Active status and XP reflect this snapshot.</p>
      <div className="asset-grid">{pets.map(pet => {
        const xp = pet.status === 'unavailable' ? null : savedNumber(pet.xp);
        return <article key={pet.id} className={`asset-card pet-card${pet.active === true ? ' is-active' : ''}`} data-pet-id={pet.id}>
          <div className="asset-card-top"><ItemVisual pet />
            {pet.active === true && <span className="asset-badge active-pet-badge">Active pet</span>}</div>
          <h3 className="asset-name">{pet.name || 'Name unavailable'}</h3>
          <p className="asset-location">{pet.rarity || 'Rarity not recorded'} · Saved pet inventory</p>
          <p className="pet-xp">{xp === null ? 'XP not recorded' : `${number(xp)} saved XP`}</p>
        </article>;
      })}</div></>}
  </div>;
}
