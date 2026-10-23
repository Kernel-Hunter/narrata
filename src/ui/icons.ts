// Stroke icons drawn on a 24px grid.

const svg = (body: string, extra = '') =>
  `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"${extra}>${body}</svg>`;

export const icons = {
  play: `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path d="M8 5.6v12.8c0 .8.9 1.3 1.6.9l10.2-6.4c.6-.4.6-1.3 0-1.7L9.6 4.8C8.9 4.3 8 4.8 8 5.6Z" fill="currentColor"/></svg>`,
  pause: `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><rect x="6.5" y="5" width="4" height="14" rx="1.3" fill="currentColor"/><rect x="13.5" y="5" width="4" height="14" rx="1.3" fill="currentColor"/></svg>`,
  back: svg('<path d="M11 7 6 12l5 5"/><path d="M18 7l-5 5 5 5"/>'),
  forward: svg('<path d="m13 7 5 5-5 5"/><path d="m6 7 5 5-5 5"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  library: svg('<path d="M5 4.5h3.5v15H5zM10.5 4.5H14v15h-3.5z"/><path d="m16.2 5.4 3.3-.9 3 14.4-3.4.8z" transform="translate(-1.5 0)"/>'),
  type: svg('<path d="M4 18 8.5 6h1L14 18M5.6 14h6.8"/><path d="M15.5 12.2c.6-.9 1.6-1.4 2.8-1.4 1.8 0 2.7 1 2.7 2.7V18m0-3.2c-.7-.4-1.6-.6-2.6-.6-1.6 0-2.7.8-2.7 2 0 1.1.9 1.9 2.2 1.9 1.4 0 2.6-.8 3.1-2"/>'),
  more: svg('<circle cx="5" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="19" cy="12" r="1.2" fill="currentColor"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  volume: svg('<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>'),
  mute: svg('<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="m16 10 4 4m0-4-4 4"/>'),
  chevronDown: svg('<path d="m7 10 5 5 5-5"/>'),
  chevronLeft: svg('<path d="m14 6-6 6 6 6"/>'),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  trash: svg('<path d="M5 7h14M10 7V5h4v2M7 7l1 12.5h8L17 7"/>'),
  download: svg('<path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19.5h14"/>'),
  file: svg('<path d="M7 3.5h7l4 4V20.5H7z"/><path d="M14 3.5v4h4"/>'),
  paste: svg('<path d="M9 4.5h6v3H9z"/><path d="M15 6h2.5v14.5h-11V6H9"/>'),
  sparkle: svg('<path d="M12 4.5c.6 3.6 1.9 4.9 5.5 5.5-3.6.6-4.9 1.9-5.5 5.5-.6-3.6-1.9-4.9-5.5-5.5 3.6-.6 4.9-1.9 5.5-5.5Z"/><path d="M18.5 15.5c.3 1.5.8 2 2.3 2.3-1.5.3-2 .8-2.3 2.3-.3-1.5-.8-2-2.3-2.3 1.5-.3 2-.8 2.3-2.3Z"/>'),
  list: svg('<path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="4.5" cy="6.5" r=".9" fill="currentColor"/><circle cx="4.5" cy="12" r=".9" fill="currentColor"/><circle cx="4.5" cy="17.5" r=".9" fill="currentColor"/>'),
  page: svg('<rect x="5.5" y="3.5" width="13" height="17" rx="1.5"/><path d="M8.5 8h7M8.5 11h7M8.5 14h4"/>'),
  text: svg('<path d="M5 6.5h14M5 10.5h14M5 14.5h14M5 18.5h9"/>'),
  lock: svg('<rect x="5.5" y="10.5" width="13" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>'),
  wifiOff: svg('<path d="M4 4l16 16M8.5 13.5a5 5 0 0 1 4.6-1.4M5 10a10 10 0 0 1 4-2.3m4.3-.2A10 10 0 0 1 19 10"/><circle cx="12" cy="17.5" r=".9" fill="currentColor"/>'),
  speaker: svg('<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4 4 0 0 1 0 6"/>'),
  stop: `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>`,
  spinner: `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false" class="spin"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-width="2.2"/><path d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`,
  keyboard: svg('<rect x="3" y="6.5" width="18" height="11" rx="2"/><path d="M7 10h.01M10 10h.01M13 10h.01M16 10h.01M8 14h8"/>'),
  info: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>'),
};

export const logo = `<svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true" focusable="false"><rect width="32" height="32" rx="9" fill="var(--logo-bg)"/><path d="M9 21.5V11.2c0-.9 1-1.4 1.7-.9l6.6 4.9" fill="none" stroke="var(--logo-fg)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M17.5 21.5v-5.2M21 21.5v-9M24.5 21.5v-3.8" fill="none" stroke="var(--logo-accent)" stroke-width="2.4" stroke-linecap="round"/></svg>`;
