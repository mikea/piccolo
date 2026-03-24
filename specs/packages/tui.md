# `@mariozechner/pi-tui` — Specification

**Package:** `packages/tui/`  
**npm name:** `@mariozechner/pi-tui`  
**Version:** lockstep with monorepo  
**Runtime:** Node.js ≥ 20, ESM only  
**Entry point:** `dist/index.js` (single export, no subpaths)

---

## Purpose

Terminal UI framework with differential rendering. Provides a component model, a rendering pipeline that only writes changed lines, keyboard input handling (including Kitty keyboard protocol), overlays, and a set of built-in widgets for building full-screen terminal applications.

---

## Key Design Principles

1. **No virtual DOM or component tree diffing** — diff is on final rendered `string[]` output
2. **Strictly line-height-based layout** — no pixel metrics, no flexbox, no absolute positioning for base content
3. **Single-writer model** — only `TUI.doRender()` writes to the terminal
4. **Synchronized output** (`\x1b[?2026h`/`\x1b[?2026l`) wraps every write batch to prevent tearing
5. **Image lines are opaque** — Kitty/iTerm2 sequences are detected and never modified by the diff/overlay system
6. **Keybinding registry uses declaration merging** — downstream packages augment `interface Keybindings`

---

## Directory Structure

```
src/
├── index.ts               # All public exports
├── tui.ts                 # Component, Container, TUI, overlay system, CURSOR_MARKER
├── terminal.ts            # Terminal interface + ProcessTerminal implementation
├── keys.ts                # Key parsing: matchesKey, parseKey, Key helper
├── keybindings.ts         # KeybindingsManager, default bindings, registry
├── stdin-buffer.ts        # StdinBuffer: splits batched stdin into complete sequences
├── utils.ts               # visibleWidth, wrapTextWithAnsi, truncateToWidth, ANSI helpers
├── terminal-image.ts      # Image protocols (Kitty/iTerm2), capability detection
├── autocomplete.ts        # AutocompleteProvider, CombinedAutocompleteProvider, SlashCommand
├── fuzzy.ts               # fuzzyMatch, fuzzyFilter
├── kill-ring.ts           # KillRing (Emacs-style kill/yank)
├── undo-stack.ts          # UndoStack<S> generic undo/redo
├── editor-component.ts    # EditorComponent interface
└── components/
    ├── box.ts             # Box: padding + background container
    ├── text.ts            # Text: word-wrapped multi-line text
    ├── truncated-text.ts  # TruncatedText: single-line with ellipsis
    ├── spacer.ts          # Spacer: empty line(s)
    ├── loader.ts          # Loader: animated braille spinner
    ├── cancellable-loader.ts  # CancellableLoader: loader with abort
    ├── markdown.ts        # Markdown: full renderer with theme
    ├── select-list.ts     # SelectList: scrollable keyed list
    ├── settings-list.ts   # SettingsList: settings UI with search
    ├── input.ts           # Input: single-line text input
    ├── editor.ts          # Editor: multi-line editor with autocomplete
    └── image.ts           # Image: terminal image component
```

---

## Core Interfaces

### `Component`

```typescript
interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  wantsKeyRelease?: boolean;   // opt-in to Kitty key-release events
  invalidate(): void;          // clear cached render state
}
```

- `render(width)` returns one string per line; each MUST NOT exceed `width` visible columns (enforced by TUI with crash log if violated)
- `handleInput(data)` receives raw terminal byte sequences
- `invalidate()` called on theme change or full redraw; clears cached output

### `Focusable`

```typescript
interface Focusable {
  focused: boolean;
}

function isFocusable(component: Component | null): component is Component & Focusable;
```

Focused components emit `CURSOR_MARKER` (`"\x1b_pi:c\x07"` — an APC sequence) at the cursor position. TUI strips it from the output and positions the hardware cursor there.

### `Container`

```typescript
class Container implements Component {
  children: Component[];

  addChild(component: Component): void;
  removeChild(component: Component): void;
  clear(): void;
  invalidate(): void;    // propagates invalidate() to all children

  render(width: number): string[];  // concatenates children's lines vertically
}
```

`render()` concatenates all children's `string[]` outputs in order — purely vertical stacking.

### `CURSOR_MARKER`

```typescript
const CURSOR_MARKER = "\x1b_pi:c\x07";
```

APC escape sequence. Placed in rendered output at cursor position by focusable components. TUI scans all lines, finds it, strips it, and calls `process.stdout.write(positionCursorSequence)` to place the hardware cursor.

---

## `TUI` Class

```typescript
class TUI extends Container {
  terminal: Terminal;
  onDebug?: () => void;

  constructor(terminal: Terminal, showHardwareCursor?: boolean);

  // Cursor visibility
  getShowHardwareCursor(): boolean;
  setShowHardwareCursor(enabled: boolean): void;

  // Layout
  getClearOnShrink(): boolean;
  setClearOnShrink(enabled: boolean): void;

  // Focus
  setFocus(component: Component | null): void;

  // Overlays
  showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
  hideOverlay(): void;
  hasOverlay(): boolean;

  // Lifecycle
  start(): void;
  stop(): void;

  // Rendering
  requestRender(force?: boolean): void;

  // Input middleware
  addInputListener(listener: InputListener): () => void;   // returns unsubscribe fn
  removeInputListener(listener: InputListener): void;

  invalidate(): void;   // force full redraw on next render

  get fullRedraws(): number;  // cumulative count of full redraws (for debugging)
}
```

### `start()` Sequence

1. Call `terminal.start(onInput, onResize)`
2. Send cell size query `\x1b[16t` if image support detected
3. Buffer input while waiting for cell size response (up to 200ms)
4. Call `requestRender()`

### `stop()` Sequence

1. `hideOverlay()`
2. Hide cursor
3. `terminal.stop()`

### Input Routing (`handleInput(data)`)

```
1. Run through inputListeners chain (middleware):
   each listener can return { consume: true } or { data: newData }
   if consume: stop routing

2. If cellSizeQueryPending: buffer and try parseCellSizeResponse()
   if parsed: setCellDimensions(), invalidate(), clear pending flag

3. Check global shift+ctrl+d debug key → onDebug?.()

4. If has overlay:
   check overlay still visible; if not: hide it
   if overlay has focus: route to overlay's focusedComponent

5. Route to focusedComponent.handleInput(data)
   EXCEPT: filter key-release events unless component.wantsKeyRelease === true

6. requestRender()
```

### Rendering Pipeline (`doRender()`)

```
1. newLines = this.render(terminal.columns)
   (Container.render() concatenates all children)

2. overlayLines = compositeOverlays(newLines, terminal.columns, terminal.rows)

3. cursorPos = findAndStripCursorMarker(overlayLines)
   (scan bottom `height` lines for CURSOR_MARKER, record {row, col}, strip)

4. Append "\x1b[0m\x1b]8;;\x07" after each non-image line
   (prevents ANSI color/hyperlink bleed between lines)

5. Determine full vs partial redraw:
   FULL REDRAW if any of:
     - First render (no previous lines)
     - Terminal width changed
     - Terminal height changed (non-Termux)
     - clearOnShrink && content shrank below maxLinesRendered
     - firstChanged < previousContentViewportTop
     - More than height extra lines to erase
     - requestRender(force=true) was called

6. FULL REDRAW path:
   - If clear: write clearScreen, reset hardwareCursorRow
   - Write all lines from viewportTop
   - Track cursorRow, maxLinesRendered

7. PARTIAL REDRAW path:
   - diff = find firstChanged, lastChanged by string comparison
   - Move cursor from hardwareCursorRow to firstChanged
   - Write only firstChanged..lastChanged lines
   - Erase extra old lines with \x1b[2K + move up

8. positionHardwareCursor(cursorPos) if cursor marker was found

9. Save previousLines, update state tracking vars
```

**State tracking variables:**
- `previousLines: string[]` — last rendered output for diff
- `cursorRow: number` — logical end of content
- `hardwareCursorRow: number` — actual terminal cursor row
- `maxLinesRendered: number` — monotonic high-water mark (never decreases without clear)
- `previousViewportTop: number` = `max(0, maxLinesRendered - terminalRows)`

**Line invariant enforcement:**
```
if visibleWidth(line) > width:
  write crash log to ~/.pi/agent/pi-crash.log
  throw Error(`Line exceeds width: visible=${visibleWidth(line)}, max=${width}`)
```

---

## Overlay System

### `OverlayOptions`

```typescript
type SizeValue = number | `${number}%`;
type OverlayAnchor =
  | "center" | "top-left" | "top-right" | "bottom-left" | "bottom-right"
  | "top-center" | "bottom-center" | "left-center" | "right-center";

interface OverlayMargin {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

interface OverlayOptions {
  width?: SizeValue;          // e.g., 80 or "50%"
  minWidth?: number;
  maxHeight?: SizeValue;
  anchor?: OverlayAnchor;     // default: "center"
  offsetX?: number;
  offsetY?: number;
  row?: SizeValue;            // explicit row (overrides anchor)
  col?: SizeValue;            // explicit col (overrides anchor)
  margin?: OverlayMargin | number;
  visible?: (termWidth: number, termHeight: number) => boolean;
  nonCapturing?: boolean;     // if true: does not capture focus or block input
}
```

### `OverlayHandle`

```typescript
interface OverlayHandle {
  hide(): void;
  setHidden(hidden: boolean): void;
  isHidden(): boolean;
  focus(): void;
  unfocus(): void;
  isFocused(): boolean;
}
```

### Overlay Layout Algorithm (`resolveOverlayLayout`)

```
1. Compute width:
   - if options.width is number: use as-is
   - if percentage: Math.floor(termWidth * pct / 100)
   - apply minWidth constraint
   - cap at termWidth

2. Compute row/col:
   - if options.row and options.col specified: resolve SizeValue to pixels
   - else compute from anchor + offset:
     "center":        row = (termHeight - overlayHeight) / 2, col = (termWidth - width) / 2
     "top-left":      row = margin.top, col = margin.left
     "top-right":     row = margin.top, col = termWidth - width - margin.right
     "bottom-center": row = termHeight - overlayHeight - margin.bottom, col = (termWidth - width) / 2
     etc.

3. Compute maxHeight:
   - if options.maxHeight is number: use as-is
   - if percentage: Math.floor(termHeight * pct / 100)
   - cap at termHeight - row

4. Call overlay.render(width) to get lines, truncate at maxHeight

5. Composite into base content at computed row/col
```

### `compositeLineAt(baseLine, overlayLine, col, baseWidth)`

Splices overlay content into the base line at column position `col`. Uses `extractSegments()` to split the base line into before/after parts, accounting for ANSI escape codes and wide characters.

---

## Terminal Interface

### `Terminal`

```typescript
interface Terminal {
  start(onInput: (data: string) => void, onResize: () => void): void;
  stop(): void;
  drainInput(maxMs?: number, idleMs?: number): Promise<void>;
  write(data: string): void;
  get columns(): number;
  get rows(): number;
  get kittyProtocolActive(): boolean;
  moveBy(lines: number): void;
  hideCursor(): void;
  showCursor(): void;
  clearLine(): void;
  clearFromCursor(): void;
  clearScreen(): void;
  setTitle(title: string): void;
}
```

### `ProcessTerminal`

```typescript
class ProcessTerminal implements Terminal {
  constructor();
}
```

**`start()` sequence:**
1. `process.stdin.setRawMode(true)` — suppress echo, immediate character delivery
2. Enable bracketed paste: `\x1b[?2004h`
3. On Windows: call `SetConsoleMode` via `koffi` (optional) to add `ENABLE_VIRTUAL_TERMINAL_INPUT` (0x0200) for Shift+Tab disambiguation
4. `queryAndEnableKittyProtocol()`:
   - Setup `StdinBuffer` on stdin
   - Send `\x1b[?u` (query current Kitty flags)
   - If response `\x1b[?<flags>u` received within 150ms: enable with `\x1b[>7u` (flags 1+2+4: disambiguate + event types + alternate keys)
   - If no response within 150ms: fall back to `\x1b[>4;2m` (xterm modifyOtherKeys mode 2)

**`stop()` sequence:**
1. `process.stdin.setRawMode(false)`
2. Disable Kitty protocol or modifyOtherKeys
3. Disable bracketed paste: `\x1b[?2004l`
4. Show cursor

---

## Input System

### `StdinBuffer`

Accumulates raw stdin bytes and splits into complete sequences.

```typescript
interface StdinBufferOptions {
  timeout?: number;  // ms to wait for incomplete sequences; default 10ms
}

class StdinBuffer extends EventEmitter<{ data: [string]; paste: [string] }> {
  constructor(options?: StdinBufferOptions);
  process(data: string | Buffer): void;
  flush(): string[];
  clear(): void;
  getBuffer(): string;
  destroy(): void;
}
```

**`extractCompleteSequences()` algorithm:**
- ESC `[` → CSI sequence: accumulate until final byte `0x40–0x7E`
- ESC `]` → OSC: accumulate until BEL (`\x07`) or `ESC \`
- ESC `P` → DCS: accumulate until ST
- ESC `_` → APC: accumulate until ST  ← this is `CURSOR_MARKER` format
- ESC `O` → SS3: accumulate 1 more byte
- Plain bytes: emit immediately
- Bracketed paste: `\x1b[200~` ... `\x1b[201~` → emit `"paste"` event with raw content; `ProcessTerminal` re-wraps: `\x1b[200~${content}\x1b[201~` before passing to TUI
- 10ms timeout: incomplete sequences flushed after idle

### Key Matching (`src/keys.ts`)

#### `matchesKey(data: string, keyId: KeyId): boolean`

Three protocol layers checked in order:

**1. Kitty CSI-u** (`\x1b[<cp>;<mod>[:<event>]u`):
- Parsed by `parseKittySequence()`
- Handles alternate/base layout keys for non-Latin keyboards (Cyrillic, etc.)
- Lock bits (caps/num lock) masked out of modifier
- Event types: 1=press, 2=repeat, 3=release

**2. xterm modifyOtherKeys** (`\x1b[27;<mod>;<cp>~`):
- Parsed by `parseModifyOtherKeysSequence()`
- `mod` bitmask: 1=shift, 2=alt, 4=ctrl, 8=meta

**3. Legacy sequences:**
- Hard-coded escape sequence tables: `LEGACY_KEY_SEQUENCES`, `LEGACY_SHIFT_SEQUENCES`, `LEGACY_CTRL_SEQUENCES`
- Control characters: `\x01`=ctrl+a, `\x02`=ctrl+b, ..., `\x1a`=ctrl+z
- Function keys: `\x1b[15~`=F5, etc.

#### `parseKey(data: string): string | undefined`

Inverse of `matchesKey` — returns canonical `KeyId` for any raw input.

#### `decodeKittyPrintable(data: string): string | undefined`

Extracts printable character from Kitty CSI-u sequence when only shift/lock modifiers present. Used by `Input` and `Editor` to accept Kitty-encoded text.

#### `isKeyRelease(data: string): boolean`

Returns true if Kitty event type is 3 (release).

#### `isKeyRepeat(data: string): boolean`

Returns true if Kitty event type is 2 (repeat).

### `Key` Helper Object

```typescript
const Key = {
  escape: "escape",     esc: "escape",
  enter: "enter",       return: "enter",
  tab: "tab",
  space: "space",
  backspace: "backspace",
  delete: "delete",
  insert: "insert",
  home: "home",         end: "end",
  pageUp: "pageUp",     pageDown: "pageDown",
  up: "up",             down: "down",
  left: "left",         right: "right",
  f1: "f1", f2: "f2",  /* ... */ f12: "f12",
  backtick: "backtick", hyphen: "hyphen", equals: "equals",
  // ... all punctuation/symbol keys

  // Modifier combinators
  ctrl<K extends BaseKey>(key: K): `ctrl+${K}`;
  shift<K extends BaseKey>(key: K): `shift+${K}`;
  alt<K extends BaseKey>(key: K): `alt+${K}`;
  ctrlShift<K extends BaseKey>(key: K): `ctrl+shift+${K}`;
  shiftCtrl<K extends BaseKey>(key: K): `ctrl+shift+${K}`;
  ctrlAlt<K extends BaseKey>(key: K): `ctrl+alt+${K}`;
  altCtrl<K extends BaseKey>(key: K): `ctrl+alt+${K}`;
  shiftAlt<K extends BaseKey>(key: K): `shift+alt+${K}`;
  altShift<K extends BaseKey>(key: K): `shift+alt+${K}`;
  ctrlShiftAlt<K extends BaseKey>(key: K): `ctrl+shift+alt+${K}`;
};
```

---

## Keybinding System

### Declaration Merging

```typescript
// In @mariozechner/pi-tui:
interface Keybindings {
  // TUI built-in bindings defined here
  "tui.select.up": true;
  "tui.select.down": true;
  "tui.select.confirm": true;
  "tui.select.cancel": true;
  // ... etc.
}

// Downstream package (e.g., coding-agent) adds its own:
declare module "@mariozechner/pi-tui" {
  interface Keybindings {
    "app.submit": true;
    "app.interrupt": true;
    // ...
  }
}
```

### Types

```typescript
type Keybinding = keyof Keybindings;
type KeyId = string;  // e.g., "ctrl+enter", "shift+tab", "f1"

interface KeybindingDefinition {
  defaultKeys: KeyId | KeyId[];
  description?: string;
}

type KeybindingDefinitions = Record<string, KeybindingDefinition>;
type KeybindingsConfig = Record<string, KeyId | KeyId[] | undefined>;

interface KeybindingConflict {
  key: KeyId;
  keybindings: string[];
}
```

### `KeybindingsManager`

```typescript
class KeybindingsManager {
  constructor(definitions: KeybindingDefinitions, userBindings?: KeybindingsConfig);

  matches(data: string, keybinding: Keybinding): boolean;
  getKeys(keybinding: Keybinding): KeyId[];
  getDefinition(keybinding: Keybinding): KeybindingDefinition;
  getConflicts(): KeybindingConflict[];
  setUserBindings(userBindings: KeybindingsConfig): void;
  getUserBindings(): KeybindingsConfig;
  getResolvedBindings(): KeybindingsConfig;
}
```

Resolution: user binding for a key overrides default; `undefined` in user binding disables the default.

### Global Registry

```typescript
const TUI_KEYBINDINGS: KeybindingDefinitions;  // default TUI definitions

function setKeybindings(keybindings: KeybindingsManager): void;
function getKeybindings(): KeybindingsManager;
```

---

## Layout System

**No declarative layout engine.** All layout is procedural and line-based:

- **Width propagation:** `TUI.doRender(terminal.columns)` → `Container.render(width)` → each child `component.render(contentWidth)`
- **Height:** determined organically by how many lines `render(width)` returns
- **Padding:** `Box` reduces `contentWidth` by `paddingX * 2`; adds padding lines top/bottom
- **Scrolling:** `Editor` maintains `scrollOffset` and `maxVisibleLines = max(5, floor(rows * 0.3))`
- **Word wrapping:** `wrapTextWithAnsi(text, width)` in utils.ts
- **Overlays:** positioned at explicit `{row, col}` via `resolveOverlayLayout()`

---

## Built-in Components

### `Box` (`components/box.ts`)

```typescript
class Box extends Container {
  constructor(paddingX?: number, paddingY?: number, bgFn?: (text: string) => string);
  setPaddingX(x: number): void;
  setPaddingY(y: number): void;
  setBgFn(fn: (text: string) => string): void;
}
```

Renders children with horizontal/vertical padding. Applies `bgFn` to each line (padding to full `width` first, then wraps with `bgFn`).

### `Text` (`components/text.ts`)

```typescript
class Text implements Component {
  constructor(text?: string, paddingX?: number, paddingY?: number, bgFn?: (text: string) => string);
  setText(text: string): void;
  getText(): string;
  setPaddingX(x: number): void;
  setPaddingY(y: number): void;
  setBgFn(fn: (text: string) => string): void;
  render(width: number): string[];
  invalidate(): void;
}
```

Caches rendered output keyed on `(text, width)`. Invalidated on `invalidate()` call or text/width change.

### `TruncatedText` (`components/truncated-text.ts`)

```typescript
class TruncatedText implements Component {
  constructor(text?: string, paddingX?: number, paddingY?: number, bgFn?: (text: string) => string);
  setText(text: string): void;
  render(width: number): string[];
  invalidate(): void;
}
```

Single visual line. Uses `truncateToWidth(text, width - paddingX*2, "…")`.

### `Spacer` (`components/spacer.ts`)

```typescript
class Spacer implements Component {
  constructor(lines?: number);  // default: 1
  render(width: number): string[];
}
```

Returns N empty strings (`""`).

### `Loader` (`components/loader.ts`)

```typescript
class Loader extends Text {
  constructor(text?: string, paddingX?: number, paddingY?: number);
  start(): void;
  stop(): void;
}
```

Braille spinner frames: `"⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"`. Animates at 80ms interval via `setInterval`, calling `tui.requestRender()` on each frame. Prepends current frame to text.

### `CancellableLoader` (`components/cancellable-loader.ts`)

```typescript
class CancellableLoader extends Loader implements Focusable {
  focused: boolean;
  signal: AbortSignal;
  onAbort?: () => void;

  constructor(text?: string, paddingX?: number, paddingY?: number);
  handleInput(data: string): void;
  // Intercepts tui.select.cancel (escape/ctrl+c) → triggers AbortController
}
```

### `Markdown` (`components/markdown.ts`)

```typescript
interface MarkdownTheme {
  heading: (text: string) => string;
  link: (text: string) => string;
  linkUrl: (text: string) => string;
  code: (text: string) => string;
  codeBlock: (text: string) => string;
  codeBlockBorder: (text: string) => string;
  quote: (text: string) => string;
  quoteBorder: (text: string) => string;
  hr: (text: string) => string;
  listBullet: (text: string) => string;
  bold: (text: string) => string;
  italic: (text: string) => string;
  strikethrough: (text: string) => string;
  underline: (text: string) => string;
  highlightCode?: (code: string, lang?: string) => string[];
  codeBlockIndent?: string;  // default "  "
}

interface DefaultTextStyle {
  color?: (text: string) => string;
  bgColor?: (text: string) => string;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
}

class Markdown implements Component {
  constructor(
    text?: string,
    theme?: MarkdownTheme,
    defaultStyle?: DefaultTextStyle,
    paddingX?: number,
    paddingY?: number,
  );
  setText(text: string): void;
  setTheme(theme: MarkdownTheme): void;
  render(width: number): string[];
  invalidate(): void;
}
```

Uses `marked` lexer for parsing. Supported elements: headings (H1–H6), paragraphs, code blocks (with optional syntax highlighting via `theme.highlightCode`), lists (nested, ordered/unordered), tables (width-aware cell wrapping), blockquotes, horizontal rules, links (inline URL display), bold, italic, strikethrough, underline.

**Underline reset:** Mid-line `\x1b[24m` at word-wrap boundaries to prevent bleed into right-side padding.

### `SelectList<T>` (`components/select-list.ts`)

```typescript
interface SelectListTheme {
  selectedPrefix: (text: string) => string;
  selectedText: (text: string) => string;
  description: (text: string) => string;
  scrollInfo: (text: string) => string;
  noMatch: (text: string) => string;
}

class SelectList<T> implements Component, Focusable {
  focused: boolean;

  constructor(options?: {
    items?: T[];
    renderItem?: (item: T, selected: boolean, width: number) => string;
    onSelect?: (item: T) => void;
    onCancel?: () => void;
    onSelectionChange?: (item: T | undefined) => void;
    truncatePrimary?: (label: string, width: number) => string;
    theme?: SelectListTheme;
    showScrollInfo?: boolean;
  });

  setItems(items: T[]): void;
  getSelectedItem(): T | undefined;
  getSelectedIndex(): number;
  setSelectedIndex(index: number): void;
  handleInput(data: string): void;
  render(width: number): string[];
}
```

Keyboard navigation: up/down to move selection; wraps at ends. Enter/space → `onSelect`. Escape → `onCancel`. Two-column layout: primary label + description.

### `SettingsList` (`components/settings-list.ts`)

```typescript
interface SettingsListTheme {
  label: (text: string, selected: boolean) => string;
  value: (text: string, selected: boolean) => string;
  description: (text: string) => string;
  cursor: string;
  hint: (text: string) => string;
}

interface SettingsListItem {
  key: string;
  label: string;
  value?: string;
  description?: string;
  values?: string[];          // cycled on left/right keys
  submenu?: Component;        // shown when item selected
  onChange?: (value: string) => void;
}

class SettingsList implements Component, Focusable {
  focused: boolean;

  constructor(items: SettingsListItem[], options?: {
    theme?: SettingsListTheme;
    showSearch?: boolean;
  });

  setItems(items: SettingsListItem[]): void;
  handleInput(data: string): void;
  render(width: number): string[];
}
```

Two-column layout. Optional fuzzy search (uses `Input` component). Value cycling via left/right keys. Submenu shown below selected item when activated.

### `Input` (`components/input.ts`)

```typescript
class Input implements Component, Focusable {
  focused: boolean;
  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;
  placeholder?: string;
  borderColor?: (str: string) => string;

  constructor(placeholder?: string);

  getText(): string;
  setText(text: string): void;
  handleInput(data: string): void;
  render(width: number): string[];
  invalidate(): void;
}
```

Single-line. Horizontal scrolling via `sliceByColumn()`. Full Emacs keybinding set (ctrl+a/e/k/u/w/y/backspace/delete, alt+b/f). Kill ring integration. Undo/redo. Cursor via `CURSOR_MARKER`.

### `Editor` (`components/editor.ts`)

```typescript
interface EditorTheme {
  borderColor: (str: string) => string;
  selectList: SelectListTheme;
}

class Editor implements Component, Focusable {
  focused: boolean;
  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;
  borderColor?: (str: string) => string;

  constructor(options?: {
    placeholder?: string;
    theme?: EditorTheme;
    paddingX?: number;
    autocompleteMaxVisible?: number;
  });

  getText(): string;
  setText(text: string): void;
  getExpandedText(): string;  // resolves @file references
  addToHistory(text: string): void;
  insertTextAtCursor(text: string): void;
  setAutocompleteProvider(provider: AutocompleteProvider): void;
  setPaddingX(padding: number): void;
  setAutocompleteMaxVisible(maxVisible: number): void;
  handleInput(data: string): void;
  render(width: number): string[];
  invalidate(): void;
}
```

Multi-line. Visual line map (word-wrap aware cursor movement). Vertical scroll. History (up/down arrows at document boundaries). Autocomplete dropdown (slash commands + `@` file paths). Large paste markers (pastes > 5 lines shown collapsed with line count). Undo/redo. Kill ring.

**Visual-to-logical line mapping:**
```typescript
buildVisualLineMap(width: number): Array<{
  logicalLine: number;   // index in state.lines
  startCol: number;      // starting column in logical line
  length: number;        // characters on this visual line
}>
```

**`maxVisibleLines` calculation:**
```
max(5, floor(terminal.rows * 0.3))
```

### `Image` (`components/image.ts`)

```typescript
interface ImageTheme {
  fallbackColor: (str: string) => string;
}

class Image implements Component {
  constructor(options?: {
    base64Data?: string;
    mimeType?: string;
    imageDimensions?: ImageDimensions;
    maxWidthCells?: number;
    maxHeightCells?: number;
    theme?: ImageTheme;
  });

  setImage(base64Data: string, mimeType: string, dimensions?: ImageDimensions): void;
  getImageId(): number | undefined;
  render(width: number): string[];
  invalidate(): void;
}
```

Renders using Kitty or iTerm2 protocol based on detected terminal capabilities. Caches rendered output keyed on width. Fallback text if no image support.

---

## Image System (`src/terminal-image.ts`)

### Capability Detection

```typescript
type ImageProtocol = "kitty" | "iterm2" | null;

interface TerminalCapabilities {
  images: ImageProtocol;
  trueColor: boolean;
  hyperlinks: boolean;
}

function detectCapabilities(): TerminalCapabilities;
function getCapabilities(): TerminalCapabilities;
function resetCapabilitiesCache(): void;
```

Detection logic:
- `TERM_PROGRAM === "iTerm.app"` or `COLORTERM === "truecolor"` with iTerm markers → `"iterm2"`
- `TERM === "xterm-kitty"` or Kitty protocol query response → `"kitty"`
- Neither → `null`

### Kitty Protocol

```typescript
function encodeKitty(base64Data: string, options?: {
  columns?: number;
  rows?: number;
  imageId?: number;
}): string;

function deleteKittyImage(imageId: number): string;
function deleteAllKittyImages(): string;
function allocateImageId(): number;
```

Kitty image protocol: `\x1b_Ga=T,f=100,t=d,s=W,v=H,c=COLS,r=ROWS,q=1,m=0;<base64>\x1b\\`

### iTerm2 Protocol

```typescript
function encodeITerm2(base64Data: string, options?: {
  width?: string;
  height?: string;
  name?: string;
  preserveAspectRatio?: boolean;
  inline?: boolean;
}): string;
```

iTerm2: `\x1b]1337;File=inline=1;width=Wcells;height=Hcells;preserveAspectRatio=1:<base64>\x07`

### Cell Size Detection

```typescript
interface CellDimensions { widthPx: number; heightPx: number; }

function getCellDimensions(): CellDimensions;
function setCellDimensions(dims: CellDimensions): void;
```

Query: send `\x1b[16t` to terminal. Response: `\x1b[6;H;Wt` (height;width in pixels).

### Image Dimension Extraction

```typescript
interface ImageDimensions { widthPx: number; heightPx: number; }

function getImageDimensions(base64Data: string, mimeType: string): ImageDimensions | null;
function getPngDimensions(base64Data: string): ImageDimensions | null;
function getJpegDimensions(base64Data: string): ImageDimensions | null;
function getGifDimensions(base64Data: string): ImageDimensions | null;
function getWebpDimensions(base64Data: string): ImageDimensions | null;
```

Reads image header bytes to extract dimensions without full decode.

### Row Calculation

```typescript
function calculateImageRows(
  imageDimensions: ImageDimensions,
  targetWidthCells: number,
  cellDimensions?: CellDimensions,
): number;
```

```
aspectRatio = imageDimensions.widthPx / imageDimensions.heightPx
targetWidthPx = targetWidthCells * cellDimensions.widthPx
targetHeightPx = targetWidthPx / aspectRatio
rows = Math.ceil(targetHeightPx / cellDimensions.heightPx)
```

### `isImageLine(line: string): boolean`

Returns true if line contains `\x1b_G` (Kitty) or `\x1b]1337;File=` (iTerm2) sequences.

---

## Autocomplete System

### `AutocompleteItem`

```typescript
interface AutocompleteItem {
  value: string;
  label: string;
  description?: string;
}
```

### `SlashCommand`

```typescript
interface SlashCommand {
  name: string;
  description?: string;
  getArgumentCompletions?(argumentPrefix: string): AutocompleteItem[] | null;
}
```

### `AutocompleteProvider`

```typescript
interface AutocompleteProvider {
  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): { items: AutocompleteItem[]; prefix: string } | null;

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number };
}
```

### `CombinedAutocompleteProvider`

```typescript
class CombinedAutocompleteProvider implements AutocompleteProvider {
  constructor(
    commands?: (SlashCommand | AutocompleteItem)[],
    basePath?: string,   // for file path completion
    fdPath?: string | null,  // path to fd binary; null to disable file completion
  );

  getSuggestions(...): { items: AutocompleteItem[]; prefix: string } | null;
  applyCompletion(...): { lines; cursorLine; cursorCol };

  // Force file suggestions regardless of cursor context
  getForceFileSuggestions(lines, cursorLine, cursorCol): { items; prefix } | null;

  // Check if cursor is in a context that should trigger file completion
  shouldTriggerFileCompletion(lines, cursorLine, cursorCol): boolean;
}
```

Trigger contexts:
- `/` at start of line → slash commands
- `@` anywhere → file path completion via `fd` or Node `glob` fallback

---

## Utility Functions (`src/utils.ts`)

```typescript
// ANSI-aware visible character count (handles wide chars, emoji, sequences)
function visibleWidth(str: string): number;

// Truncate to maxWidth visible chars; optionally pad to maxWidth; optionally add ellipsis
function truncateToWidth(text: string, maxWidth: number, ellipsis?: string, pad?: boolean): string;

// Word-wrap ANSI-decorated text to width; returns array of visual lines
function wrapTextWithAnsi(text: string, width: number): string[];

// Extract substring by column range (handles wide chars + ANSI)
function sliceByColumn(line: string, startCol: number, length: number, strict?: boolean): string;

// Like sliceByColumn but also returns actual width of extracted text
function sliceWithWidth(line: string, startCol: number, length: number, strict?: boolean): { text: string; width: number };

// Extract segments: before col, and after col+length
function extractSegments(
  line: string,
  beforeEnd: number,
  afterStart: number,
  afterLen: number,
  strictAfter?: boolean,
): { before: string; beforeWidth: number; after: string; afterWidth: number };

// Extract ANSI escape code at position pos in str
function extractAnsiCode(str: string, pos: number): { code: string; length: number } | null;

// Apply background color fn to each visible position in a line
function applyBackgroundToLine(line: string, width: number, bgFn: (text: string) => string): string;

function isWhitespaceChar(char: string): boolean;
function isPunctuationChar(char: string): boolean;
```

---

## Fuzzy Matching (`src/fuzzy.ts`)

```typescript
interface FuzzyMatch {
  matches: boolean;
  score: number;  // higher = better match
}

// Check if all chars of query appear in text in order
function fuzzyMatch(query: string, text: string): FuzzyMatch;

// Filter array keeping only items where getText(item) fuzzy-matches query
// Sorted by score descending
function fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string): T[];
```

### Score algorithm

```
score = 0
qi = 0  // query index
ti = 0  // text index

for each char in text:
  if char matches query[qi]:
    score += (ti === qi ? 10 : 1)  // bonus for sequential/positional match
    qi++
    if qi === query.length: matches = true; break
  ti++
```

---

## Kill Ring (`src/kill-ring.ts`)

Emacs-style cut/paste buffer.

```typescript
class KillRing {
  kill(text: string): void;      // add text to ring (append if last op was kill)
  yank(): string | undefined;    // retrieve most recent killed text
  yankPop(): string | undefined; // cycle through kill ring
  clear(): void;
}
```

---

## Undo Stack (`src/undo-stack.ts`)

```typescript
class UndoStack<S> {
  constructor(initialState: S, maxSize?: number);
  push(state: S): void;
  undo(): S | undefined;
  redo(): S | undefined;
  peek(): S;
  clear(): void;
}
```

Uses `structuredClone()` to deep-copy states on push.

---

## `EditorComponent` Interface (`src/editor-component.ts`)

```typescript
interface EditorComponent extends Component {
  getText(): string;
  setText(text: string): void;
  handleInput(data: string): void;
  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;
  addToHistory?(text: string): void;
  insertTextAtCursor?(text: string): void;
  getExpandedText?(): string;
  setAutocompleteProvider?(provider: AutocompleteProvider): void;
  borderColor?: (str: string) => string;
  setPaddingX?(padding: number): void;
  setAutocompleteMaxVisible?(maxVisible: number): void;
}
```

Implemented by `Editor`. Used as the extension point for custom editor implementations in `pi-coding-agent`.
