/**
 * LocalSound Icon System — static Lucide states using persistent SVG paths
 *
 * Strategy:
 *  - Static icons (SkipBack, SkipForward, sidebar, auth): rendered once as SVG.
 *  - Morph icons (Play↔Pause, Volume2↔VolumeX, Repeat↔Repeat1):
 *      * Persistent <svg> + <path> elements in HTML.
 *      * createMorph(pathEl, initialIcon) creates a controller per path.
 *      * On state change → controller.set(targetIcon) updates immediately.
 *      * DOM is never replaced after init; no morph animation is applied.
 *  - Shuffle: static Shuffle icon, toggle driven by CSS class only.
 *  - Repeat vs Repeat1: switch immediately. Shuffle is a separate static icon.
 */

import {
  Play, Pause,
  SkipBack, SkipForward,
  Volume2, VolumeX,
  Repeat, Repeat1,
  Shuffle,
  Clock, Zap, RefreshCcw, Info,
  Database, StickyNote,
  Upload, LogOut, LogIn,
  Music, MicVocal, Guitar, ClefTreble, ClefBass, Music2, Music3, Music4
} from 'https://esm.sh/lucide@latest';

import { createMorph } from 'https://esm.sh/morphicons@latest/dom';

// ─── SVG namespace ────────────────────────────────────────────────────────────
const NS = 'http://www.w3.org/2000/svg';

// ─── Static icon renderer ─────────────────────────────────────────────────────
/**
 * Render a Lucide IconNode as a static SVG into `container`.
 * Lucide exports: Array<[tagName, attrs]>
 */
function renderIcon(container, iconNode, { size = 16, color = 'currentColor', strokeWidth = '2', fill = 'none' } = {}) {
  if (!container || !Array.isArray(iconNode)) return;

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', fill);
  svg.setAttribute('stroke', color);
  svg.setAttribute('stroke-width', String(strokeWidth));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.display = 'block';

  iconNode.forEach(([tag, attrs]) => {
    const el = document.createElementNS(NS, tag);
    Object.entries(attrs || {}).forEach(([k, v]) => el.setAttribute(k, String(v)));
    svg.appendChild(el);
  });

  container.replaceChildren(svg);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function initIcons() {
  // ── Static: SkipBack / SkipForward ───────────────────────────────────────
  renderIcon(document.getElementById('prev-icon-container'), SkipBack, { size: 20 });
  renderIcon(document.getElementById('next-icon-container'), SkipForward, { size: 20 });

  // ── Static: Sidebar admin buttons ────────────────────────────────────────
  renderIcon(document.getElementById('sidebar-database-icon'), Database, { size: 15 });
  renderIcon(document.getElementById('sidebar-notes-icon'), StickyNote, { size: 15 });

  // ── Static: Auth buttons ─────────────────────────────────────────────────
  renderIcon(document.getElementById('login-icon-container'), LogIn, { size: 14 });
  renderIcon(document.getElementById('upload-icon-container'), Upload, { size: 14 });
  renderIcon(document.getElementById('logout-icon-container'), LogOut, { size: 14 });

  // ── Static: Header controls ──────────────────────────────────────────────
  renderIcon(document.getElementById('timer-icon-container'), Clock, { size: 20 });
  renderIcon(document.getElementById('shortcut-icon-container'), Zap, { size: 20 });
  renderIcon(document.getElementById('refresh-icon-container'), RefreshCcw, { size: 20 });
  // ── Static: Mobile settings modal icons ──────────────────────────────────
  renderIcon(document.getElementById('mobile-refresh-icon-container'), RefreshCcw, { size: 20 });
  renderIcon(document.getElementById('mobile-info-icon-container'), Info, { size: 20 });

  // ── Static: Shuffle icon (inside mode-icon-container) ────────────────────
  renderIcon(document.getElementById('mode-shuffle-icon'), Shuffle, { size: 18 });

  // ── White music symbols floating over the audio visualizer ───────────────
  const visualizerMusicIcons = {
    music: Music,
    'mic-vocal': MicVocal,
    guitar: Guitar,
    'clef-treble': ClefTreble,
    'clef-bass': ClefBass,
    'music-2': Music2,
    'music-3': Music3,
    'music-4': Music4
  };
  Object.entries(visualizerMusicIcons).forEach(([name, iconNode]) => {
    const container = document.querySelector(`[data-visualizer-icon="${name}"]`);
    renderIcon(container, iconNode, { size: 24, color: '#ffffff', strokeWidth: 1.8 });
  });

  // ── Morph Controllers ────────────────────────────────────────────────────
  const ppPath = document.getElementById('pp-path');
  const miniPpPath = document.getElementById('mini-pp-path');
  const volPath = document.getElementById('vol-path');
  const modePath = document.getElementById('mode-path');

  const ppMorph = ppPath ? createMorph(ppPath, Play) : null;
  const miniPpMorph = miniPpPath ? createMorph(miniPpPath, Play) : null;
  const volMorph = volPath ? createMorph(volPath, Volume2) : null;
  const modeMorph = modePath ? createMorph(modePath, Repeat) : null;

  // Initial instant sync
  if (ppMorph) ppMorph.set(Play);
  if (miniPpMorph) miniPpMorph.set(Play);
  if (volMorph) volMorph.set(Volume2);
  if (modeMorph) modeMorph.set(Repeat);

  // ── Public API (called by app.js whenever state changes) ──────────────────
  window.LocalSoundIcons = {
    /** Sync Play/Pause icon to playback state without animation. */
    setPlaying(playing) {
      const target = playing ? Pause : Play;
      if (ppMorph) ppMorph.set(target);
      if (miniPpMorph) miniPpMorph.set(target);
    },

    /** Sync Volume icon to muted state or 0 volume. */
    setMuted(muted) {
      const target = muted ? VolumeX : Volume2;
      if (volMorph) volMorph.set(target);
    },

    /**
     * Sync loop mode button icon.
     * off/sequential → Repeat (only sequential keeps its state class)
     * one        → Repeat1
     * shuffle    → show shuffle static icon; hide repeat morph SVG
     */
    setLoopMode(mode) {
      const btn = document.getElementById('mode-cycle-btn');
      const repeatSvg = document.getElementById('mode-repeat-svg');
      const shuffleIcon = document.getElementById('mode-shuffle-icon');

      if (mode === 'shuffle') {
        if (repeatSvg) repeatSvg.style.display = 'none';
        if (shuffleIcon) shuffleIcon.style.display = 'inline-flex';
        if (btn) {
          btn.classList.remove('mode-one', 'mode-sequential');
          btn.classList.add('mode-shuffle');
        }
      } else {
        if (repeatSvg) repeatSvg.style.display = 'inline-flex';
        if (shuffleIcon) shuffleIcon.style.display = 'none';
        if (btn) btn.classList.remove('mode-shuffle');

        if (mode === 'one') {
          if (modeMorph) modeMorph.set(Repeat1);
          if (btn) {
            btn.classList.add('mode-one');
            btn.classList.remove('mode-sequential');
          }
        } else {
          if (modeMorph) modeMorph.set(Repeat);
          if (btn) {
            btn.classList.remove('mode-one', 'mode-sequential');
            if (mode === 'sequential') btn.classList.add('mode-sequential');
          }
        }
      }
    }
  };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initIcons);
} else {
  initIcons();
}
