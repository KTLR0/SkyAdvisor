const nbt = require('prismarine-nbt');
const { gzipSync } = require('node:zlib');

const PLAYER_ID = '11111111111111111111111111111111';
const PROFILE_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PROFILE_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const FETCHED_AT = '2026-10-22T12:34:56.789Z';
const PLAYER = { name: 'FixturePlayer', uuid: PLAYER_ID };

function encodedInventory(items = true) {
  const compounds = items ? [{
    id: nbt.string('minecraft:diamond'), Slot: nbt.byte(0), Count: nbt.byte(3),
    tag: nbt.comp({ display: nbt.comp({ Name: nbt.string('§bFixture Diamond'),
      Lore: nbt.list(nbt.string(['§7A representative test item'])) }),
    ExtraAttributes: nbt.comp({ id: nbt.string('DIAMOND') }) }),
  }] : [];
  return gzipSync(nbt.writeUncompressed(nbt.comp({ i: nbt.list(nbt.comp(compounds)) }))).toString('base64');
}

function profilesReply() {
  return { success: true, profiles: [{
    profile_id: PROFILE_A, cute_name: 'Apple', selected: true,
    members: { [PLAYER_ID]: {
      player_data: { experience: { SKILL_FARMING: 0, SKILL_MINING: 12345.5, SKILL_COMBAT: 50 } },
      collection: { WHEAT: 0, COBBLESTONE: 1456, 'INK_SACK:3': 12 },
      inventory: { inv_contents: { data: encodedInventory() }, inv_armor: { data: encodedInventory(false) },
        backpack_contents: { 0: { data: encodedInventory() } } },
      pets_data: { pets: [{ type: 'SHEEP', tier: 'EPIC', exp: 0, active: true }] },
    } },
  }, {
    profile_id: PROFILE_B, cute_name: 'Banana', selected: false,
    members: { [PLAYER_ID]: {
      player_data: { experience: { SKILL_FARMING: 420, SKILL_MINING: 0 } },
      collection_data: { collection: { WHEAT: 32 } },
      api_settings: { inv_contents: false },
    } },
  }] };
}

module.exports = { PLAYER_ID, PROFILE_A, PROFILE_B, PLAYER, FETCHED_AT, profilesReply, encodedInventory };
