import { useEffect, useMemo, useState } from 'react';

const DATA_TABS = [
  'Armor',
  'Equipment',
  'Inventory',
  'Backpacks',
  'Enderchest',
  'Talismans',
  'Pets',
  'Skills',
  'Collections',
];

const ITEM_DATA_TABS = new Set([
  'Armor',
  'Equipment',
  'Inventory',
  'Backpacks',
  'Enderchest',
  'Talismans',
]);

const MC_ASSETS_BASE =
  'https://mcasset.cloud/1.21.4/assets/minecraft/textures/item';

function formatKey(key) {
  return String(key)
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (character) =>
      character.toUpperCase(),
    );
}

function normalizeItemId(value) {
  if (typeof value !== 'string') {
    return null;
  }

  let id = value
    .replace(/^minecraft:/i, '')
    .toLowerCase();

  id = id.replace(/[^a-z0-9_]/g, '');

  return id || null;
}

function getItemId(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  return (
    item.id ||
    item.ID ||
    item.item_id ||
    item.ItemID ||
    item.tag?.id ||
    item.tag?.ExtraAttributes?.id ||
    item.tag?.extra_attributes?.id ||
    item.nbt?.id ||
    item.nbt?.ExtraAttributes?.id ||
    null
  );
}

function getItemCount(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const count =
    item.Count ??
    item.count ??
    item.Amount ??
    item.amount;

  return typeof count === 'number'
    ? count
    : null;
}

function getItemName(item) {
  if (!item || typeof item !== 'object') {
    return 'Unknown Item';
  }

  return (
    item.name ||
    item.Name ||
    item.display?.Name ||
    item.tag?.display?.Name ||
    item.tag?.ExtraAttributes?.id ||
    item.tag?.extra_attributes?.id ||
    getItemId(item) ||
    'Unknown Item'
  );
}

function getTextureUrl(item) {
  const rawId = getItemId(item);
  const id = normalizeItemId(rawId);

  if (!id) {
    return null;
  }

  /*
   * Vanilla Minecraft item IDs can be mapped directly to
   * the corresponding MC Assets texture.
   *
   * Custom Hypixel IDs will simply fail to load and the
   * UI will fall back to the item initials.
   */
  return `${MC_ASSETS_BASE}/${id}.png`;
}

function isProbablyItem(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }

  return Boolean(
    getItemId(value) ||
    value.Count !== undefined ||
    value.count !== undefined ||
    value.tag?.ExtraAttributes ||
    value.tag?.extra_attributes,
  );
}

function collectItems(value, path = 'root') {
  const items = [];

  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      if (isProbablyItem(entry)) {
        items.push({
          item: entry,
          path: `${path}[${index}]`,
        });
      } else if (
        entry &&
        typeof entry === 'object'
      ) {
        items.push(
          ...collectItems(
            entry,
            `${path}[${index}]`,
          ),
        );
      }
    });

    return items;
  }

  if (!value || typeof value !== 'object') {
    return items;
  }

  if (isProbablyItem(value)) {
    items.push({
      item: value,
      path,
    });

    return items;
  }

  for (const [key, child] of Object.entries(value)) {
    if (isProbablyItem(child)) {
      items.push({
        item: child,
        path: `${path}.${key}`,
      });
    } else if (
      child &&
      typeof child === 'object'
    ) {
      items.push(
        ...collectItems(
          child,
          `${path}.${key}`,
        ),
      );
    }
  }

  return items;
}

function ItemCard({ item, path, onClick }) {
  const [imageFailed, setImageFailed] =
    useState(false);

  const textureUrl = getTextureUrl(item);
  const name = getItemName(item);
  const count = getItemCount(item);
  const id = getItemId(item);

  return (
    <button
      type="button"
      className="mc-item"
      onClick={() => onClick(item, path)}
      title={`${name}${id ? ` (${id})` : ''}`}
    >
      <div className="mc-item-icon">
        {textureUrl && !imageFailed ? (
          <img
            src={textureUrl}
            alt=""
            onError={() => setImageFailed(true)}
          />
        ) : (
          <span>
            {String(name)
              .slice(0, 2)
              .toUpperCase()}
          </span>
        )}
      </div>

      {count !== null && count > 1 && (
        <span className="mc-item-count">
          {count}
        </span>
      )}

      <span className="mc-item-name">
        {name}
      </span>
    </button>
  );
}

function JsonValue({
  value,
  name,
  depth = 0,
}) {
  const [expanded, setExpanded] =
    useState(depth < 1);

  if (
    value === null ||
    typeof value !== 'object'
  ) {
    return (
      <div className="json-row">
        {name !== undefined && (
          <span className="json-key">
            {name}
          </span>
        )}

        <span className="json-primitive">
          {typeof value === 'string'
            ? `"${value}"`
            : String(value)}
        </span>
      </div>
    );
  }

  const entries = Array.isArray(value)
    ? value.map((entry, index) => [
        index,
        entry,
      ])
    : Object.entries(value);

  return (
    <div className="json-node">
      <button
        type="button"
        className="json-toggle"
        onClick={() =>
          setExpanded((current) => !current)
        }
      >
        <span>
          {expanded ? '▼' : '▶'}
        </span>

        {name !== undefined && (
          <strong>{name}</strong>
        )}

        <span className="json-type">
          {Array.isArray(value)
            ? `Array (${value.length})`
            : `Object (${entries.length})`}
        </span>
      </button>

      {expanded && (
        <div className="json-children">
          {entries.map(
            ([key, child]) => (
              <JsonValue
                key={String(key)}
                name={String(key)}
                value={child}
                depth={depth + 1}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function ItemGrid({
  data,
  onItemClick,
}) {
  const items = useMemo(
    () => collectItems(data),
    [data],
  );

  if (items.length === 0) {
    return (
      <div className="empty-state">
        No item compounds were detected in this
        dataset.
      </div>
    );
  }

  return (
    <div className="item-grid">
      {items.map(({ item, path }) => (
        <ItemCard
          key={path}
          item={item}
          path={path}
          onClick={onItemClick}
        />
      ))}
    </div>
  );
}

function ItemDetails({
  item,
  path,
  onClose,
}) {
  return (
    <aside className="item-details">
      <div className="item-details-header">
        <h3>{getItemName(item)}</h3>

        <button
          type="button"
          onClick={onClose}
        >
          Close
        </button>
      </div>

      <p>
        <strong>Path:</strong>{' '}
        <code>{path}</code>
      </p>

      {getItemId(item) && (
        <p>
          <strong>Item ID:</strong>{' '}
          <code>{getItemId(item)}</code>
        </p>
      )}

      {getItemCount(item) !== null && (
        <p>
          <strong>Count:</strong>{' '}
          {getItemCount(item)}
        </p>
      )}

      <div className="item-detail-json">
        <JsonValue value={item} />
      </div>
    </aside>
  );
}

export default function SkyBlockPage({
  player,
  onBack,
}) {
  const [storedData, setStoredData] =
    useState(null);

  const [selectedProfile, setSelectedProfile] =
    useState(null);

  const [selectedTab, setSelectedTab] =
    useState('Armor');

  const [selectedItem, setSelectedItem] =
    useState(null);

  const [isLoading, setIsLoading] =
    useState(true);

  const [isFetching, setIsFetching] =
    useState(false);

  const [error, setError] =
    useState('');

  const [fetchMessage, setFetchMessage] =
    useState('');

  async function loadStoredData() {
    setIsLoading(true);
    setError('');

    try {
      const response = await fetch(
        `/api/player/${encodeURIComponent(
          player.name,
        )}/skyblock`,
        {
          cache: 'no-store',
          signal: AbortSignal.timeout(10000),
        },
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.error ||
            'Could not load stored data.',
        );
      }

      setStoredData(data);

      if (
        data.profiles?.length &&
        !selectedProfile
      ) {
        setSelectedProfile(
          data.profiles[0].profile,
        );
      }
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setIsLoading(false);
    }
  }

  async function fetchFreshData() {
    setError('');
    setFetchMessage('');
    setIsFetching(true);

    try {
      const response = await fetch(
        `/api/player/${encodeURIComponent(
          player.name,
        )}/skyblock`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            uuid: player.uuid,
          }),
          signal: AbortSignal.timeout(30000),
        },
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.error ||
            'SkyBlock data fetch failed.',
        );
      }

      setFetchMessage(
        `Saved ${data.profiles.length} profile(s) at ${data.timestamp}.`,
      );

      await loadStoredData();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setIsFetching(false);
    }
  }

  useEffect(() => {
    loadStoredData();
  }, [player.name]);

  const profile = storedData?.profiles?.find(
    (entry) =>
      entry.profile === selectedProfile,
  );

  const currentData =
    profile?.data?.[selectedTab] ?? {};

  return (
    <main className="skyblock-page">
      <header className="skyblock-header">
        <div>
          <p className="eyebrow">
            SkyBlock profile
          </p>

          <h1>{player.name}</h1>

          <p>
            UUID:{' '}
            <code>{player.uuid}</code>
          </p>
        </div>

        <div className="skyblock-actions">
          <button
            type="button"
            onClick={fetchFreshData}
            disabled={isFetching}
          >
            {isFetching
              ? 'Fetching…'
              : 'Fetch fresh data'}
          </button>

          <button
            type="button"
            onClick={onBack}
          >
            Back
          </button>
        </div>
      </header>

      {error && (
        <p
          className="status offline"
          role="alert"
        >
          {error}
        </p>
      )}

      {fetchMessage && (
        <p
          className="status online"
          role="status"
        >
          {fetchMessage}
        </p>
      )}

      {isLoading ? (
        <p>Loading stored SkyBlock data…</p>
      ) : (
        <>
          {!storedData?.profiles?.length ? (
            <section>
              <h2>No stored SkyBlock data</h2>

              <p>
                Fetch the player's SkyBlock data
                to create the first local snapshot.
              </p>
            </section>
          ) : (
            <>
              <section className="profile-section">
                <h2>Profiles</h2>

                <div className="profile-tabs">
                  {storedData.profiles.map(
                    (entry) => (
                      <button
                        type="button"
                        key={entry.profile}
                        className={
                          selectedProfile ===
                          entry.profile
                            ? 'active'
                            : ''
                        }
                        onClick={() => {
                          setSelectedProfile(
                            entry.profile,
                          );
                          setSelectedItem(null);
                        }}
                      >
                        {entry.profile}
                      </button>
                    ),
                  )}
                </div>

                {profile && (
                  <p className="snapshot-time">
                    Snapshot:{' '}
                    <code>
                      {profile.timestamp}
                    </code>
                  </p>
                )}
              </section>

              {profile && (
                <section className="data-section">
                  <nav className="data-tabs">
                    {DATA_TABS.map((tab) => (
                      <button
                        type="button"
                        key={tab}
                        className={
                          selectedTab === tab
                            ? 'active'
                            : ''
                        }
                        onClick={() => {
                          setSelectedTab(tab);
                          setSelectedItem(null);
                        }}
                      >
                        {tab}
                      </button>
                    ))}
                  </nav>

                  <div className="data-toolbar">
                    <h2>
                      {formatKey(selectedTab)}
                    </h2>

                    <span>
                      {ITEM_DATA_TABS.has(
                        selectedTab,
                      )
                        ? 'Item view + raw data'
                        : 'Complete stored data'}
                    </span>
                  </div>

                  {ITEM_DATA_TABS.has(
                    selectedTab,
                  ) && (
                    <ItemGrid
                      data={currentData}
                      onItemClick={(item, path) =>
                        setSelectedItem({
                          item,
                          path,
                        })
                      }
                    />
                  )}

                  <div className="raw-data">
                    <h3>
                      Complete JSON data
                    </h3>

                    <JsonValue
                      value={currentData}
                    />
                  </div>

                  {selectedItem && (
                    <ItemDetails
                      item={
                        selectedItem.item
                      }
                      path={
                        selectedItem.path
                      }
                      onClose={() =>
                        setSelectedItem(null)
                      }
                    />
                  )}
                </section>
              )}
            </>
          )}
        </>
      )}
    </main>
  );
}