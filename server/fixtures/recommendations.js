// Full-sized synthetic evidence for request-size regressions; no player data.
function fullRecommendationProfile() {
  return {
    sourceSchemaVersion: 2, fetchedAt: '2026-10-28T12:00:00.000Z',
    data: {
      Skills: { status: 'available', entries: ['farming', 'mining', 'combat', 'foraging', 'fishing',
        'enchanting', 'alchemy', 'taming', 'carpentry', 'runecrafting', 'social']
        .map(id => ({ id, xp: 12345, status: 'available' })) },
      Collections: { status: 'available', entries: Array.from({ length: 100 }, (_, index) => ({
        id: `SYNTHETIC_COLLECTION_${index}_${'A'.repeat(48)}`, amount: index * 100, status: 'available',
      })) },
      Inventory: { status: 'available', items: Array.from({ length: 40 }, (_, slot) => ({
        id: `SYNTHETIC_ITEM_${slot}_${'B'.repeat(48)}`, slot, count: 1,
      })) },
    },
  };
}

module.exports = { fullRecommendationProfile };
