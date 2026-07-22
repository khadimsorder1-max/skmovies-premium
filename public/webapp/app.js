/* ============================================================================
   SKMovies Mini App — JavaScript
   Same as main app.js but with Telegram WebApp SDK integration.
   ============================================================================ */
(function () {
  'use strict';

  // ─── Telegram WebApp SDK init ──────────────────────────────────────
  const tg = window.Telegram?.WebApp;
  if (tg) {
    tg.ready();
    tg.expand();
    if (tg.enableClosingConfirmation) tg.enableClosingConfirmation();
    // Theme
    if (tg.colorScheme === 'dark') document.documentElement.classList.add('dark-ui');
    tg.onEvent('themeChanged', () => {
      document.documentElement.classList.toggle('dark-ui', tg.colorScheme === 'dark');
    });
    // Back button
    tg.onEvent('backButtonClicked', () => {
      const modal = document.getElementById('modal');
      const sheet = document.getElementById('sheet');
      const settingsSheet = document.getElementById('settingsSheet');
      if (!sheet.hidden) closeSheet();
      else if (!settingsSheet.hidden) settingsSheet.hidden = true;
      else if (!modal.hidden) closeModal();
      else if (tg.exit) tg.exit();
    });
  }

  // Hide splash after TG ready
  setTimeout(() => {
    const splash = document.getElementById('splash');
    if (splash) { splash.classList.add('is-hidden'); setTimeout(() => { splash.style.display = 'none'; }, 400); }
  }, 500);

  // Haptic feedback helper
  function haptic(type = 'light') {
    if (!tg?.HapticFeedback) return;
    try {
      if (['success', 'error', 'warning'].includes(type)) tg.HapticFeedback.notificationOccurred(type);
      else tg.HapticFeedback.impactOccurred(type);
    } catch {}
  }
  function showBackButton(show) {
    if (!tg?.BackButton) return;
    if (show) tg.BackButton.show();
    else tg.BackButton.hide();
  }

  // ─── Now load + run the main app ───────────────────────────────────
  // The main app.js defines the entire SPA. We just add TG-specific hooks here.
  // Override the openMovie function to show back button
  const origOpenMovie = window.__skm?.openMovie;
  if (origOpenMovie) {
    window.__skm.openMovie = function (slug) {
      haptic('light');
      showBackButton(true);
      origOpenMovie(slug);
    };
  }

  // Override closeModal to hide back button
  const origCloseModal = window.__skm?.closeModal;
  if (origCloseModal) {
    window.__skm.closeModal = function () {
      origCloseModal();
      if (document.getElementById('sheet').hidden) showBackButton(false);
    };
  }

  // Settings sheet
  const settingsBtn = document.querySelector('[data-action="settings"]');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      haptic('light');
      const sheet = document.getElementById('settingsSheet');
      const list = document.getElementById('settingsList');
      const esc = (s) => { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; };
      list.innerHTML = `
        <div class="settings-item"><span class="settings-item__label">👤 Telegram user</span><span class="settings-item__value">${esc(tg?.initDataUnsafe?.user?.first_name || 'Not available')}</span></div>
        <div class="settings-item"><span class="settings-item__label">🌐 App version</span><span class="settings-item__value">v3.3.8</span></div>
        <div class="settings-item"><span class="settings-item__label">📱 Theme</span><span class="settings-item__value">${tg?.colorScheme || 'default'}</span></div>
        <div class="settings-item"><span class="settings-item__label">🎬 Source</span><span class="settings-item__value">mlsbd.co (clone)</span></div>
      `;
      sheet.hidden = false;
      showBackButton(true);
    });
  }

  // Close settings
  document.querySelectorAll('[data-close-settings]').forEach((el) => {
    el.addEventListener('click', () => {
      document.getElementById('settingsSheet').hidden = true;
      if (document.getElementById('modal').hidden) showBackButton(false);
    });
  });
})();
