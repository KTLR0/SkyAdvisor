require('dotenv').config();
const fs = require('fs');
const path = require('path');
const nbt = require('prismarine-nbt');
const zlib = require('zlib');

const apiKey = process.env.HYPIXEL_API_KEY;
const username = "Phia98";
const CACHE_FILE = path.join(__dirname, 'cache.json');

// --- CACHING HELPERS ---
function getCachedUuid(username) {
    if (!fs.existsSync(CACHE_FILE)) return null;
    try {
        const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        return cache[username.toLowerCase()] || null;
    } catch (e) { return null; }
}

function saveUuidToCache(username, uuid) {
    let cache = {};
    if (fs.existsSync(CACHE_FILE)) {
        try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch(e) {}
    }
    cache[username.toLowerCase()] = uuid;
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 4), 'utf8');
}

// Check if a specific profile's date folder was written to within the hour
function isProfileCacheValid(profileFolder) {
    const criticalFile = path.join(profileFolder, 'Skills.json');
    if (!fs.existsSync(criticalFile)) return false;
    const stats = fs.statSync(criticalFile);
    return (Date.now() - stats.mtime.getTime()) < (60 * 60 * 1000); // 1 hour
}

// NBT Parser to translate Base64/GZipped items into readable JSON
async function parseNbtContainer(base64String) {
    if (!base64String) return { empty: true };
    try {
        const buffer = Buffer.from(base64String, 'base64');
        const unzipped = zlib.gunzipSync(buffer);
        const { parsed } = await nbt.parse(unzipped);
        return nbt.simplify(parsed);
    } catch (err) {
        return { error: "Failed to decode NBT container", message: err.message };
    }
}

async function getSkyBlockData() {
    if (!apiKey || !username) {
        console.error("❌ Error: Missing configuration parameters.");
        return;
    }

    try {
        // --- STEP 1: RESOLVE UUID ---
        let uuid = getCachedUuid(username);
        if (uuid) {
            console.log(`ℹ️ [Cache Hit] UUID for "${username}": ${uuid}`);
        } else {
            console.log(`Step 1: Resolving unique Minecraft UUID for "${username}" via Mojang...`);
            const mojangRes = await fetch(`https://minecraftservices.com{username}`, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
            });
            if (!mojangRes.ok) throw new Error(`User ${username} not found via Mojang API.`);
            const mojangData = await mojangRes.json();
            uuid = mojangData.id;
            saveUuidToCache(username, uuid);
            console.log(`✅ UUID saved to local registry: ${uuid}`);
        }

        // --- STEP 2: FETCH ALL PROFILES (PLURAL ENDPOINT) ---
        console.log(`Step 2: Fetching active SkyBlock profiles from Hypixel...`);
        // Corrected: Uses '?' first, and lowercase 'key='
        const hypixelUrl = `https://api.hypixel.net/v2/skyblock/profiles?key=${apiKey}&uuid=${uuid}`;

        const hypixelRes = await fetch(hypixelUrl, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' 
            }
        });

        const contentType = hypixelRes.headers.get("content-type");
        if (!contentType || !contentType.includes("application/json")) {
            throw new Error(`Hypixel returned an unexpected HTML/Cloudflare firewall page.`);
        }

        const hypixelData = await hypixelRes.json();
        if (!hypixelRes.ok || !hypixelData.success) {
            throw new Error(hypixelData.cause || "Hypixel API connection failed.");
        }

        if (!hypixelData.profiles || hypixelData.profiles.length === 0) {
            console.log(`❌ No SkyBlock profiles detected for user ${username}.`);
            return;
        }

        const dateStr = new Date().toISOString().split('T')[0];

        // --- STEP 3: LOOP THROUGH AND PARSE EACH PROFILE INDEPENDENTLY ---
        console.log(`\nFound ${hypixelData.profiles.length} profiles. Splitting data tracks...`);

        for (const profile of hypixelData.profiles) {
            // Use the readable name (e.g., "Apple", "Zucchini"), fallback to profile_id if missing
            const profileName = profile.cute_name || profile.profile_id;
            
            // NEW FOLDER PATTERN: PlayerData/{Username}/{ProfileName}/{Date}/
            const baseFolder = path.join(__dirname, 'PlayerData', username, profileName, dateStr);

            // Check if this particular profile has been fetched within the last hour
            if (isProfileCacheValid(baseFolder)) {
                console.log(`\n⏳ [Cache Match] Profile [${profileName}] was pulled within the hour. Skipping network overwrite.`);
                continue;
            }

            console.log(`\nParsing profile [${profileName}] ...`);
            fs.mkdirSync(baseFolder, { recursive: true });

            const memberData = profile.members[uuid];
            if (!memberData) {
                console.log(`⚠️ User data missing inside profile: ${profileName}`);
                continue;
            }

            const saveJson = (filename, payload) => {
                fs.writeFileSync(path.join(baseFolder, `${filename}.json`), JSON.stringify(payload, null, 4), 'utf8');
                console.log(`  💾 Saved: ${filename}.json`);
            };

            // 1. INVENTORY & EQUIPMENT
            saveJson('Inventory', await parseNbtContainer(memberData.inventory?.inv_contents?.data));
            saveJson('Armor', await parseNbtContainer(memberData.inventory?.inv_armor?.data));
            saveJson('Equipment', await parseNbtContainer(memberData.inventory?.equipment_contents?.data));

            // 2. ENDERCHEST & STORAGE
            saveJson('Enderchest', await parseNbtContainer(memberData.inventory?.ender_chest_contents?.data));
            saveJson('Talismans', await parseNbtContainer(memberData.inventory?.talisman_bag?.data));
            
            const backpacks = {};
            if (memberData.inventory?.backpack_contents) {
                for (const [slot, chunk] of Object.entries(memberData.inventory.backpack_contents)) {
                    backpacks[`backpack_${slot}`] = await parseNbtContainer(chunk.data);
                }
            }
            saveJson('Backpacks', backpacks);

            // 3. SKILLS
            const skills = {
                farming: memberData.player_data?.experience?.SKILL_FARMING || 0,
                mining: memberData.player_data?.experience?.SKILL_MINING || 0,
                combat: memberData.player_data?.experience?.SKILL_COMBAT || 0,
                foraging: memberData.player_data?.experience?.SKILL_FORAGING || 0,
                fishing: memberData.player_data?.experience?.SKILL_FISHING || 0,
                enchanting: memberData.player_data?.experience?.SKILL_ENCHANTING || 0,
                alchemy: memberData.player_data?.experience?.SKILL_ALCHEMY || 0,
                taming: memberData.player_data?.experience?.SKILL_TAMING || 0,
            };
            saveJson('Skills', skills);

            // 4. COLLECTIONS
            saveJson('Collections', memberData.collection_data?.collection || {});

            // 5. SLAYERS & MISC
            saveJson('Slayers', memberData.slayer_data?.slayers || {});
        }

        console.log(`\n🎉 All profiles successfully archived inside PlayerData/${username}/`);

    } catch (error) {
        console.error("❌ Process halted:", error.message);
    }
}

getSkyBlockData();
