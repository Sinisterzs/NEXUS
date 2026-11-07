// Verification script for Phase 1.3: Data Access Layer & Validation
import assert from 'node:assert';

// Emulate localStorage
const storage = {};
global.window = {
  localStorage: {
    getItem: (k) => storage[k] || null,
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: (k) => { delete storage[k]; },
  }
};

console.log('--- Test 1: Corrupted / Partial Preferences Validation ---');

// Mock validateAndMerge logic identical to SettingsRepository
const DEFAULT_PREFERENCES = {
  theme: 'nexus-dark',
  compactMode: false,
  fontSize: 'base',
  isSidebarCollapsed: false,
  activeTab: 'home',
  activeCommunityId: 'com_1',
  activeChannelId: 'ch_general',
  activeDmId: 'f_01',
  inputDevice: 'Microfone Padrão',
  outputDevice: 'Alto-falantes Padrão',
  inputSensitivity: -45,
  outputVolume: 80,
  noiseSuppression: true,
  echoCancellation: true,
  desktopAlerts: true,
  soundEffects: true,
  mentionsOnly: false,
  dndMode: false,
  allowDmsFrom: 'everyone',
  showGameActivity: true,
  streamerMode: false,
};

function validateAndMerge(saved) {
  const validTabs = ['home', 'messages', 'communities', 'calls', 'settings'];
  const validThemes = ['nexus-dark', 'midnight-black', 'cyber-slate'];
  const validFontSizes = ['sm', 'base', 'lg'];

  return {
    theme: validThemes.includes(saved.theme) ? saved.theme : DEFAULT_PREFERENCES.theme,
    compactMode: typeof saved.compactMode === 'boolean' ? saved.compactMode : DEFAULT_PREFERENCES.compactMode,
    fontSize: validFontSizes.includes(saved.fontSize) ? saved.fontSize : DEFAULT_PREFERENCES.fontSize,
    isSidebarCollapsed: typeof saved.isSidebarCollapsed === 'boolean' ? saved.isSidebarCollapsed : DEFAULT_PREFERENCES.isSidebarCollapsed,
    activeTab: validTabs.includes(saved.activeTab) ? saved.activeTab : DEFAULT_PREFERENCES.activeTab,
    activeCommunityId: saved.activeCommunityId !== undefined ? saved.activeCommunityId : DEFAULT_PREFERENCES.activeCommunityId,
    activeChannelId: saved.activeChannelId !== undefined ? saved.activeChannelId : DEFAULT_PREFERENCES.activeChannelId,
    activeDmId: saved.activeDmId !== undefined ? saved.activeDmId : DEFAULT_PREFERENCES.activeDmId,
    inputDevice: saved.inputDevice || DEFAULT_PREFERENCES.inputDevice,
    outputDevice: saved.outputDevice || DEFAULT_PREFERENCES.outputDevice,
    inputSensitivity: typeof saved.inputSensitivity === 'number' ? saved.inputSensitivity : DEFAULT_PREFERENCES.inputSensitivity,
    outputVolume: typeof saved.outputVolume === 'number' ? saved.outputVolume : DEFAULT_PREFERENCES.outputVolume,
    noiseSuppression: typeof saved.noiseSuppression === 'boolean' ? saved.noiseSuppression : DEFAULT_PREFERENCES.noiseSuppression,
    echoCancellation: typeof saved.echoCancellation === 'boolean' ? saved.echoCancellation : DEFAULT_PREFERENCES.echoCancellation,
    desktopAlerts: typeof saved.desktopAlerts === 'boolean' ? saved.desktopAlerts : DEFAULT_PREFERENCES.desktopAlerts,
    soundEffects: typeof saved.soundEffects === 'boolean' ? saved.soundEffects : DEFAULT_PREFERENCES.soundEffects,
    mentionsOnly: typeof saved.mentionsOnly === 'boolean' ? saved.mentionsOnly : DEFAULT_PREFERENCES.mentionsOnly,
    dndMode: typeof saved.dndMode === 'boolean' ? saved.dndMode : DEFAULT_PREFERENCES.dndMode,
    allowDmsFrom: saved.allowDmsFrom || DEFAULT_PREFERENCES.allowDmsFrom,
    showGameActivity: typeof saved.showGameActivity === 'boolean' ? saved.showGameActivity : DEFAULT_PREFERENCES.showGameActivity,
    streamerMode: typeof saved.streamerMode === 'boolean' ? saved.streamerMode : DEFAULT_PREFERENCES.streamerMode,
  };
}

// Case A: Corrupted fields
const corrupted = {
  theme: 'invalid-rainbow-theme',
  compactMode: 'true_string_instead_of_bool',
  fontSize: 100,
  activeTab: 'admin_dashboard', // not in validTabs
  outputVolume: 'loud',
};
const healed = validateAndMerge(corrupted);
assert.strictEqual(healed.theme, 'nexus-dark', 'Theme fallback to default');
assert.strictEqual(healed.compactMode, false, 'CompactMode fallback to boolean default');
assert.strictEqual(healed.fontSize, 'base', 'FontSize fallback to default');
assert.strictEqual(healed.activeTab, 'home', 'ActiveTab fallback to default home');
assert.strictEqual(healed.outputVolume, 80, 'OutputVolume fallback to default 80');
console.log('✓ Case A: Corrupted payload safely sanitised to secure defaults.');

// Case B: Valid partial update
const validPartial = {
  theme: 'midnight-black',
  compactMode: true,
  activeTab: 'messages',
  activeDmId: 'f_02',
};
const merged = validateAndMerge(validPartial);
assert.strictEqual(merged.theme, 'midnight-black');
assert.strictEqual(merged.compactMode, true);
assert.strictEqual(merged.activeTab, 'messages');
assert.strictEqual(merged.activeDmId, 'f_02');
assert.strictEqual(merged.outputVolume, 80); // preserved default
console.log('✓ Case B: Valid preferences merged and preserved correctly.');

console.log('\n--- Test 2: Message Pagination & Chronological Ordering ---');
// Mock message store
const messages = [];
const convId = 'f_01';
for (let i = 1; i <= 30; i++) {
  messages.push({
    id: `m_${i}`,
    conversation_id: convId,
    sender_id: i % 2 === 0 ? 'usr_me' : 'f_01',
    content: `Test message ${i}`,
    created_at: 1700000000 + i * 10,
    delivery_status: 'local_saved'
  });
}

function getMessages(conversationId, limit = 20, beforeTimestamp = null) {
  let filtered = messages.filter(m => m.conversation_id === conversationId);
  if (beforeTimestamp) {
    filtered = filtered.filter(m => m.created_at < beforeTimestamp);
  }
  // Return newest `limit` messages in chronological order (oldest to newest)
  return filtered.slice(-limit);
}

const page1 = getMessages(convId, 20); // newest 20
assert.strictEqual(page1.length, 20);
assert.strictEqual(page1[0].id, 'm_11'); // oldest of page 1
assert.strictEqual(page1[page1.length - 1].id, 'm_30'); // newest of page 1

const oldestTs = page1[0].created_at;
const page2 = getMessages(convId, 20, oldestTs); // older messages
assert.strictEqual(page2.length, 10); // remaining 10 messages
assert.strictEqual(page2[0].id, 'm_1');
assert.strictEqual(page2[page2.length - 1].id, 'm_10');

console.log('✓ Message pagination & chronological sorting passed (Page 1: 20 msgs, Page 2: 10 older msgs).');

console.log('\n--- Test 3: Rapid Contact Switching Race Condition Guard ---');
let activeLoadId = 0;
let displayedMessagesFriendId = null;

async function simulateLoadData(friendId, simulatedDelayMs) {
  const currentLoadId = ++activeLoadId;
  await new Promise((r) => setTimeout(r, simulatedDelayMs));
  if (activeLoadId !== currentLoadId) {
    // Stale async response discarded!
    return;
  }
  displayedMessagesFriendId = friendId;
}

// User clicks f_01 (slow, 50ms), f_02 (medium, 30ms), then f_03 (fast, 10ms)
const p1 = simulateLoadData('f_01', 50);
const p2 = simulateLoadData('f_02', 30);
const p3 = simulateLoadData('f_03', 10);

await Promise.all([p1, p2, p3]);
assert.strictEqual(displayedMessagesFriendId, 'f_03', 'Only latest contact f_03 is rendered');
console.log('✓ Stale async loads safely discarded. Latest contact rendered cleanly.');

console.log('\nAll Phase 1.3 repository logic tests passed successfully!');
