/**
 * SVG-иконки «Ветвей» — точный порт ICONS/EXTRA_ICONS из vetvi33.html.
 */

const ICONS: Record<string, string> = {
  scene:
    '<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18M8 6l-2 4M13 6l-2 4M18 6l-2 4"/>',
  char: '<circle cx="12" cy="8.2" r="3.6"/><path d="M4.8 20c1.1-3.4 3.9-5.2 7.2-5.2s6.1 1.8 7.2 5.2"/>',
  quest:
    '<path d="M6 3v18"/><path d="M6 4.5h11l-2.6 3.7 2.6 3.8H6"/>',
  dialog:
    '<path d="M4 5.5h16v10.5h-9.5L6 20v-4H4z"/><path d="M8 9.5h8M8 12.3h5"/>',
  skill: '<path d="M13 2 5.5 13H11l-1.2 9L18 10.5h-5.5z"/>',
  branch:
    '<circle cx="5" cy="12" r="2.3"/><circle cx="19" cy="5" r="2.3"/><circle cx="19" cy="19" r="2.3"/><path d="M7.3 12h3.2c2.6 0 2.9-7 6.2-7M10.5 12c2.6 0 2.9 7 6.2 7"/>',
  event:
    '<path d="M12 3v3.5M12 17.5V21M3 12h3.5M17.5 12H21M6 6l2.4 2.4M15.6 15.6 18 18M18 6l-2.4 2.4M8.4 15.6 6 18"/>',
  note: '<path d="M6.5 3h11v18l-2.8-2-2.7 2-2.7-2L6.5 21z"/><path d="M9.5 8.5h5M9.5 12h5"/>',
  folder:
    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  chev: '<path d="m6 9 6 6 6-6"/>',
  chevUp: '<path d="m6 15 6-6 6 6"/>',
  expand:
    '<path d="M9 9 4 4m0 0v4M4 4h4M15 9l5-5m0 0v4M20 4h-4M9 15l-5 5m0 0v-4M4 20h4M15 15l5 5m0 0v-4M20 20h-4"/>',
  trash:
    '<path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13M10 11v5M14 11v5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  swap: '<path d="M4 8h13M14 4.5 17.5 8 14 11.5M20 16H7M10 12.5 6.5 16l3.5 3.5"/>',
  target: '<circle cx="12" cy="12" r="7"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
  pencil:
    '<path d="m4 20 1-4L16.3 4.7a2.1 2.1 0 0 1 3 3L8 19z"/><path d="M14.5 6.5l3 3"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  eye: '<path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  eyeOff:
    '<path d="M2.5 12S6 5.8 12 5.8c1.2 0 2.3.3 3.3.7M21.5 12S18 18.2 12 18.2c-1.2 0-2.3-.3-3.3-.7"/><path d="M4 4l16 16"/>',
  alignH:
    '<path d="M2 12h20"/><rect x="4" y="8" width="4" height="8" rx="1"/><rect x="10" y="8" width="4" height="8" rx="1"/><rect x="16" y="8" width="4" height="8" rx="1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
}

const EXTRA_ICONS: Record<string, string> = {
  sword: '<path d="M19.5 4.5 9 15"/><path d="M19.5 4.5l-4 .7M19.5 4.5l-.7 4"/><path d="M6.5 13.5l4 4"/><path d="M4.5 19.5l3-3"/>',
  shield: '<path d="M12 3l7 3v5.5c0 4.8-3.4 7.7-7 9.5-3.6-1.8-7-4.7-7-9.5V6z"/>',
  bow: '<path d="M5 19C5 11 11 5 19 5"/><path d="M5 19 19 5"/><path d="M12 12l7-7m0 0h-3.5M19 5v3.5"/>',
  potion:
    '<path d="M9.5 3h5"/><path d="M11 3v4.2L6.6 14a4.8 4.8 0 0 0 4.2 7h2.4a4.8 4.8 0 0 0 4.2-7L13 7.2V3"/><path d="M8.5 15.5h7"/>',
  key: '<circle cx="8" cy="8" r="4.5"/><path d="M11.3 11.3 20 20"/><path d="M16.5 16.5v3M20 20h-3"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/><path d="M12 14.5v2"/>',
  chest:
    '<path d="M4 10a2.5 2.5 0 0 1 2.5-2.5h11A2.5 2.5 0 0 1 20 10v8H4z"/><path d="M4 13h16"/><path d="M10.5 12h3v3h-3z"/>',
  coin: '<circle cx="12" cy="12" r="8"/><path d="M9.5 14.5c.4 1 5 1.2 5.3-.6.3-2-5.3-1-5-3 .3-1.7 4.3-1.6 4.9-.3"/>',
  gem: '<path d="M7 3.5h10l3.5 5.5L12 20.5 3.5 9z"/><path d="M3.5 9h17"/><path d="M9.5 9 12 20.5 14.5 9"/><path d="M7 3.5 9.5 9 12 3.5 14.5 9 17 3.5"/>',
  ring: '<circle cx="12" cy="14.5" r="5.5"/><path d="M9.8 5.8 12 3l2.2 2.8L12 8.5z"/>',
  skull:
    '<path d="M12 3a7 7 0 0 0-7 7c0 2.3.9 3.9 2.5 5.3V18a2 2 0 0 0 2 2h5a2 2 0 0 0 2-2v-2.7C18.1 13.9 19 12.3 19 10a7 7 0 0 0-7-7z"/><circle cx="9.3" cy="10.8" r="1.3"/><circle cx="14.7" cy="10.8" r="1.3"/><path d="M10.8 17v1.5M13.2 17v1.5"/>',
  crown: '<path d="M3.5 7.5 8 11l4-6.5L16 11l4.5-3.5L19 17H5z"/><path d="M5 20h14"/>',
  castle:
    '<path d="M4 21V7h3V4.5h2.5V7h5V4.5H17V7h3v14"/><path d="M2.5 21h19"/><path d="M10 21v-3.5a2 2 0 0 1 4 0V21"/>',
  tower:
    '<path d="M9 21V7h6v14"/><path d="M9 7 7.5 3.5h9L15 7"/><path d="M12 11v2.5"/><path d="M6 21h12"/>',
  house: '<path d="M4 11.5 12 4.5l8 7"/><path d="M6 10v10h12V10"/><path d="M10 20v-5h4v5"/>',
  mountain:
    '<path d="M3 19 10 6.5l4 7 2.5-3.5L21 19z"/><path d="M8.6 9.5 10 12l1.4-2.5"/>',
  tree: '<path d="M12 3 6.5 10.5h3L5 17h14l-4.5-6.5h3z"/><path d="M12 17v4"/>',
  map: '<path d="M9 4.5 3.5 6.5v13L9 17.5l6 2 5.5-2v-13L15 6.5z"/><path d="M9 4.5v13M15 6.5v13"/>',
  compass:
    '<circle cx="12" cy="12" r="8.5"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
  scroll:
    '<path d="M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7"/><path d="M7 3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2"/><path d="M10 8h6M10 12h6M10 16h4"/>',
  book: '<path d="M5 20V5.5A1.5 1.5 0 0 1 6.5 4H19v14H6.5A1.5 1.5 0 0 0 5 19.5z"/><path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3"/>',
  letter:
    '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="m3.5 7.5 8.5 6 8.5-6"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  hourglass:
    '<path d="M6.5 3.5h11M6.5 20.5h11"/><path d="M8 3.5V7l4 4 4-4V3.5M8 20.5V17l4-4 4 4v3.5"/>',
  moon: '<path d="M19.5 14A8 8 0 0 1 10 4.5 8 8 0 1 0 19.5 14z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/>',
  star: '<path d="m12 3.5 2.5 5.2 5.7.8-4.1 4 1 5.7L12 16.5l-5.1 2.7 1-5.7-4.1-4 5.7-.8z"/>',
  flame:
    '<path d="M12 21a6 6 0 0 1-6-6c0-3.5 2.5-5.5 3.8-7.8C10.5 6 11 4.5 11 3c3.2 2.2 7 6 7 10.5a6 6 0 0 1-6 6z"/><path d="M12 21c-1.8 0-3-1.3-3-3 0-1.8 1.8-2.8 3-4.5 1.2 1.7 3 2.7 3 4.5s-1.2 3-3 3z"/>',
  drop: '<path d="M12 3.5S6 10 6 14.5a6 6 0 0 0 12 0C18 10 12 3.5 12 3.5z"/>',
  snow: '<path d="M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9"/><path d="m12 3-1.8 2M12 3l1.8 2M12 21l-1.8-2M12 21l1.8-2"/>',
  wind: '<path d="M3.5 8h8a2.5 2.5 0 1 0-2.4-3.2"/><path d="M3.5 12h13a2.5 2.5 0 1 1-2.4 3.2"/><path d="M3.5 16h6"/>',
  heart:
    '<path d="M12 20.5S4.5 15.7 4.5 10.3A4.3 4.3 0 0 1 12 7a4.3 4.3 0 0 1 7.5 3.3c0 5.4-7.5 10.2-7.5 10.2z"/>',
  mask: '<path d="M4.5 4.5h15v6.5a7.5 7.5 0 0 1-15 0z"/><path d="M8.5 9.5h.01M15.5 9.5h.01"/><path d="M9 13.5c1.8 1.6 4.2 1.6 6 0"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8.5 8.5h.01M15.5 8.5h.01M12 12h.01M8.5 15.5h.01M15.5 15.5h.01" stroke-width="2.6"/>',
  puzzle:
    '<path d="M9.5 3.5a2 2 0 1 1 4 0H17a2 2 0 0 1 2 2v3.5a2 2 0 1 0 0 4V17a2 2 0 0 1-2 2h-3.5a2 2 0 1 0-4 0H6a2 2 0 0 1-2-2v-3.5a2 2 0 1 1 0-4V5.5a2 2 0 0 1 2-2z"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.7M12 18.5v2.7M2.8 12h2.7M18.5 12h2.7M5.5 5.5l1.9 1.9M16.6 16.6l1.9 1.9M18.5 5.5l-1.9 1.9M7.4 16.6l-1.9 1.9"/>',
  hammer:
    '<path d="m13.5 3.5 7 7-2.5 2.5-7-7z"/><path d="M11.5 8.5 3.5 16.5 7 20l8-8"/>',
  anchor:
    '<circle cx="12" cy="5" r="2.4"/><path d="M12 7.4V21"/><path d="M12 21a8 8 0 0 1-7.7-6l2.7 1.1M12 21a8 8 0 0 0 7.7-6l-2.7 1.1"/><path d="M8.5 11h7"/>',
  ship: '<path d="M3.5 15.5h17L18 20H6z"/><path d="M12 3.5V15"/><path d="M12 4.5l6 8.5H12z"/>',
  paw: '<circle cx="7" cy="8.5" r="1.7"/><circle cx="12" cy="6.5" r="1.7"/><circle cx="17" cy="8.5" r="1.7"/><path d="M12 11.5c-3 0-5.5 2.6-5.5 5a2.8 2.8 0 0 0 2.8 2.8c1 0 1.8-.4 2.7-.4s1.7.4 2.7.4a2.8 2.8 0 0 0 2.8-2.8c0-2.4-2.5-5-5.5-5z"/>',
  ghost:
    '<path d="M5 11a7 7 0 0 1 14 0v9.5l-2.3-2-2.4 2-2.3-2-2.3 2-2.4-2L5 20.5z"/><path d="M9.5 10.5h.01M14.5 10.5h.01" stroke-width="2.4"/>',
  trophy:
    '<path d="M7.5 4h9v5a4.5 4.5 0 0 1-9 0z"/><path d="M7.5 5.5H4.5c0 3 1.4 4.6 3.4 5M16.5 5.5h3c0 3-1.4 4.6-3.4 5"/><path d="M12 13.5V17"/><path d="M8 20.5h8M9.5 17h5l.7 3.5H8.8z"/>',
  bomb: '<circle cx="10.5" cy="13.5" r="6.5"/><path d="M15 9l3.5-3.5"/><path d="M18.5 5.5l.4-2M18.5 5.5l2.1-.6M18.5 5.5l1.5 1.6"/>',
  portal:
    '<ellipse cx="12" cy="11" rx="5.5" ry="8"/><ellipse cx="12" cy="11" rx="2.3" ry="4.2"/><path d="M5 21h14"/>',
  crystal:
    '<path d="M12 2.5 16 8l-4 13.5L8 8z"/><path d="M8 8h8"/><path d="M12 2.5V8"/>',
  wand: '<path d="M3.5 20.5 14 10"/><path d="m15.5 3.5.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9z"/><path d="m19.5 12 .5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5z"/>',
  bag: '<path d="M6 8h12l1.2 12H4.8z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>',
  door: '<path d="M6.5 21V9.5a5.5 5.5 0 0 1 11 0V21"/><path d="M4 21h16"/><path d="M14.5 13h.01" stroke-width="2.4"/>',
  candle:
    '<path d="M9 11.5h6V20H9z"/><path d="M12 11.5V9"/><path d="M12 2.5c1 1.2 1.6 2.1 1.6 3.1A1.6 1.6 0 0 1 12 7.2a1.6 1.6 0 0 1-1.6-1.6c0-1 .6-1.9 1.6-3.1z"/><path d="M6.5 20h11"/>',
}

export const ALLICONS: Record<string, string> = { ...ICONS, ...EXTRA_ICONS }
export const BASE_ICON_KEYS = Object.keys(ICONS)
export const EXTRA_ICON_KEYS = Object.keys(EXTRA_ICONS)

/** React-версия ic(): возвращает JSX-safe данные для <Icon name size/>. */
export function iconPath(name: string): string {
  return ALLICONS[name] || ALLICONS.star
}
