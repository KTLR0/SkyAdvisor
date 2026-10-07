import { useEffect, useState } from 'react';
import SkyBlockPage from './SkyBlockPage';

export default function App() {
  const [status, setStatus] = useState('checking');
  const [username, setUsername] = useState('');
  const [player, setPlayer] = useState(null);
  const [lookupError, setLookupError] = useState('');
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [page, setPage] = useState('lookup');

  async function lookupPlayer(event) {
    event.preventDefault();
    setPlayer(null);
    setLookupError('');

    const name = username.trim();

    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
      setLookupError(
        'Use 3–16 letters, numbers, or underscores.',
      );
      return;
    }

    setIsLookingUp(true);

    try {
      const response = await fetch(
        `/api/player/${encodeURIComponent(name)}`,
        {
          signal: AbortSignal.timeout(10000),
          cache: 'no-store',
        },
      );

      const data = await response.json();

      if (!response.ok) {
        setLookupError(
          data.error ||
            'Player lookup failed. Please try again.',
        );
        return;
      }

      setPlayer(data);
    } catch {
      setLookupError(
        'Could not reach the server. Check that it is running and try again.',
      );
    } finally {
      setIsLookingUp(false);
    }
  }

  async function checkServer() {
    setStatus('checking');

    try {
      const response = await fetch('/api/health', {
        signal: AbortSignal.timeout(5000),
        cache: 'no-store',
      });

      if (!response.ok) {
        throw new Error('Health request failed');
      }

      const health = await response.json();

      setStatus(
        health.status === 'ok'
          ? 'online'
          : 'offline',
      );
    } catch {
      setStatus('offline');
    }
  }

  useEffect(() => {
    checkServer();
  }, []);

  if (page === 'skyblock' && player) {
    return (
      <SkyBlockPage
        player={player}
        onBack={() => setPage('lookup')}
      />
    );
  }

  const messages = {
    checking: 'Checking server…',
    online: 'Server is running',
    offline:
      'Server is unavailable. Start the server and try again.',
  };

  return (
    <main>
      <p className="eyebrow">
        Minecraft username lookup
      </p>

      <h1>SkyAdvisor</h1>

      <p>
        A starting point for your SkyBlock companion.
      </p>

      <section aria-labelledby="lookup-heading">
        <h2 id="lookup-heading">
          Find a Minecraft player
        </h2>

        <form onSubmit={lookupPlayer}>
          <label htmlFor="username">
            Minecraft Java username
          </label>

          <p
            id="username-help"
            className="hint"
          >
            3–16 letters, numbers, or underscores.
          </p>

          <div className="lookup-controls">
            <input
              id="username"
              name="username"
              value={username}
              onChange={(event) => {
                setUsername(event.target.value);
                setPlayer(null);
                setLookupError('');
              }}
              placeholder="Phia98"
              aria-describedby="username-help"
              autoComplete="off"
              spellCheck={false}
              required
              disabled={isLookingUp}
            />

            <button
              type="submit"
              disabled={isLookingUp}
            >
              {isLookingUp
                ? 'Looking up…'
                : 'Find player'}
            </button>
          </div>
        </form>

        <div role="status">
          {isLookingUp && (
            <p>Looking up player…</p>
          )}

          {lookupError && (
            <p
              className="status offline"
              role="alert"
            >
              {lookupError}
            </p>
          )}

          {player && (
            <>
              <dl className="player-result">
                <dt>Player name</dt>
                <dd>{player.name}</dd>

                <dt>UUID</dt>
                <dd>
                  <code>{player.uuid}</code>
                </dd>
              </dl>

              <button
                type="button"
                onClick={() => setPage('skyblock')}
              >
                Continue to SkyBlock data
              </button>
            </>
          )}
        </div>
      </section>

      <section aria-labelledby="server-heading">
        <h2 id="server-heading">
          Server status
        </h2>

        <p
          role="status"
          className={`status ${status}`}
        >
          {messages[status]}
        </p>

        <button
          onClick={checkServer}
          disabled={status === 'checking'}
        >
          Check again
        </button>
      </section>
    </main>
  );
}