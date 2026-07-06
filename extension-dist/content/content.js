// â”€â”€â”€ Config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const API            = 'https://api.subi.live';
const EXT_KEY        = '38b07e19b0c8a71283f9413e965c38ab';
const USER_LANG      = (navigator.language || '').slice(0, 2).toLowerCase() || null;
const ROTATE_MS      = 15_000;
let   VISIBILITY_MS  = 30_000;  // overridden by /ads/config on init

// Fetch dynamic config from server and apply impression interval
fetch(`${API}/ads/config`).then(r => r.ok ? r.json() : null).then(cfg => {
  if (cfg?.impressionIntervalMs) VISIBILITY_MS = cfg.impressionIntervalMs;
}).catch(() => {});

// Extract userId from JWT (no signature verification needed client-side)
function getUserIdFromToken(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.userId ?? payload.sub ?? null;
  } catch { return null; }
}

// â”€â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function safeUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:') return u.href;
  } catch {}
  return '#';
}

// i18n helper â€” falls back to the key if the message is missing
function t(key) {
  try { return chrome.i18n.getMessage(key) || key; } catch { return key; }
}

function isChannelLive() {
  for (const s of document.querySelectorAll('span')) {
    if (s.textContent.trim() === 'LIVE') return true;
  }
  return false;
}

// Returns false when the extension has been reloaded/invalidated
function extAlive() {
  try { return !!chrome.runtime?.id; } catch { return false; }
}

function getToken() {
  if (!extAlive()) return Promise.resolve(null);
  return new Promise(r => {
    try {
      chrome.storage.local.get(['token'], ({ token }) => r(token || null));
    } catch { r(null); }
  });
}

// â”€â”€â”€ Placement min bids (mirrors server constants) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const PLACEMENT_MIN_CPM = { banner: 500, chat_sticky: 500, chat_card: 500 };

async function fetchRotation(placement, userId) {
  try {
    const langParam = USER_LANG ? `&userLang=${USER_LANG}` : '';
    const url = userId
      ? `${API}/ads/next?placement=${placement}&userId=${encodeURIComponent(userId)}${langParam}`
      : `${API}/ads/rotation?placement=${placement}${langParam}`;
    const res = await fetch(url);
    if (!res.ok || res.status === 204) return [];
    const data = await res.json();
    // /ads/next returns { ad } â€” wrap in array; /ads/rotation returns { ads }
    if (data.ad)  return [data.ad];
    return data.ads ?? [];
  } catch { return []; }
}

// â”€â”€â”€ Weighted ad array: higher bid = more slots â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// $10 CPM on a $5 min â†' weight 2 â†' appears 2x as often as the min bidder.
function buildWeightedAds(ads, placement) {
  const minBid = PLACEMENT_MIN_CPM[placement] ?? 300;
  const result = [];
  for (const ad of ads) {
    const weight = Math.max(1, Math.round(ad.bid_cpm_cents / minBid));
    for (let i = 0; i < weight; i++) result.push(ad);
  }
  // Fisher-Yates shuffle so the order changes each refresh
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

const logoCache = new Map();
async function resolveLogoSrc(ad) {
  if (!ad.logo_url) return null;
  if (logoCache.has(ad.logo_url)) return logoCache.get(ad.logo_url);
  if (ad.logo_url.startsWith('https://')) { logoCache.set(ad.logo_url, ad.logo_url); return ad.logo_url; }
  const fullUrl = ad.logo_url.startsWith('http') ? ad.logo_url : `${API}${ad.logo_url}`;
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'FETCH_IMAGE', url: fullUrl }, (r) => {
      const val = r?.dataUrl ?? null;
      if (val) logoCache.set(ad.logo_url, val);
      resolve(val);
    });
  });
}

function logoHTML(ad, cls, src) {
  if (src) return `<img class="${cls}" src="${src}" alt="${esc(ad.name)}" />`;
  return `<span class="${cls} ${cls}--text">${esc(ad.name.slice(0, 4))}</span>`;
}

// â”€â”€â”€ Global impression timers â€” one interval per placement, survive reinjection â”€
const _placementState = {};

function makeVisibilityTracker(el, getAd, placement) {
  // If interval already running for this placement, just update the element ref
  if (_placementState[placement]) {
    _placementState[placement].el = el;
    return () => {}; // teardown is a no-op; interval lives on
  }

  const state = { el };

  const interval = setInterval(async () => {
    const currentEl = state.el;
    if (!currentEl || !document.contains(currentEl)) return;

    let ad;
    try { ad = getAd(); } catch { return; }
    const token = await getToken();
    if (!token || !ad?.id) return;

    try {
      const res = await fetch(`${API}/impressions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'x-subi-key': EXT_KEY,
        },
        body: JSON.stringify({ campaignId: ad.id, placement, viewedSeconds: 5 }),
      });
      if (!res.ok) return;

      const { totalCredits, dailyCredits, capReached } = await res.json();
      if (!extAlive()) return;
      chrome.storage.local.set({
        credits:      totalCredits,
        dailyCredits: dailyCredits ?? 0,
        capReached:   capReached ?? false,
      });
    } catch { /* network error â€” skip */ }
  }, VISIBILITY_MS);

  _placementState[placement] = { el, interval };

  // no-op â€” interval is global and must not be cleared on render/reinject cycles
  return () => {};
}

class Rotator {
  constructor(ads) { this.ads = ads; this.index = 0; this.timer = null; }
  current() { return this.ads[this.index % this.ads.length]; }
  next() { this.index = (this.index + 1) % this.ads.length; return this.current(); }
  start(onSwitch) { if (this.ads.length > 1) this.timer = setInterval(() => onSwitch(this.next()), ROTATE_MS); }
  stop() { clearInterval(this.timer); }
  // Hot-swap the ad list without stopping the rotation timer
  updateAds(newAds) { this.ads = newAds; this.index = this.index % newAds.length; }
}

// â”€â”€â”€ Placeholder HTML â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const CONNECT_URL = 'https://subi.live/dashboard';

function bannerPlaceholderHTML(connected = false) {
  if (connected) return `
    <div class="subi-banner-inner subi-placeholder">
      <span class="subi-ph-text">${t('ph_no_ads_banner')}</span>
    </div>`;
  return `
    <div class="subi-banner-inner subi-placeholder">
      <span class="subi-ph-text">${t('ph_connect_banner')}</span>
      <a class="subi-cta" href="${CONNECT_URL}" target="_blank" rel="noopener noreferrer">${t('cta_connect_twitch')}</a>
    </div>`;
}

function chatBannerPlaceholderHTML(connected = false) {
  if (connected) return `
    <div class="subi-cb-inner subi-placeholder">
      <div class="subi-cb-body">
        <p class="subi-cb-headline">${t('ph_no_ads')}</p>
      </div>
      <span class="subi-cb-sponsored">Subi</span>
    </div>`;
  return `
    <div class="subi-cb-inner subi-placeholder">
      <div class="subi-cb-body">
        <p class="subi-cb-headline">${t('ph_connect_chat')}</p>
        <a class="subi-cb-cta" href="${CONNECT_URL}" target="_blank" rel="noopener noreferrer">${t('cta_connect_twitch')}</a>
      </div>
      <span class="subi-cb-sponsored">Subi</span>
    </div>`;
}

// â”€â”€â”€ 1. BELOW-PLAYER BANNER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const REFETCH_MS = 30_000;   // re-fetch rotation every 30 s

let bannerMounted    = false;
let bannerEl         = null;
let bannerRotator    = null;
let bannerStopVis    = null;
let bannerRefetch    = null;

function teardownBanner() {
  if (bannerRotator) { bannerRotator.stop(); bannerRotator = null; }
  if (bannerStopVis) { bannerStopVis(); bannerStopVis = null; }
  if (bannerRefetch) { clearInterval(bannerRefetch); bannerRefetch = null; }
}

async function renderBannerContent(hasToken) {
  if (!bannerEl) return;
  teardownBanner();

  // Always keep polling so new campaigns appear and expired ones disappear
  bannerRefetch = setInterval(async () => {
    await renderBannerContent(!!(await getToken()));
  }, REFETCH_MS);

  if (!hasToken) {
    bannerEl.style.backgroundImage = '';
    bannerEl.style.backgroundColor = '#18181b';
    bannerEl.innerHTML = bannerPlaceholderHTML();
    return;
  }

  const token = await getToken();
  const userId = token ? getUserIdFromToken(token) : null;
  const ads = await fetchRotation('banner', userId);
  if (!ads.length) {
    bannerEl.style.backgroundImage = '';
    bannerEl.style.backgroundColor = '#18181b';
    bannerEl.innerHTML = bannerPlaceholderHTML(true);
    return;
  }

  bannerRotator = new Rotator(buildWeightedAds(ads, 'banner'));
  bannerStopVis = makeVisibilityTracker(bannerEl, () => bannerRotator.current(), 'banner');

  async function renderAd(ad) {
    const src = await resolveLogoSrc(ad);
    bannerEl.style.backgroundColor = 'transparent';
    bannerEl.style.backgroundImage = `linear-gradient(135deg, ${ad.color_from} 0%, ${ad.color_to} 100%)`;
    bannerEl.innerHTML = `
      <div class="subi-banner-inner">
        ${logoHTML(ad, 'subi-banner-logo', src)}
        <span class="subi-text">${esc(ad.headline)}</span>
        <a class="subi-cta" href="${safeUrl(ad.url)}" target="_blank" rel="noopener noreferrer">${esc(ad.cta_text)} â†'</a>
      </div>`;
  }

  await renderAd(bannerRotator.current());
  bannerRotator.start(ad => renderAd(ad));
}

async function injectBanner() {
  if (bannerMounted) return;
  if (!isChannelLive()) return;
  bannerMounted = true;

  const container = document.getElementById('live-channel-stream-information');
  if (!container) { bannerMounted = false; return; }

  bannerEl = document.createElement('div');
  bannerEl.id = 'subi-banner';
  container.prepend(bannerEl);

  await renderBannerContent(!!(await getToken()));
}

// â”€â”€â”€ 2. CHAT STICKY BANNER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let chatBannerMounted  = false;
let chatBannerEl       = null;
let chatBannerRotator  = null;
let chatBannerStopVis  = null;
let chatBannerRefetch  = null;

function teardownChatBanner() {
  if (chatBannerRotator) { chatBannerRotator.stop(); chatBannerRotator = null; }
  if (chatBannerStopVis) { chatBannerStopVis(); chatBannerStopVis = null; }
  if (chatBannerRefetch) { clearInterval(chatBannerRefetch); chatBannerRefetch = null; }
}

async function renderChatBannerContent(hasToken) {
  if (!chatBannerEl) return;
  teardownChatBanner();

  chatBannerRefetch = setInterval(async () => {
    await renderChatBannerContent(!!(await getToken()));
  }, REFETCH_MS);

  if (!hasToken) {
    chatBannerEl.style.backgroundImage = '';
    chatBannerEl.style.backgroundColor = '#111114';
    chatBannerEl.innerHTML = chatBannerPlaceholderHTML();
    return;
  }

  const token2 = await getToken();
  const userId2 = token2 ? getUserIdFromToken(token2) : null;
  const ads = await fetchRotation('chat_sticky', userId2);
  if (!ads.length) {
    chatBannerEl.style.backgroundImage = '';
    chatBannerEl.style.backgroundColor = '#111114';
    chatBannerEl.innerHTML = chatBannerPlaceholderHTML(true);
    return;
  }

  chatBannerRotator = new Rotator(buildWeightedAds(ads, 'chat_sticky'));
  chatBannerStopVis = makeVisibilityTracker(chatBannerEl, () => chatBannerRotator.current(), 'chat_sticky');

  async function renderAd(ad) {
    const src = await resolveLogoSrc(ad);
    chatBannerEl.style.backgroundColor = 'transparent';
    chatBannerEl.style.backgroundImage = `linear-gradient(135deg, ${ad.color_from} 0%, ${ad.color_to} 100%)`;
    chatBannerEl.style.setProperty('--subi-accent', ad.color_to);
    chatBannerEl.innerHTML = `
      <div class="subi-cb-accent"></div>
      <div class="subi-cb-inner">
        ${logoHTML(ad, 'subi-cb-logo', src)}
        <div class="subi-cb-body">
          <p class="subi-cb-headline">${esc(ad.headline)}</p>
          <a class="subi-cb-cta" href="${safeUrl(ad.url)}" target="_blank" rel="noopener noreferrer">${esc(ad.cta_text)} â†'</a>
        </div>
        <span class="subi-cb-sponsored">${t('sponsored')}</span>
        <button class="subi-cb-close" title="${t('dismiss')}">âœ•</button>
      </div>`;
    chatBannerEl.querySelector('.subi-cb-close').addEventListener('click', () => {
      teardownChatBanner();
      chatBannerEl.remove();
      chatBannerEl = null;
      chatBannerMounted = false;
    });
  }

  await renderAd(chatBannerRotator.current());
  chatBannerRotator.start(ad => renderAd(ad));
}

function findLeaderboardPanel() {
  // Find the subs/clips/leaderboard panel at the top of the chat section
  const inner = document.querySelector('[class*="channelLeaderboard"]')
             || document.querySelector('[class*="leaderboard"]')
             || document.querySelector('[aria-label*="classement"]')
             || document.querySelector('[aria-label*="leaderboard"]')
             || document.querySelector('[aria-label*="Leaderboard"]');
  if (!inner) return null;
  const section = findChatSection();
  if (!section) return null;
  // Walk up until we reach a direct child of the section
  let node = inner;
  while (node && node.parentElement !== section) node = node.parentElement;
  return node || null;
}

async function injectChatBanner() {
  if (chatBannerMounted) return;
  if (!isChannelLive()) return;
  chatBannerMounted = true;

  const parent = document.querySelector('.chat-room__content');
  if (!parent) { chatBannerMounted = false; return; }

  chatBannerEl = document.createElement('div');
  chatBannerEl.id = 'subi-chat-banner';

  const firstChild = parent.firstElementChild;
  if (firstChild && firstChild.nextSibling) {
    parent.insertBefore(chatBannerEl, firstChild.nextSibling);
  } else if (firstChild) {
    parent.appendChild(chatBannerEl);
  } else {
    parent.prepend(chatBannerEl);
  }

  await renderChatBannerContent(!!(await getToken()));
}

// â”€â”€â”€ 3. CHAT CARD (persistent, same pattern as banner/chat_sticky) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let chatCardMounted  = false;
let chatCardEl       = null;
let chatCardRotator  = null;
let chatCardStopVis  = null;
let chatCardRefetch  = null;

function teardownChatCard() {
  if (chatCardRotator) { chatCardRotator.stop(); chatCardRotator = null; }
  if (chatCardStopVis) { chatCardStopVis(); chatCardStopVis = null; }
  if (chatCardRefetch) { clearInterval(chatCardRefetch); chatCardRefetch = null; }
}

function chatCardPlaceholderHTML(connected = false) {
  if (connected) return `
    <div class="subi-chat-msg-inner subi-placeholder">
      <p class="subi-chat-msg-headline">${t('ph_no_ads')}</p>
    </div>`;
  return `
    <div class="subi-chat-msg-inner subi-placeholder">
      <p class="subi-chat-msg-headline">${t('ph_connect_card')}</p>
      <a class="subi-chat-msg-cta" href="${CONNECT_URL}" target="_blank" rel="noopener noreferrer">${t('cta_connect_short')}</a>
    </div>`;
}

async function renderChatCardContent(hasToken) {
  if (!chatCardEl) return;
  teardownChatCard();

  chatCardRefetch = setInterval(async () => {
    await renderChatCardContent(!!(await getToken()));
  }, REFETCH_MS);

  if (!hasToken) {
    chatCardEl.innerHTML = chatCardPlaceholderHTML();
    return;
  }

  const token3 = await getToken();
  const userId3 = token3 ? getUserIdFromToken(token3) : null;
  const ads = await fetchRotation('chat_card', userId3);
  if (!ads.length) { chatCardEl.innerHTML = chatCardPlaceholderHTML(true); return; }

  chatCardRotator = new Rotator(buildWeightedAds(ads, 'chat_card'));
  chatCardStopVis = makeVisibilityTracker(chatCardEl, () => chatCardRotator.current(), 'chat_card');

  async function renderAd(ad) {
    const src = await resolveLogoSrc(ad);
    chatCardEl.style.background = `linear-gradient(135deg, ${ad.color_from} 0%, ${ad.color_to} 100%)`;
    chatCardEl.innerHTML = `
      <div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(255,255,255,0.12) 0%,transparent 60%);border-radius:inherit;pointer-events:none"></div>
      ${logoHTML(ad, 'subi-chat-msg-logo', src)}
      <p class="subi-chat-msg-headline">${esc(ad.headline)}</p>
      <a class="subi-chat-msg-cta" href="${safeUrl(ad.url)}" target="_blank" rel="noopener noreferrer">${esc(ad.cta_text)} â†'</a>
      <span class="subi-chat-msg-ad-tag">${t('ad_tag')}</span>`;
  }

  await renderAd(chatCardRotator.current());
  chatCardRotator.start(ad => renderAd(ad));
}

async function injectChatCard() {
  if (chatCardMounted) return;
  if (!isChannelLive()) return;
  chatCardMounted = true;

  const btnsContainer = document.querySelector('[data-test-selector="chat-input-buttons-container"]');
  const parent = btnsContainer ? btnsContainer.parentElement : null;
  if (!parent) { chatCardMounted = false; return; }

  chatCardEl = document.createElement('div');
  chatCardEl.className = 'subi-chat-msg';

  const firstChild = parent.firstElementChild;
  if (firstChild && firstChild.nextSibling) {
    parent.insertBefore(chatCardEl, firstChild.nextSibling);
  } else if (firstChild) {
    parent.appendChild(chatCardEl);
  } else {
    parent.prepend(chatCardEl);
  }

  await renderChatCardContent(!!(await getToken()));
}


// --- Chat input button + floating menu ----------------------------------
function isTwitchLight() {
  const html = document.documentElement;
  if (html.classList.contains('tw-root--theme-light')) return true;
  if (html.classList.contains('tw-root--theme-dark'))  return false;
  // Fallback: measure body background brightness
  const bg = getComputedStyle(document.body).backgroundColor;
  const m  = bg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)/);
  return m ? (Number(m[1]) + Number(m[2]) + Number(m[3])) > 382 : false;
}

function subiButtonIcon() {
  return chrome.runtime.getURL(isTwitchLight() ? 'icons/logo-full-purple.png' : 'icons/logo-full-white.png');
}

let chatInputBtnMounted = false;
let chatInputBtnEl      = null;
let subiMenuEl          = null;
let subiMenuOpen        = false;
let subiMenuAutoUpdate  = null; // cleanup fn for resize/scroll listeners

function ensureSubiMenuStyles() {
  if (document.getElementById('subi-menu-styles')) return;
  const s = document.createElement('style');
  s.id = 'subi-menu-styles';
  s.textContent = `
    #subi-chat-menu {
      position: fixed;
      z-index: 100000;
      width: 280px;
      font-size: 13px;
      background: #171717e8;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      outline: 1px solid rgba(255,255,255,.1);
      border-radius: 6px;
      color: #efeff1;
      font-family: var(--font-base,'Roobert',system-ui,sans-serif);
      display: none;
      overflow: hidden;
      box-shadow: 0 8px 40px rgba(0,0,0,.7);
    }
    #subi-chat-menu.open {
      display: block;
      animation: subi-slide-in .15s cubic-bezier(.2,.8,.3,1) both;
    }
    @keyframes subi-slide-in {
      from { opacity:0; transform:translateY(8px) scale(.97); }
      to   { opacity:1; transform:translateY(0)   scale(1);   }
    }
    #subi-chat-menu .sm-bg-logo {
      position: absolute; inset: 0; width: 100%; height: 100%;
      object-fit: contain; object-position: center;
      opacity: 0.04; filter: grayscale(1) brightness(3);
      pointer-events: none; user-select: none;
      padding: 20px; box-sizing: border-box;
    }
    #subi-chat-menu .sm-profile {
      display: flex; align-items: center; gap: 10px;
      padding: 12px 14px 10px;
      border-bottom: 1px solid rgba(255,255,255,.08);
    }
    #subi-chat-menu .sm-avatar {
      width: 36px; height: 36px; border-radius: 50%; object-fit: cover;
      border: 2px solid rgba(145,71,255,.5); flex-shrink: 0;
    }
    #subi-chat-menu .sm-avatar-placeholder {
      width: 36px; height: 36px; border-radius: 50%; flex-shrink: 0;
      background: rgba(145,71,255,.3); display:flex; align-items:center; justify-content:center;
      font-weight:700; font-size:14px; color:#bf9bff;
    }
    #subi-chat-menu .sm-profile-info { display:flex; flex-direction:column; gap:1px; }
    #subi-chat-menu .sm-username { font-size:13px; font-weight:700; color:#efeff1; }
    #subi-chat-menu .sm-subtitle { font-size:11px; color:#adadb8; }
    #subi-chat-menu .sm-body { padding: 12px 14px; display:flex; flex-direction:column; gap:10px; }
    #subi-chat-menu .sm-row { display:flex; justify-content:space-between; align-items:center; }
    #subi-chat-menu .sm-label { color:#adadb8; font-size:12px; }
    #subi-chat-menu .sm-value { font-weight:700; font-size:13px; }
    #subi-chat-menu .sm-value.capped { color:#e91916; }
    #subi-chat-menu .sm-progress-wrap { display:flex; flex-direction:column; gap:5px; }
    #subi-chat-menu .sm-progress-track {
      height: 5px; border-radius: 3px;
      background: rgba(255,255,255,.1); overflow:hidden;
    }
    #subi-chat-menu .sm-progress-fill {
      height:100%; border-radius:3px;
      background: linear-gradient(90deg,#9147ff,#bf9bff);
      transition: width .4s ease;
    }
    #subi-chat-menu .sm-badge-section { display:flex; flex-direction:column; gap:8px; }
    #subi-chat-menu .sm-badges { display:flex; flex-wrap:wrap; gap:6px; }
    #subi-chat-menu .sm-badge-btn {
      width: 36px; height: 36px; padding: 4px;
      background: rgba(255,255,255,.06); border: 2px solid transparent;
      border-radius: 6px; cursor: pointer; display:flex; align-items:center; justify-content:center;
      transition: border-color .15s, background .15s;
    }
    #subi-chat-menu .sm-badge-btn:hover { background: rgba(255,255,255,.1); }
    #subi-chat-menu .sm-badge-btn.active {
      border-color: #9147ff; background: rgba(145,71,255,.2);
    }
    #subi-chat-menu .sm-badge-btn img { width: 24px; height: 24px; object-fit: contain; }
    #subi-chat-menu .sm-divider { height:1px; background:rgba(255,255,255,.08); }
    #subi-chat-menu .sm-footer {
      padding: 10px 14px; display:flex; flex-direction:column; gap:6px;
      background: rgba(255,255,255,.03);
    }
    #subi-chat-menu .sm-btn {
      width:100%; padding: 7px 12px; border-radius:4px; border:none;
      cursor:pointer; font-weight:600; font-size:12px; transition:filter .15s;
      font-family:inherit; text-align:center;
    }
    #subi-chat-menu .sm-btn:hover { filter:brightness(1.15); }
    #subi-chat-menu .sm-btn-primary { background:#9147ff; color:#fff; }
    #subi-chat-menu .sm-btn-secondary { background:rgba(255,255,255,.08); color:#efeff1; }
    #subi-chat-menu .sm-login-desc {
      color:#adadb8; font-size:12px; text-align:center; line-height:1.6; padding:4px 0;
    }
    #subi-chat-menu .sm-test-badge {
      position: absolute; top: 6px; right: 8px;
      font-size: 9px; font-weight: 800; letter-spacing: .06em;
      color: #9147ff; opacity: .6; pointer-events: none; z-index: 1;
    }
    /* ── Light theme overrides ── */
    #subi-chat-menu.sm-light {
      background: rgba(241,241,244,.97);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      outline: 1px solid rgba(0,0,0,.1);
      color: #18181b;
      box-shadow: 0 8px 40px rgba(0,0,0,.15);
    }
    #subi-chat-menu.sm-light .sm-label { color: #53535f; }
    #subi-chat-menu.sm-light .sm-value { color: #18181b; }
    #subi-chat-menu.sm-light .sm-subtitle { color: #6b7280; }
    #subi-chat-menu.sm-light .sm-username { color: #18181b; }
    #subi-chat-menu.sm-light .sm-profile { border-bottom-color: rgba(0,0,0,.08); }
    #subi-chat-menu.sm-light .sm-divider { background: rgba(0,0,0,.08); }
    #subi-chat-menu.sm-light .sm-footer { background: rgba(0,0,0,.03); }
    #subi-chat-menu.sm-light .sm-body { background: transparent; }
    #subi-chat-menu.sm-light .sm-badge-btn { background: rgba(0,0,0,.06); }
    #subi-chat-menu.sm-light .sm-badge-btn:hover { background: rgba(0,0,0,.12); }
    #subi-chat-menu.sm-light .sm-badge-btn.active { border-color: #9147ff; background: rgba(145,71,255,.12); }
    #subi-chat-menu.sm-light .sm-progress-track { background: rgba(0,0,0,.1); }
    #subi-chat-menu.sm-light .sm-bg-logo { opacity: 0.06; }
    #subi-chat-menu.sm-light .sm-login-desc { color: #53535f; }
    #subi-chat-menu.sm-light .sm-btn-secondary { background: rgba(0,0,0,.08); color: #18181b; }
    #subi-chat-menu.sm-light .sm-avatar-placeholder { background: rgba(145,71,255,.2); }
  `;
  document.head.appendChild(s);
}

function buildSubiMenu() {
  if (subiMenuEl) return;
  ensureSubiMenuStyles();
  const el = document.createElement('div');
  el.id = 'subi-chat-menu';
  el.innerHTML = `
    <img class="sm-bg-logo" src="${chrome.runtime.getURL('icons/logo-full-purple.png')}" alt=""/>
    <div class="sm-test-badge">TEST</div>
    <div id="sm-content"></div>`;
  document.body.appendChild(el);
  subiMenuEl = el;

  document.addEventListener('click', (e) => {
    if (!subiMenuOpen) return;
    if (!subiMenuEl.contains(e.target) && !chatInputBtnEl?.contains(e.target))
      closeSubiMenu();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && subiMenuOpen) closeSubiMenu();
  });
}

function buildMenuHTML(data, token) {
  const { username, avatar, credits, daily, capped, badges, activeId } = data;
  const pct = Math.min(100, (credits / 1000) * 100).toFixed(1);

  const avatarHtml = avatar
    ? `<img class="sm-avatar" src="${esc(avatar)}" alt=""/>`
    : `<div class="sm-avatar-placeholder">${esc((username||'?')[0].toUpperCase())}</div>`;
  const profileHtml = username ? `
    <div class="sm-profile">
      ${avatarHtml}
      <div class="sm-profile-info">
        <span class="sm-username">${esc(username)}</span>
        <span class="sm-subtitle">Subi</span>
      </div>
    </div>` : '';

  let badgeHtml = '';
  if (badges.length) {
    const items = badges.map(b => {
      const imgUrl = b.image_url?.startsWith('http') ? b.image_url : `${API}${b.image_url}`;
      const isActive = activeId ? String(b.id) === String(activeId) : b === badges[0];
      return `<button class="sm-badge-btn${isActive ? ' active' : ''}" data-badge-id="${esc(String(b.id))}" title="${esc(b.name||'')}">
        <img src="${esc(imgUrl)}" alt="${esc(b.name||'')}"/>
      </button>`;
    }).join('');
    badgeHtml = `<div class="sm-badge-section"><span class="sm-label">Badges</span><div class="sm-badges">${items}</div></div>`;
  }

  return `
    ${profileHtml}
    <div class="sm-body">
      <div class="sm-row">
        <span class="sm-label">Crédits</span>
        <span class="sm-value">${Number(credits).toLocaleString()}</span>
      </div>
      <div class="sm-row">
        <span class="sm-label">Gagnés aujourd'hui</span>
        <span class="sm-value${capped ? ' capped' : ''}">${daily} / 60${capped ? ' · max' : ''}</span>
      </div>
      <div class="sm-progress-wrap">
        <div class="sm-row">
          <span class="sm-label">Progression vers un abo offert</span>
          <span class="sm-label">${Number(credits).toLocaleString()} / 1,000</span>
        </div>
        <div class="sm-progress-track"><div class="sm-progress-fill" style="width:${pct}%"></div></div>
      </div>
      ${badgeHtml}
    </div>
    <div class="sm-divider"></div>
    <div class="sm-footer">
      <button class="sm-btn sm-btn-primary" id="sm-dash-btn">Ouvrir le dashboard</button>
    </div>`;
}

function bindMenuEvents(content, badges, token, username) {
  document.getElementById('sm-dash-btn')?.addEventListener('click', () => {
    window.open('https://subi.live/dashboard', '_blank');
    closeSubiMenu();
  });
  content.querySelectorAll('.sm-badge-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const badge = badges.find(b => String(b.id) === btn.dataset.badgeId);
      if (!badge) return;
      content.querySelectorAll('.sm-badge-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      chrome.storage.local.set({
        myActiveBadgeId: badge.id,
        myBadgeAssignment: { username, slug: badge.slug, name: badge.name, image_url: badge.image_url },
      });
      fetch(`${API}/badges/active`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ badge_id: badge.id }),
      }).catch(() => {});
    });
  });
}

function renderSubiMenuContent(afterRender) {
  if (!extAlive()) return;
  const content = document.getElementById('sm-content');
  if (!content) return;

  chrome.storage.local.get(
    ['token','credits','dailyCredits','capReached','myTwitchUsername','myTwitchAvatar','myBadges','myActiveBadgeId'],
    (r) => {
      if (!r.token) {
        content.innerHTML = `
          <div class="sm-body">
            <p class="sm-login-desc">Connecte ton compte Twitch pour gagner des crédits en regardant des pubs et les échanger contre des abos offerts.</p>
          </div>
          <div class="sm-divider"></div>
          <div class="sm-footer">
            <button class="sm-btn sm-btn-primary" id="sm-connect-btn">Se connecter avec Twitch</button>
          </div>`;
        document.getElementById('sm-connect-btn')?.addEventListener('click', () => {
          window.open('https://subi.live/dashboard', '_blank');
          closeSubiMenu();
        });
        afterRender?.();
        return;
      }

      // Show immediately with cached data
      const cachedData = {
        username: r.myTwitchUsername || '',
        avatar:   r.myTwitchAvatar   || '',
        credits:  r.credits          || 0,
        daily:    r.dailyCredits     || 0,
        capped:   r.capReached       || (r.dailyCredits || 0) >= 60,
        badges:   r.myBadges         || [],
        activeId: r.myActiveBadgeId,
      };
      content.innerHTML = buildMenuHTML(cachedData, r.token);
      bindMenuEvents(content, cachedData.badges, r.token, cachedData.username);
      afterRender?.();

      // Fetch fresh data in background and update silently
      (async () => {
        try {
          const meRes = await fetch(`${API}/auth/me`, { headers: { Authorization: `Bearer ${r.token}` } });
          if (!meRes.ok) return;
          const { user: me } = await meRes.json();
          const username = me.twitch_username?.toLowerCase() || r.myTwitchUsername || '';

          let badges = r.myBadges || [];
          if (username) {
            const br = await fetch(`${API}/badges/batch?users=${encodeURIComponent(username)}`);
            if (br.ok) {
              const bd = await br.json();
              badges = bd[username]?.badges || [];
            }
          }

          // Persist for next open
          chrome.storage.local.set({
            myTwitchUsername: username,
            myTwitchAvatar:   me.twitch_avatar || '',
            credits:          me.credits ?? r.credits,
            myBadges: badges.map(b => ({ id: b.id, slug: b.slug, name: b.name, image_url: b.image_url })),
          });

          // Re-render only if menu is still open
          if (!subiMenuOpen || !document.getElementById('sm-content')) return;
          const fresh = await chrome.storage.local.get(['myActiveBadgeId']);
          const freshData = {
            username: username,
            avatar:   me.twitch_avatar || '',
            credits:  me.credits ?? r.credits ?? 0,
            daily:    r.dailyCredits || 0,
            capped:   r.capReached || (r.dailyCredits || 0) >= 60,
            badges,
            activeId: fresh.myActiveBadgeId,
          };
          content.innerHTML = buildMenuHTML(freshData, r.token);
          bindMenuEvents(content, badges, r.token, username);
          positionSubiMenu(); // reposition since content size may have changed
        } catch (_) {}
      })();
    }
  );
}

function positionSubiMenu() {
  if (!subiMenuEl) return;

  // Measure dimensions while hidden
  subiMenuEl.style.visibility = 'hidden';
  subiMenuEl.style.display    = 'block';
  const menuW = subiMenuEl.offsetWidth  || 280;
  const menuH = subiMenuEl.offsetHeight || 300;
  subiMenuEl.style.visibility = '';

  // Mirror 7TV's anchor: .chat-input is the outer wrapper of .chat-input__textarea
  // 7TV uses placement:"top-end", mainAxis:4, crossAxis:-4
  const anchor = document.querySelector('.chat-input')
              ?? document.querySelector('.chat-input__textarea')
              ?? document.querySelector('[data-test-selector="chat-input-buttons-container"]')?.closest('form')
              ?? document.querySelector('[data-test-selector="chat-input-buttons-container"]')?.parentElement;
  if (!anchor) return;

  const rect = anchor.getBoundingClientRect();
  // top-end: above the anchor, right-aligned
  const top  = rect.top - menuH - 12;   // more gap from bottom
  const left = Math.max(8, rect.left + (rect.width - menuW) / 2); // centered in chat panel

  subiMenuEl.style.top  = top  + 'px';
  subiMenuEl.style.left = left + 'px';
}

function startMenuAutoUpdate() {
  if (subiMenuAutoUpdate) return;
  const onUpdate = () => { if (subiMenuOpen) positionSubiMenu(); };
  window.addEventListener('resize', onUpdate);
  window.addEventListener('scroll', onUpdate, true);
  const anchor = document.querySelector('.chat-input') ?? document.querySelector('.chat-input__textarea');
  const ro = anchor ? new ResizeObserver(onUpdate) : null;
  if (ro) ro.observe(anchor);
  subiMenuAutoUpdate = () => {
    window.removeEventListener('resize', onUpdate);
    window.removeEventListener('scroll', onUpdate, true);
    if (ro) ro.disconnect();
  };
}

function stopMenuAutoUpdate() {
  if (subiMenuAutoUpdate) { subiMenuAutoUpdate(); subiMenuAutoUpdate = null; }
}

function openSubiMenu() {
  buildSubiMenu();
  subiMenuOpen = true;
  subiMenuEl.classList.toggle('sm-light', isTwitchLight());
  // Button turns purple when menu is open (like 7TV turns blue)
  const btnImg = chatInputBtnEl?.querySelector('img');
  if (btnImg) btnImg.src = chrome.runtime.getURL('icons/logo-full-purple.png');
  chatInputBtnEl?.querySelector('button')?.classList.add('menu-open');
  renderSubiMenuContent(() => {
    positionSubiMenu();
    startMenuAutoUpdate();
  });
}

function closeSubiMenu() {
  if (subiMenuEl) subiMenuEl.style.display = 'none';
  // Restore button icon to theme default
  const btnImg = chatInputBtnEl?.querySelector('img');
  if (btnImg) btnImg.src = subiButtonIcon();
  chatInputBtnEl?.querySelector('button')?.classList.remove('menu-open');
  subiMenuOpen = false;
  stopMenuAutoUpdate();
}


function injectChatInputButton() {
  if (chatInputBtnMounted) return;

  const emoteBtn = document.querySelector('[data-a-target="emote-picker-button"]');
  if (!emoteBtn) return;

  const emoteWrapper = emoteBtn.parentElement;
  const buttonsRow   = emoteWrapper?.parentElement;
  if (!buttonsRow) return;

  chatInputBtnMounted = true;

  const wrap = document.createElement('div');
  wrap.id = 'subi-chat-input-btn';
  wrap.className = emoteWrapper.className;

  const btn = document.createElement('button');
  btn.title = 'Subi';
  btn.setAttribute('aria-label', 'Subi');
  btn.className = emoteBtn.className;
  btn.style.cssText = 'cursor:pointer;';

  const img = document.createElement('img');
  img.src = subiButtonIcon();
  img.alt = 'Subi';
  img.style.cssText = 'width:20px;height:20px;object-fit:contain;display:block;';

  btn.appendChild(img);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    subiMenuOpen ? closeSubiMenu() : openSubiMenu();
  });
  wrap.appendChild(btn);

  buttonsRow.insertBefore(wrap, emoteWrapper);

  const paddingDiv = document.querySelector('.chat-wysiwyg-input-box div[style*="padding-inline"]');
  if (paddingDiv) {
    const m = paddingDiv.style.cssText.match(/padding-inline:\s*[\d.]+px\s+([\d.]+)px/);
    if (m) {
      paddingDiv.dataset.subiOrigPadding = m[1];
      paddingDiv.style.paddingInlineEnd = (parseFloat(m[1]) + 30) + 'px';
    }
  }

  chatInputBtnEl = wrap;
}

function teardownChatInputButton() {
  closeSubiMenu();
  if (chatInputBtnEl) chatInputBtnEl.remove();
  const paddingDiv = document.querySelector('.chat-wysiwyg-input-box div[style*="padding-inline"]');
  if (paddingDiv?.dataset.subiOrigPadding) {
    paddingDiv.style.paddingInlineEnd = paddingDiv.dataset.subiOrigPadding + 'px';
    delete paddingDiv.dataset.subiOrigPadding;
  }
}
// â”€â”€â”€ Chat header stats widget â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let headerStatsMounted = false;

function refreshHeaderStats() {
  const el = document.getElementById('subi-header-stats');
  if (!el) return;
  if (!extAlive()) return;
  chrome.storage.local.get(['credits', 'dailyCredits', 'capReached', 'token'], (r) => {
    if (!r.token) {
      el.innerHTML = `<span class="subi-hs-connect" style="cursor:pointer" onclick="window.open('https://subi.live/dashboard','_blank')">${t('hs_connect')}</span>`;
      return;
    }
    const daily   = r.dailyCredits || 0;
    const credits = r.credits || 0;
    const capped  = r.capReached || daily >= 60;
    el.innerHTML =
      `<span class="subi-hs-daily" style="${capped ? 'color:#e91916' : ''}">${daily} / 60${capped ? ' Â· max' : ''}</span>` +
      `<span class="subi-hs-sep"></span>` +
      `<span class="subi-hs-credits">${credits.toLocaleString()}</span>`;
  });
}

function injectChatHeaderStats() {
  if (headerStatsMounted) return;
  const h4 = document.querySelector('h4[data-test-selector="chat-room-header-label"]');
  if (!h4) return;
  headerStatsMounted = true;

  // Replace the h4's content with the stats widget (keeps the h4 in place)
  h4.innerHTML = '';
  const el = document.createElement('span');
  el.id = 'subi-header-stats';
  h4.appendChild(el);

  refreshHeaderStats();
}

// â”€â”€â”€ DOM helpers (7TV-agnostic) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function findChatMessageList() {
  // 7TV
  return document.querySelector('#seventv-message-container main')
      // Native Twitch
      || document.querySelector('[data-test-selector="chat-scrollable-area__message-container"]')
      || document.querySelector('[data-a-target="chat-scroller"] ul')
      || document.querySelector('.chat-list--default ul');
}

function findChatSection() {
  return document.querySelector('section[data-test-selector="chat-room-component-layout"]');
}

function findChatScroller() {
  // 7TV scroller (fallback)
  return document.querySelector('.seventv-chat-scroller')
      // Native Twitch
      || document.querySelector('.chat-list--default')
      || document.querySelector('[data-a-target="chat-scroller"]');
}

function hasChatPresent() {
  return !!(findChatSection() || findChatMessageList() || findChatScroller());
}

// â”€â”€â”€ Detect stream navigation and reset stale mounted flags â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function checkAndReinject() {
  if (bannerMounted && bannerEl && !document.contains(bannerEl)) {
    teardownBanner();
    bannerMounted = false;
    bannerEl = null;
  }
  if (chatBannerMounted && chatBannerEl && !document.contains(chatBannerEl)) {
    teardownChatBanner();
    chatBannerMounted = false;
    chatBannerEl = null;
  }
  if (chatCardMounted && chatCardEl && !document.contains(chatCardEl)) {
    teardownChatCard();
    chatCardMounted = false;
    chatCardEl = null;
  }
  if (headerStatsMounted && !document.getElementById('subi-header-stats')) {
    headerStatsMounted = false;
  }
  if (chatInputBtnMounted && chatInputBtnEl && !document.contains(chatInputBtnEl)) {
    chatInputBtnMounted = false;
    teardownChatInputButton();
  }
}

// â”€â”€â”€ Chat badges â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Injects Subi member/partner badges next to usernames in Twitch chat.
// Uses element references (not re-queries) to survive Twitch DOM changes.

let _badgeTooltip = null;

function injectBadgeStyles() {
  if (document.getElementById('subi-badge-styles')) return;
  const style = document.createElement('style');
  style.id = 'subi-badge-styles';
  style.textContent = `
    .subi-badge-wrap { cursor: default; flex-shrink: 0; }
    .subi-badge-tooltip {
      position: fixed;
      background: #1f1f23;
      color: #efeff1;
      border-radius: 6px;
      padding: 10px 14px;
      display: flex;
      align-items: center;
      gap: 10px;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.12s;
      z-index: 99999;
      box-shadow: 0 4px 16px rgba(0,0,0,0.5);
      font-family: Inter, Roobert, "Helvetica Neue", sans-serif;
      font-size: 13px;
      font-weight: 600;
      white-space: nowrap;
    }
    .subi-badge-tooltip.visible { opacity: 1; }
    .subi-badge-tooltip img { height: 36px; width: auto; }
  `;
  document.head.appendChild(style);

  // Single shared tooltip element
  _badgeTooltip = document.createElement('div');
  _badgeTooltip.className = 'subi-badge-tooltip';
  document.body.appendChild(_badgeTooltip);
}

function showBadgeTooltip(wrap, imageUrl, label) {
  if (!_badgeTooltip) return;
  _badgeTooltip.innerHTML = '';
  const img = document.createElement('img');
  img.src = imageUrl;
  _badgeTooltip.appendChild(img);
  const txt = document.createElement('span');
  txt.textContent = label;
  _badgeTooltip.appendChild(txt);

  const rect = wrap.getBoundingClientRect();
  _badgeTooltip.style.left = `${rect.left + rect.width / 2}px`;
  _badgeTooltip.style.top  = `${rect.top - 8}px`;
  _badgeTooltip.style.transform = 'translate(-50%, -100%)';
  _badgeTooltip.classList.add('visible');
}

function hideBadgeTooltip() {
  _badgeTooltip?.classList.remove('visible');
}

// badge = { slug, name, image_url } from BADGE_MAP
function makeBadgeEl(badge) {
  injectBadgeStyles();

  const imageUrl = badge.image_url.startsWith('http')
    ? badge.image_url
    : `${API}${badge.image_url}`;

  const img = document.createElement('img');
  img.src = imageUrl;
  img.alt = badge.name;
  img.setAttribute('class', 'subi-badge');
  img.setAttribute('data-badge', badge.slug);
  img.style.cssText = 'height:18px;width:auto;display:inline-block;vertical-align:middle;flex-shrink:0;';

  const wrap = document.createElement('span');
  wrap.setAttribute('class', 'subi-badge-wrap');
  wrap.style.cssText = 'margin-left:.25em;';
  wrap.appendChild(img);

  wrap.addEventListener('mouseenter', () => showBadgeTooltip(wrap, imageUrl, badge.name));
  wrap.addEventListener('mouseleave', hideBadgeTooltip);

  return wrap;
}

// Pre-loaded at boot â€” Map of username â†' { slug, name, image_url, priority }
const BADGE_MAP = new Map();
let   badgesReady  = false;
let   badgeObserver = null;

// Cached current-user info
let MY_USERNAME        = null;
let MY_ACTIVE_BADGE_ID = null;
chrome.storage.local.get(['myTwitchUsername', 'myActiveBadgeId'], (s) => {
  MY_USERNAME        = s.myTwitchUsername  || null;
  MY_ACTIVE_BADGE_ID = s.myActiveBadgeId   || null;
});

// Multiple selectors for Twitch username elements â€” most stable first.
// data-a-user is on the <a>/<span> element itself in current Twitch.
// Fallback to class substring for older / 7TV-patched DOM.
function findNameEls(root) {
  // 7TV completely replaces Twitch chat DOM â€” target its username container
  const by7tv = root.querySelectorAll('.seventv-chat-user-username:not([data-subi-badge])');
  if (by7tv.length) return by7tv;
  // Standard Twitch
  const byTarget = root.querySelectorAll('[data-a-target="chat-message-username"]:not([data-subi-badge])');
  if (byTarget.length) return byTarget;
  const byAttr = root.querySelectorAll('span[data-a-user]:not([data-subi-badge])');
  if (byAttr.length) return byAttr;
  return root.querySelectorAll(
    '[class*="chat-author__display-name"]:not([data-subi-badge]),' +
    '[class*="chatter-name"]:not([data-subi-badge])'
  );
}

function usernameOf(el) {
  return (el.getAttribute('data-a-user') || el.textContent.trim()).toLowerCase() || null;
}

// Returns the badge object for a username, or null
function badgeOf(u) {
  return BADGE_MAP.get(u) || null;
}

function processEl(el) {
  const u = usernameOf(el);
  if (!u) return;
  el.dataset.subiBadge = '1';
  const badge = badgeOf(u);
  if (badge) injectBadgeEl(el, badge);
}

// Instantly re-inject when user switches active badge in popup
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.myTwitchUsername) MY_USERNAME        = changes.myTwitchUsername.newValue  || null;
  if (changes.myActiveBadgeId)  MY_ACTIVE_BADGE_ID = changes.myActiveBadgeId.newValue   || null;
  if (changes.myBadgeAssignment) {
    const a = changes.myBadgeAssignment.newValue;
    if (a && a.username) BADGE_MAP.set(a.username, { slug: a.slug, name: a.name, image_url: a.image_url });
  }

  if (!changes.myActiveBadgeId && !changes.myBadgeAssignment) return;
  if (!MY_USERNAME) return;

  document.querySelectorAll('[data-subi-badge="1"]').forEach(el => {
    if (usernameOf(el) !== MY_USERNAME) return;
    const scope = el.closest('.seventv-chat-user') || el.closest('[class*="chat-line__username-container"]') || el.parentElement;
    scope?.querySelectorAll('.subi-badge-wrap').forEach(w => w.remove());
    delete el.dataset.subiBadge;
    processEl(el);
  });
});

async function loadBadgeList() {
  try {
    const res = await fetch(`${API}/badges/all`);
    if (!res.ok) return;
    const { assignments = [] } = await res.json();
    assignments.forEach(a => BADGE_MAP.set(a.username, { slug: a.slug, name: a.name, image_url: a.image_url }));
  } catch {}
  badgesReady = true;
}

function injectBadgeEl(nameEl, badge) {
  const seventvBadgeList = nameEl.closest('.seventv-chat-user')
                            ?.querySelector('.seventv-chat-user-badge-list');
  const container = nameEl.closest('[class*="chat-line__username-container"]')
                 || nameEl.closest('[class*="username-container"]')
                 || nameEl.parentElement;
  const badgeSpan = seventvBadgeList
                 || container?.querySelector('[class*="chat-line__badges"]')
                 || container?.querySelector('[class*="badges"]');

  if (container?.querySelector(`.subi-badge[data-badge="${badge.slug}"]`)) return;
  const wrap = makeBadgeEl(badge);
  if (badgeSpan) badgeSpan.appendChild(wrap);
  else nameEl.insertAdjacentElement('beforebegin', wrap);
}

const NAME_SELECTORS = [
  '.seventv-chat-user-username',
  '[data-a-target="chat-message-username"]',
  '[class*="chat-author__display-name"]',
  '[class*="chatter-name"]',
].join(',');

async function startBadgeObserver() {
  if (badgeObserver) return;
  await loadBadgeList();

  // Initial scan of already-visible messages
  document.querySelectorAll(`${NAME_SELECTORS}:not([data-subi-badge])`).forEach(processEl);

  // Observe document.body â€” 7TV renders outside Twitch's native chat container
  badgeObserver = new MutationObserver((mutations) => {
    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches(NAME_SELECTORS)) {
          processEl(node);
        } else {
          node.querySelectorAll(`${NAME_SELECTORS}:not([data-subi-badge])`).forEach(processEl);
        }
      }
    }
  });
  badgeObserver.observe(document.body, { childList: true, subtree: true });
}

// â”€â”€â”€ Boot â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function waitForPage() {
  const mo = new MutationObserver(() => {
    // Always check first â€” stream navigation removes our elements silently
    checkAndReinject();

    if (!headerStatsMounted && document.querySelector('h4[data-test-selector="chat-room-header-label"]'))
      injectChatHeaderStats();

    // Badges work on any channel page â€” live or offline
    if (!badgeObserver && hasChatPresent())
      startBadgeObserver();

    if (!isChannelLive()) return;

    if (!bannerMounted && document.getElementById('live-channel-stream-information'))
      setTimeout(injectBanner, 300);

    if (!chatBannerMounted && hasChatPresent())
      setTimeout(injectChatBanner, 500);

    if (!chatCardMounted && hasChatPresent())
      setTimeout(injectChatCard, 700);

    if (!chatInputBtnMounted)
      injectChatInputButton();
  });
  mo.observe(document.body, { childList: true, subtree: true });

  setTimeout(() => {
    if (document.querySelector('h4[data-test-selector="chat-room-header-label"]'))
      injectChatHeaderStats();
  }, 800);
  setTimeout(() => { if (isChannelLive()) injectBanner(); }, 1000);
  setTimeout(() => { if (isChannelLive()) { injectChatBanner(); injectChatCard(); } injectChatInputButton(); }, 2000);
  setTimeout(startBadgeObserver, 800);
}

waitForPage();

// â”€â”€â”€ React to storage changes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
try {
  chrome.storage.onChanged.addListener((changes) => {
    if (!extAlive()) return;
    if (changes.token) {
      const hasToken = !!changes.token.newValue;
      renderBannerContent(hasToken);
      renderChatBannerContent(hasToken);
      renderChatCardContent(hasToken);
      refreshHeaderStats();
    }
    if (changes.credits || changes.dailyCredits || changes.capReached) {
      refreshHeaderStats();
    }
  });
} catch { /* extension already invalidated on script injection */ }
