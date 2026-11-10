## Enhancing Web UI/UX

The page (`index.html`) is responsive, accessible and themeable. It works on
desktop and mobile browsers (macOS, Windows, Linux, iOS, Android).

### Layout
- Header with the GAP logo (top left) and navigation, in the style of
  www.gap-system.org.
- On wide screens the terminal sits beside a Files and Examples side panel,
  and the terminal stretches to the full height of that row.
- On phones and narrow windows the layout is a single column. The Files and
  Examples panels start collapsed, the navigation wraps onto a second line,
  and safe-area insets keep content clear of notches.
- Touch-sized controls (at least 44 px) throughout.

### Theme
- A "Theme" button in the header cycles Auto, Light and Dark.
- Auto follows the system setting. The choice is stored in `localStorage`
  under `gap-theme` and applied before first paint, so there is no flash.
- The terminal stays dark in every theme.

### Mobile input
- On touch devices and narrow windows, an on-screen key bar under the
  terminal provides Enter, Tab and the arrow keys. The arrows step through
  command history.
- It sends key events to the terminal's hidden input field, so the phone
  keyboard stays open. It is hidden on devices with a physical keyboard.

### Accessibility
- Landmarks (header, nav, main, aside, footer) and a "skip to terminal" link.
- The loading notice and the SharedArrayBuffer error are announced by screen
  readers; theme changes are announced too.
- Visible keyboard focus, labelled controls and toolbar, forced-colors
  (Windows High Contrast) support, and reduced-motion support.
- Colours meet contrast requirements in both themes.

### Compatibility
All element IDs used by `gap-ui.js` are unchanged (`restart`, `loading`,
`unsupported`, `terminal`, `terminal-wrap`, `upload-button`, `upload-input`,
`files-empty`, `file-list`, `example-list`, `reset-site`).

### Known limitations
- Terminal font size is set in `gap-ui.js`, not in the HTML. On phones the
  output wraps at about 50 columns.
- For full screen-reader support, enable xterm's `screenReaderMode` in
  `gap-ui.js`.
- If the terminal does not re-fit after a panel is opened or closed,
  `gap-ui.js` needs a `ResizeObserver` (the page also dispatches a window
  `resize` event on panel toggle).

### License and attribution
This project is licensed under the GNU General Public License, version 2 or
(at your option) any later version. See [LICENSE](LICENSE) for the license text
and [COPYRIGHT](COPYRIGHT) for GAP copyright and author information.

This web app is a modified version of **GAP in the browser**, developed by
Chris Jefferson for GAP. This fork includes mobile-first changes. Bundled GAP
packages and other third-party components may have their own license terms;
see the relevant license and copyright files in their directories.
