import { useCallback, useEffect, useState } from 'react';

// Shared by Overview and Skills; navigating categories does not reload thresholds.
export default function useSkillResource() {
  const [resource, setResource] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const loadResource = useCallback(async (signal) => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/resources/skills', {
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000),
      });
      if (!response.ok) throw new Error('Official skill thresholds are unavailable. XP totals are still shown.');
      const result = await response.json();
      if (!result.skills || typeof result.skills !== 'object') throw new Error('Official skill thresholds are unavailable.');
      if (!signal?.aborted) setResource(result);
    } catch (requestError) {
      if (!signal?.aborted) {
        setResource(null);
        setError(requestError.name === 'TimeoutError' ? 'Loading skill thresholds timed out. Please try again.'
          : requestError.message);
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadResource(controller.signal);
    return () => controller.abort();
  }, [loadResource]);
  return { resource, loading, error, onRetry: loadResource };
}
