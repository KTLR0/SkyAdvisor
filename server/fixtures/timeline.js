const { ObjectId } = require('mongodb');
const { PLAYER_ID, PROFILE_A, PROFILE_B } = require('./skyblock');

const dashed = id => id.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
const skill = xp => ({ status: 'available', entries: [{ id: 'mining', label: 'Mining', xp, status: 'available' }] });
const collection = amount => ({ status: 'available', entries: [{ id: 'WHEAT', label: 'Wheat', amount, status: 'available' }] });

function timelineRows() {
  const legacy = (suffix, date, xp, amount) => ({
    _id: new ObjectId(suffix.padStart(24, '0')), playerUuid: PLAYER_ID,
    profileId: dashed(PROFILE_A).toUpperCase(), fetchedAt: new Date(date),
    timestamp: `${date.slice(0, 10)}--00--00`,
    data: { Skills: { mining: xp }, Collections: amount === null ? {} : { WHEAT: amount } },
  });
  const current = (id, date, xp, amount) => ({
    _id: id, schemaVersion: 2, playerUuid: PLAYER_ID, profileId: PROFILE_A,
    fetchedAt: new Date(date), timestamp: date,
    data: { Skills: skill(xp), Collections: collection(amount) },
  });
  return [
    legacy('1', '2026-10-10T00:00:00.000Z', 0, null),
    legacy('2', '2026-10-16T00:00:00.000Z', 50, 0),
    current('fetch-a:profile-a', '2026-10-17T00:00:00.000Z', 100, 0),
    legacy('3', '2026-10-17T00:00:00.000Z', 150, 10),
    current('fetch-b:profile-a', '2026-10-22T00:00:00.000Z', 200, 20),
    { ...current('other-profile', '2026-10-23T00:00:00.000Z', 999, 999), profileId: PROFILE_B },
    { ...current('other-player', '2026-10-23T00:00:00.000Z', 888, 888), playerUuid: '2'.repeat(32) },
  ];
}

module.exports = { timelineRows, skill, collection };
