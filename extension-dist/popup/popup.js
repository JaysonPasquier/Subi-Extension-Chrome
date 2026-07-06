const API           = 'https://api.subi.live';
const CREDITS_GOAL  = 1000;
const VERSION_URL   = 'https://raw.githubusercontent.com/JaysonPasquier/Subi-Extension-Chrome/main/version.json';

// ── i18n — apply all data-i18n attributes automatically ──────────────────────
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const msg = chrome.i18n.getMessage(el.dataset.i18n);
    if (msg) el.textContent = msg;
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const msg = chrome.i18n.getMessage(el.dataset.i18nTitle);
    if (msg) el.title = msg;
  });
}

// ── Sections ──────────────────────────────────────────────────────────────────
const loginSection   = document.getElementById('login-section');
const userSection    = document.getElementById('user-section');
const loadingSection = document.getElementById('loading-section');

function showSection(id) {
  loginSection.style.display   = id === 'login'   ? '' : 'none';
  userSection.style.display    = id === 'user'    ? '' : 'none';
  loadingSection.style.display = id === 'loading' ? '' : 'none';
}

// ── API helpers ───────────────────────────────────────────────────────────────
async function apiFetch(path, token, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
  if (!res.ok) {
    const err = new Error('request failed');
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ── Render credits ────────────────────────────────────────────────────────────
function renderCredits(credits) {
  document.getElementById('credits-value').textContent = credits.toLocaleString();
  const pct = Math.min((credits / CREDITS_GOAL) * 100, 100);
  document.getElementById('progress-fill').style.width = `${pct}%`;
  document.getElementById('progress-label').textContent =
    `${credits.toLocaleString()} / ${CREDITS_GOAL.toLocaleString()}`;
  document.getElementById('redeem-btn').disabled = credits < CREDITS_GOAL;
}

// ── Show logged-in state ──────────────────────────────────────────────────────
function showUser(user) {
  showSection('user');
  document.getElementById('username').textContent = user.twitch_username;
  const avatar = document.getElementById('avatar');
  if (user.twitch_avatar) {
    avatar.src = user.twitch_avatar;
    avatar.style.display = '';
  }
  renderCredits(user.credits);
  chrome.storage.local.set({
    myTwitchUsername: user.twitch_username.toLowerCase(),
    myTwitchAvatar: user.twitch_avatar || '',
  });
  initBadgeSelector(user.twitch_username.toLowerCase());
}

// ── Update banner ─────────────────────────────────────────────────────────────
async function checkUpdate() {
  try {
    const { pendingUpdate } = await chrome.storage.local.get(['pendingUpdate']);
    if (!pendingUpdate) return;
    const banner = document.getElementById('update-banner');
    const link   = document.getElementById('update-link');
    banner.style.display = '';
    link.href = pendingUpdate.release_url || 'https://github.com/JaysonPasquier/Subi-Extension-Chrome/releases/latest';
    banner.title = chrome.i18n.getMessage('update_available') || 'Update available';
  } catch {}
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  applyI18n();
  showSection('loading');

  await checkUpdate();

  const { token } = await chrome.storage.local.get(['token']);
  if (!token) { showSection('login'); return; }

  try {
    const { user } = await apiFetch('/auth/me', token);
    chrome.storage.local.set({
      credits:          user.credits,
      dailyImpressions: user.daily_impressions,
      dailyDate:        new Date().toDateString(),
    });
    showUser(user);
  } catch (err) {
    if (err.status === 401 || err.status === 404) {
      await chrome.storage.local.remove(['token', 'credits', 'dailyImpressions', 'dailyDate']);
    }
    showSection('login');
  }
}

// ── Connect Twitch ────────────────────────────────────────────────────────────
document.getElementById('connect-btn').addEventListener('click', async () => {
  try {
    const { referralCode } = await chrome.storage.local.get(['referralCode']);
    const path = referralCode ? `/auth/twitch/url?ref=${encodeURIComponent(referralCode)}` : '/auth/twitch/url';
    const { url } = await apiFetch(path, null);
    chrome.tabs.create({ url });
    window.close();
  } catch {
    alert('Cannot reach the Subi server.');
  }
});

// ── Logout ────────────────────────────────────────────────────────────────────
document.getElementById('logout-btn').addEventListener('click', async () => {
  await chrome.storage.local.remove(['token']);
  showSection('login');
});

// ── Redeem ────────────────────────────────────────────────────────────────────
document.getElementById('redeem-btn').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://subi.live/dashboard' });
  window.close();
});

// ── Live-update from storage changes ─────────────────────────────────────────
chrome.storage.onChanged.addListener((changes) => {
  if (changes.token) { init(); return; }
  if (changes.credits && userSection.style.display !== 'none') {
    renderCredits(changes.credits.newValue || 0);
  }
  if (changes.pendingUpdate) checkUpdate();
});

// ── Badge selector ────────────────────────────────────────────────────────────
async function initBadgeSelector(username) {
  const card = document.getElementById('badge-selector-card');
  if (!card) return;

  const { myActiveBadgeId } = await chrome.storage.local.get(['myActiveBadgeId']);
  const { token } = await chrome.storage.local.get(['token']);

  let userBadges = [];
  try {
    const res = await fetch(`${API}/badges/batch?users=${encodeURIComponent(username)}`);
    if (res.ok) {
      const data = await res.json();
      userBadges = data[username]?.badges || [];
    }
  } catch {}

  const list = document.getElementById('badge-list');
  list.innerHTML = '';

  if (!userBadges.length) {
    card.style.display = 'none';
    return;
  }

  card.style.display = '';
  const activeId = myActiveBadgeId || userBadges[0]?.id;

  // Persist all badges + active badge so the content script menu can show and switch them
  const activeBadge = userBadges.find(b => b.id === activeId) ?? userBadges[0];
  chrome.storage.local.set({
    myBadges: userBadges.map(b => ({ id: b.id, slug: b.slug, name: b.name, image_url: b.image_url })),
    myActiveBadgeId: activeBadge?.id,
    myBadgeAssignment: activeBadge ? { username, slug: activeBadge.slug, name: activeBadge.name, image_url: activeBadge.image_url } : null,
  });

  userBadges.forEach(badge => {
    const btn = document.createElement('button');
    btn.className = 'badge-option' + (badge.id === activeId ? ' badge-option-active' : '');
    btn.title = badge.name;

    const img = document.createElement('img');
    const imageUrl = badge.image_url.startsWith('http') ? badge.image_url : `${API}${badge.image_url}`;
    img.src = imageUrl;
    img.alt = badge.name;

    btn.appendChild(img);
    list.appendChild(btn);

    btn.addEventListener('click', async () => {
      list.querySelectorAll('.badge-option').forEach(b => b.classList.remove('badge-option-active'));
      btn.classList.add('badge-option-active');

      await chrome.storage.local.set({
        myActiveBadgeId:   badge.id,
        myBadgeAssignment: { username, slug: badge.slug, name: badge.name, image_url: badge.image_url },
      });
      if (token) {
        try {
          await fetch(`${API}/badges/active`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ badge_id: badge.id }),
          });
        } catch {}
      }
    });
  });
}
init();
