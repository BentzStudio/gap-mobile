// Main-thread logic for the GAP-in-the-browser page: terminal/worker
// lifecycle (including restart), the upload mailbox sender, the files
// panel, the examples menu, and the loading progress notice.
//
// The worker side (gap-worker.js) explains the central constraint: after
// startup the worker only runs during terminal operations, blocking in
// Atomics.wait the rest of the time. So uploads go through a
// SharedArrayBuffer mailbox the worker drains on terminal activity, and
// the worker pushes copies of every user file to this thread, so
// downloads are served from a local cache and never need to ask a
// (possibly blocked) worker.

// ---------------------------------------------------------------------
// MAINTAINER NOTES: what was added to this file, and why
//
// The original file handled the terminal/worker lifecycle, uploads, the
// files panel, the examples menu and the loading notice. Those parts are
// unchanged except where marked below. The page redesign (index.html) needed
// four additions here, all clearly sectioned:
//
//  1. SAVED STATE (section "Saved state"): files are copied to IndexedDB
//     (database "gap-ui-state") and the command history to localStorage
//     ("gap-history"), so both survive a reload. Restored files get status
//     "previous", which reuses the existing re-upload-on-insert path (the
//     same one used after "Restart GAP"). A checkbox ("Remember ...") turns
//     saving off and deletes stored data; "Clear saved data" deletes it on
//     request. Nothing is ever sent to a server.
//  2. COMMAND HISTORY (section "Command history, copy output, share links"):
//     each submitted command is read back from the terminal buffer when the
//     user presses Enter, and listed in the History panel. It cannot be
//     replayed into GAP's own line editor (that history lives inside the
//     GAP process), so the panel inserts text at the prompt instead.
//  3. COPY OUTPUT: "Copy output" (selection, or the whole buffer) and
//     "Copy last result" (from the last submitted command). Needed because
//     selecting text in the terminal is awkward on phones.
//  4. SHARE LINKS: "#cmd=<base64url text>". Following a link shows the text
//     in a dialog and inserts it at the prompt only after a click, and never
//     runs it. Shared text is untrusted: control characters are stripped
//     and the length is capped.
//
// Other notes:
//  - The DOM ids looked up below are a contract with index.html; renaming
//    one there breaks this file (the list is at the top of index.html).
//  - Line endings in this file are CRLF, as in the original.
//  - Browser support: needs SharedArrayBuffer (as before), IndexedDB and
//    clipboard access for the new features; each falls back or fails
//    quietly (see copyText and the try/catch blocks).
// ---------------------------------------------------------------------

"use strict";

// ---- upload mailbox protocol; keep in sync with gap-worker.js ----
const MB_STATE = 0, MB_LEN = 1, MB_FLAGS = 2;
const MB_IDLE = 0, MB_READY = 1, MB_CONSUMED = 2;
const MB_FLAG_HEADER = 1, MB_FLAG_FINAL = 2, MB_FLAG_END = 4;
const MB_CTRL_BYTES = 16;
const MB_DATA_BYTES = 1 << 20;

// Multi-line examples: every line except the last is submitted as it is
// pasted (the newline acts as Enter), so earlier lines run immediately —
// keep them to setup (silenced with ";;" or printing the definition);
// only the last line waits for the user's Enter.
const EXAMPLES = [
  { label: "Intersect two permutation groups",
    code: 'G := Group((1,2,3)(4,5,6), (1,4), (2,5), (3,6));\n' +
          'H := Group((1,2,4,6), (4,6));\n' +
          'Intersection(G, H);' },
  { label: "Character table of A5",
    code: 'Display(CharacterTable(AlternatingGroup(5)));' },
  { label: "The groups of order 12",
    code: 'List(AllSmallGroups(12), StructureDescription);' },
  { label: "Factorise a Fermat number",
    code: 'Factors(2^64 + 1);' },
  { label: "A finitely presented group",
    code: 'F := FreeGroup("a", "b");;\nG := F / [F.1^2, F.2^3, (F.1*F.2)^5];; Size(G);' },
];

const loadingEl = document.getElementById("loading");
const unsupportedEl = document.getElementById("unsupported");
const terminalEl = document.getElementById("terminal");
const restartBtn = document.getElementById("restart");
const uploadInput = document.getElementById("upload-input");
const uploadBtn = document.getElementById("upload-button");
const fileListEl = document.getElementById("file-list");
const fileEmptyEl = document.getElementById("files-empty");
const examplesEl = document.getElementById("example-list");
// Elements added by the redesign (history panel, saved-data controls, copy /
// share buttons, share dialog). Features that need them check for null.
const historyListEl = document.getElementById("history-list");
const historyEmptyEl = document.getElementById("history-empty");
const persistBox = document.getElementById("persist-box");
const clearSavedBtn = document.getElementById("clear-saved");
const copyAllBtn = document.getElementById("copy-all");
const copyLastBtn = document.getElementById("copy-last");
const shareBtn = document.getElementById("share-link");
const toolStatusEl = document.getElementById("tool-status");
const shareDialog = document.getElementById("share-dialog");
const shareCodeEl = document.getElementById("share-code");
const shareWarnEl = document.getElementById("share-warn");

// URLs reported by gap-fs.js's fetch/XHR instrumentation, for rebuilding
// startup_manifest.json (see README.md). Inspect from the devtools
// console with copy(JSON.stringify(fetchedUrls)).
window.fetchedUrls = [];
const fetchedSet = new Set();

// Number of files the startup manifest will fetch on a cold visit, for
// the progress notice. 0 (missing/empty manifest) keeps the generic text.
let manifestTotal = 0;
fetch("startup_manifest.json")
  .then((r) => (r.ok ? r.json() : []))
  .then((list) => { manifestTotal = list.length; })
  .catch(() => {});

// The files panel cache: path -> entry. Entries survive a session restart
// (status "previous"): the bytes are still here, so they stay
// downloadable, and inserting their Read command first re-uploads them
// into the new session.
//   { size, data: Uint8Array, status: "transferring"|"ready"|"previous" }
const fileEntries = new Map();

// ---------------------------------------------------------------------
// Saved state: files (IndexedDB) and command history (localStorage) are
// kept on this device only, so they survive a reload. The "Remember"
// checkbox switches saving on/off; "Clear saved data" removes it all.
// Files restored from a previous visit get status "previous", so the
// existing re-upload-on-insert path puts them back into the new session.

const STATE_DB = "gap-ui-state";
const FILE_STORE = "files";
const HISTORY_KEY = "gap-history";
const PERSIST_KEY = "gap-persist";
const MAX_SAVED_BYTES = 50 * 1024 * 1024;
const MAX_HISTORY = 200;

// Whether files and history are saved in this browser (user setting).
let persistOn = true;
try { persistOn = localStorage.getItem(PERSIST_KEY) !== "off"; } catch (e) { /* storage blocked */ }
// filesLoaded guards saving: renderFiles() runs before the stored files are
// read back, and saving that empty state would wipe them.
let filesLoaded = false;
let saveTimer = null;
// Named cmdHistory, not "history": a top-level "history" would clash with
// window.history, which handleShareHash() uses.
let cmdHistory = [];   // oldest first

function openStateDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(STATE_DB, 1);
    req.onupgradeneeded = () =>
      req.result.createObjectStore(FILE_STORE, { keyPath: "path" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

async function loadSavedFiles() {
  if (!persistOn || !window.indexedDB) return;
  try {
    const db = await openStateDb();
    const req = db.transaction(FILE_STORE).objectStore(FILE_STORE).getAll();
    const rows = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    for (const r of rows) {
      if (!fileEntries.has(r.path)) {
        fileEntries.set(r.path, { size: r.size, data: r.data,
                                  status: "previous" });
      }
    }
  } catch (e) {
    console.warn("Could not load saved files:", e);
  }
}

// Saving is debounced (500 ms) so a burst of changes writes once. The whole
// store is rewritten each time; files are small and few, and this keeps the
// stored copy exactly equal to the panel. Files over the 50 MB total budget
// are skipped (with a notice) so storage quota errors stay rare.
function scheduleSaveFiles() {
  if (!filesLoaded || !persistOn || !window.indexedDB) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveFiles, 500);
}

async function saveFiles() {
  try {
    const db = await openStateDb();
    const tx = db.transaction(FILE_STORE, "readwrite");
    const store = tx.objectStore(FILE_STORE);
    store.clear();
    let total = 0, skipped = 0;
    for (const [path, e] of fileEntries) {
      if (e.status === "transferring" || e.status === "failed") continue;
      if (total + e.data.length > MAX_SAVED_BYTES) { skipped++; continue; }
      total += e.data.length;
      store.put({ path: path, size: e.size, data: e.data });
    }
    await txDone(tx);
    db.close();
    if (skipped > 0) {
      announce(skipped + " file(s) were too large to save in this browser.");
    }
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist();
    }
  } catch (e) {
    console.warn("Could not save files:", e);
  }
}

function loadHistory() {
  try {
    const v = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    if (Array.isArray(v)) {
      cmdHistory = v.filter((x) => typeof x === "string").slice(-MAX_HISTORY);
    }
  } catch (e) { /* ignore */ }
}

function saveHistory() {
  if (!persistOn) return;
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(cmdHistory)); }
  catch (e) { /* storage full or blocked */ }
}

// Empty and very long lines are ignored; consecutive duplicates are
// collapsed. Keeps the newest MAX_HISTORY entries.
function addHistory(cmd) {
  cmd = cmd.trim();
  if (cmd === "" || cmd.length > 2000) return;
  if (cmdHistory[cmdHistory.length - 1] === cmd) return;
  cmdHistory.push(cmd);
  if (cmdHistory.length > MAX_HISTORY) cmdHistory.shift();
  saveHistory();
  renderHistory();
}

function renderHistory() {
  if (!historyListEl) return;
  historyListEl.textContent = "";
  historyEmptyEl.style.display = cmdHistory.length === 0 ? "" : "none";
  for (const cmd of cmdHistory.slice(-50).reverse()) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "example-button history-button";
    b.textContent = cmd;
    b.title = "Insert at the prompt: " + cmd;
    b.addEventListener("click", () => insertAtPrompt(cmd));
    li.append(b);
    historyListEl.append(li);
  }
}

// Removes everything saved in this browser (history and files). Does not
// touch the files in the running session.
async function clearStored() {
  try { localStorage.removeItem(HISTORY_KEY); } catch (e) { /* ignore */ }
  if (window.indexedDB) {
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase(STATE_DB);
      req.onsuccess = req.onerror = req.onblocked = resolve;
    });
  }
}

// Per-session state; replaced wholesale by startSession() so that any
// in-flight async sender from a dead session aborts cleanly.
let session = null;

function gapQuote(path) {
  return '"' + path.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function humanSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " kB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

// Paste text at GAP's prompt. Deliberately no trailing newline: the user
// presses Enter, so nothing is ever auto-executed.
function insertAtPrompt(text) {
  if (session === null) return;
  session.xterm.paste(text);
  session.xterm.focus();
}

// ---------------------------------------------------------------------
// Upload sender. Writes one chunk whenever the worker has consumed the
// previous one; never blocks the main thread (Atomics.wait is forbidden
// here, so it uses Atomics.waitAsync where available and polling
// otherwise). The worker only drains on terminal activity, so a transfer
// started while GAP sits at its prompt completes on the next keystroke —
// in particular, the keystrokes of a pasted Read command arrive after
// the drain runs, so the file is always in place before Enter.

function waitMailboxState(s, want) {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (s.dead) {
        reject(new Error("session restarted"));
        return;
      }
      const cur = Atomics.load(s.mbCtrl, MB_STATE);
      if (cur === want) {
        resolve();
        return;
      }
      if (Atomics.waitAsync) {
        const r = Atomics.waitAsync(s.mbCtrl, MB_STATE, cur, 1000);
        if (r.async) r.value.then(check);
        else check();
      } else {
        setTimeout(check, 10);
      }
    };
    check();
  });
}

function writeChunk(s, bytes, flags) {
  s.mbData.set(bytes, 0);
  s.mbCtrl[MB_LEN] = bytes.length;
  s.mbCtrl[MB_FLAGS] = flags;
  Atomics.store(s.mbCtrl, MB_STATE, MB_READY);
  Atomics.notify(s.mbCtrl, MB_STATE);
}

// files: [{ name, data: Uint8Array }]
async function sendFiles(files) {
  const s = session;
  for (const f of files) {
    fileEntries.set(f.name, { size: f.data.length, data: f.data,
                              status: "transferring" });
    s.uploadQueue.push(f);
  }
  renderFiles();
  if (s.senderActive) return;
  s.senderActive = true;
  try {
    await waitMailboxState(s, MB_IDLE);
    while (s.uploadQueue.length > 0) {
      const f = s.uploadQueue.shift();
      const header = new TextEncoder().encode(
        JSON.stringify({ name: f.name, size: f.data.length }));
      writeChunk(s, header, MB_FLAG_HEADER);
      await waitMailboxState(s, MB_CONSUMED);
      let off = 0;
      do {
        const n = Math.min(MB_DATA_BYTES, f.data.length - off);
        const last = off + n >= f.data.length;
        writeChunk(s, f.data.subarray(off, off + n),
                   last ? MB_FLAG_FINAL : 0);
        off += n;
        await waitMailboxState(s, MB_CONSUMED);
      } while (off < f.data.length);
    }
    // Close the session; the worker hands the mailbox back as MB_IDLE.
    writeChunk(s, new Uint8Array(0), MB_FLAG_END);
  } catch (e) {
    // Only a restart gets here; the entries were already marked
    // "previous" by the restart handler.
    if (!s.dead) throw e;
  } finally {
    s.senderActive = false;
  }
}

// ---------------------------------------------------------------------
// Files panel

function downloadEntry(path) {
  const entry = fileEntries.get(path);
  const blob = new Blob([entry.data]);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = path.split("/").pop();
  a.click();
  URL.revokeObjectURL(a.href);
}

function insertEntry(path) {
  const entry = fileEntries.get(path);
  if (entry.status === "previous") {
    // From a previous session: put it back first. The re-upload drains
    // before the pasted command's Enter can be processed.
    sendFiles([{ name: path, data: entry.data }]);
  }
  insertAtPrompt("Read(" + gapQuote(path) + ");");
}

function renderFiles() {
  fileListEl.textContent = "";
  fileEmptyEl.style.display = fileEntries.size === 0 ? "" : "none";
  const paths = Array.from(fileEntries.keys()).sort();
  for (const path of paths) {
    const entry = fileEntries.get(path);
    const li = document.createElement("li");

    const nameSpan = document.createElement("span");
    nameSpan.className = "file-name";
    nameSpan.textContent = path;
    nameSpan.title = path;

    const metaSpan = document.createElement("span");
    metaSpan.className = "file-meta";
    metaSpan.textContent = humanSize(entry.size) +
      (entry.status === "transferring" ? " · sending…"
       : entry.status === "failed" ? " · failed"
       : entry.status === "previous" ? " · previous session" : "");

    const insertB = document.createElement("button");
    insertB.className = "icon-button";
    insertB.textContent = "↳";
    insertB.title = "Insert Read(" + gapQuote(path) + "); at the prompt" +
      (entry.status === "previous" ? " (re-uploads the file first)" : "");
    insertB.addEventListener("click", () => insertEntry(path));

    const downloadB = document.createElement("button");
    downloadB.className = "icon-button";
    downloadB.textContent = "⬇";
    downloadB.title = "Download " + path;
    downloadB.addEventListener("click", () => downloadEntry(path));

    const text = document.createElement("div");
    text.className = "file-text";
    text.append(nameSpan, metaSpan);
    li.append(text, insertB, downloadB);
    fileListEl.append(li);
  }
  // Every change to the files panel is also persisted (debounced; no-op
  // until the saved files have been read back, or when saving is off).
  scheduleSaveFiles();
}

uploadBtn.addEventListener("click", () => uploadInput.click());
uploadInput.addEventListener("change", async () => {
  const files = [];
  for (const f of uploadInput.files) {
    // Basename only: uploads land directly in GAP's working directory.
    const name = f.name.split(/[/\\]/).pop();
    if (name === "") continue;
    const data = new Uint8Array(await f.arrayBuffer());
    files.push({ name: name, data: data });
  }
  uploadInput.value = "";
  if (files.length > 0) sendFiles(files);
});

// ---------------------------------------------------------------------
// Examples

for (const ex of EXAMPLES) {
  const li = document.createElement("li");
  const b = document.createElement("button");
  b.className = "example-button";
  b.textContent = ex.label;
  b.title = ex.code;
  b.addEventListener("click", () => insertAtPrompt(ex.code));
  li.append(b);
  examplesEl.append(li);
}

// ---------------------------------------------------------------------
// Session lifecycle

function handleWorkerMessage(ev) {
  const data = ev.data;
  if (!data || !data.type) return;
  switch (data.type) {
    case "gap-fetched":
      if (!fetchedSet.has(data.url)) {
        fetchedSet.add(data.url);
        window.fetchedUrls.push(data.url);
        if (/^(pkg|lib|grp|tst|doc|hpcgap|dev|benchmark)\//.test(data.url)) {
          session.fetchCount++;
          if (!session.started) {
            const progress = "fetched " + session.fetchCount +
              (manifestTotal > 0 ? " of ~" + manifestTotal : "") + " files";
            loadingEl.textContent = "Loading GAP… " + progress + ".";
            // \r keeps overwriting one progress line in the terminal.
            session.xterm.write("\rLoading GAP… " + progress);
          }
        }
      }
      break;
    case "gap-user-files":
      for (const f of data.changed) {
        fileEntries.set(f.path, { size: f.size, data: f.data,
                                  status: "ready" });
      }
      for (const p of data.removed) {
        // Deleted inside GAP; drop it from the panel too.
        fileEntries.delete(p);
      }
      renderFiles();
      break;
    case "gap-file-uploaded": {
      const entry = fileEntries.get(data.name);
      if (entry && entry.status === "transferring") entry.status = "ready";
      renderFiles();
      break;
    }
    case "gap-file-error":
      console.error("Upload failed in worker:", data);
      for (const entry of fileEntries.values()) {
        if (entry.status === "transferring") entry.status = "failed";
      }
      renderFiles();
      break;
  }
}

function startSession() {
  loadingEl.style.display = "";
  loadingEl.textContent = "Loading GAP… The first visit downloads several " +
    "tens of megabytes; later visits are cached by your browser and " +
    "start much faster.";

  const xterm = new Terminal({
    fontFamily: '"Ubuntu Mono", Menlo, Consolas, monospace',
    fontSize: 15,
    cursorBlink: true,
    theme: { background: "#1d1d1d", foreground: "#e6e6e6" },
  });
  const fitAddon = new FitAddon.FitAddon();
  xterm.loadAddon(fitAddon);
  xterm.open(terminalEl);
  fitAddon.fit();

  const { master, slave } = openpty();
  xterm.loadAddon(master);

  const mailbox = new SharedArrayBuffer(MB_CTRL_BYTES + MB_DATA_BYTES);
  const worker = new Worker("gap-worker.js");
  worker.postMessage({ type: "gap-init", mailbox: mailbox });

  session = {
    xterm: xterm,
    fitAddon: fitAddon,
    master: master,
    slave: slave,
    worker: worker,
    mbCtrl: new Int32Array(mailbox, 0, 4),
    mbData: new Uint8Array(mailbox, MB_CTRL_BYTES),
    uploadQueue: [],
    senderActive: false,
    fetchCount: 0,
    started: false,
    dead: false,
    lastCmdRow: -1,     // buffer row where the last submitted command began
  };
  const s = session;

  // Record each command the user submits (a bare Enter). The text is read
  // back from the terminal buffer, so it is exactly what GAP shows, even
  // after line editing or history recall. Pasted multi-line input is not
  // recorded here (it arrives as one chunk, not a bare Enter).
  xterm.onData((d) => {
    if (d === "\r" && session === s) recordCommand(xterm);
  });

  // GAP's first terminal output arrives as the worker's first "write"
  // tty request. Detect it here (this listener is registered before
  // TtyServer.start assigns worker.onmessage, so it runs first) and
  // reset the terminal, so the waiting/progress text below is wiped
  // and the GAP banner starts on a clean screen.
  worker.addEventListener("message", (ev) => {
    const d = ev.data;
    if (d && d.ttyRequestType === "write" && !s.started) {
      s.started = true;
      s.xterm.reset();
      loadingEl.style.display = "none";
    }
  });

  session.ttyServer = new TtyServer(slave);
  session.ttyServer.start(worker, handleWorkerMessage);

  xterm.write(
    "\x1b[2mPlease wait — downloading and starting GAP.\r\n" +
    "The first visit can take a few minutes; repeat visits are cached " +
    "by your browser and start much faster.\x1b[0m\r\n\r\n");
}

function restartSession() {
  session.dead = true;
  session.worker.terminate();
  session.xterm.dispose();
  for (const entry of fileEntries.values()) {
    // The session's filesystem is gone, but our cached bytes are not.
    entry.status = "previous";
  }
  renderFiles();
  startSession();
}

window.addEventListener("resize", () => {
  if (session !== null) session.fitAddon.fit();
});

restartBtn.addEventListener("click", () => {
  if (session !== null) restartSession();
});

// Escape hatch for stale state: drop the IndexedDB file cache and any
// registered service worker, then reload from the network. (gap-fs.js
// also discards the cache automatically when the site's build-id
// changes; this covers everything else.)
document.getElementById("reset-site").addEventListener("click", async (ev) => {
  ev.preventDefault();
  if (session !== null) {
    session.dead = true;
    session.worker.terminate();
  }
  if (navigator.serviceWorker) {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
  }
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase("/gap_idb_cache");
    req.onsuccess = req.onerror = req.onblocked = resolve;
  });
  location.reload();
});

// ---------------------------------------------------------------------
// Command history, copy output, share links

// GAP's prompts: "gap> ", continuation "> ", and break loops "brk> " /
// "brk_02> ". Used to find where the command text starts on a terminal line.
const PROMPT_RE = /^(?:gap|brk(?:_\d+)?)?> ?/;
const PROMPT_ONLY_RE = /^(?:gap|brk(?:_\d+)?)>\s*$/;

// Reads the line under the cursor from the terminal buffer (joining rows that
// were wrapped by the terminal width) and records it as a command. Called
// when the user presses Enter. Remembers the row so "Copy last result" knows
// where the last command began.
function recordCommand(xterm) {
  const buf = xterm.buffer.active;
  let row = buf.baseY + buf.cursorY;
  const rows = [];
  for (;;) {
    const line = buf.getLine(row);
    if (!line) return;
    rows.unshift(line);
    if (!line.isWrapped || row === 0) break;
    row--;
  }
  const text = rows.map((l, i) => l.translateToString(i === rows.length - 1)).join("");
  const m = PROMPT_RE.exec(text);
  if (!m) return;   // not at a GAP prompt (e.g. a program reading input)
  session.lastCmdRow = row;
  addHistory(text.slice(m[0].length));
}

// Terminal text from buffer row `fromRow` to the end, with wrapped rows
// joined back into single lines and trailing blank lines dropped.
function bufferText(xterm, fromRow) {
  const buf = xterm.buffer.active;
  const out = [];
  for (let r = Math.max(0, fromRow); r < buf.length; r++) {
    const line = buf.getLine(r);
    if (!line) continue;
    const next = buf.getLine(r + 1);
    const t = line.translateToString(!(next && next.isWrapped));
    if (line.isWrapped && out.length > 0) out[out.length - 1] += t;
    else out.push(t);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

// "Copy last result": the last submitted command and everything printed
// after it, minus the fresh prompt that follows.
function lastResultText() {
  if (session === null || session.lastCmdRow < 0) return "";
  const lines = bufferText(session.xterm, session.lastCmdRow);
  if (lines.length > 1 && PROMPT_ONLY_RE.test(lines[lines.length - 1])) {
    lines.pop();   // the fresh prompt waiting for the next command
  }
  return lines.join("\n");
}

function selectedText() {
  return session !== null && session.xterm.hasSelection()
    ? session.xterm.getSelection() : "";
}

function announce(msg) {
  if (!toolStatusEl) return;
  toolStatusEl.textContent = "";
  setTimeout(() => { toolStatusEl.textContent = msg; }, 50);
}

function flash(btn, text) {
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  btn.textContent = text;
  clearTimeout(btn._flashTimer);
  btn._flashTimer = setTimeout(() => { btn.textContent = btn.dataset.label; }, 1800);
}

// Clipboard write with a fallback for browsers/contexts where the async
// clipboard API is unavailable (e.g. plain http). Must run from a user click.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) { /* fall back below (insecure context, old browser) */ }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (e) { /* ignore */ }
  ta.remove();
  return ok;
}

async function copyAndReport(btn, text, what) {
  if (!text) {
    announce("Nothing to copy yet.");
    flash(btn, "Nothing to copy");
    return;
  }
  const ok = await copyText(text);
  const n = text.split("\n").length;
  announce(ok ? "Copied " + what + " (" + n + (n === 1 ? " line)" : " lines)")
              : "Could not copy to the clipboard.");
  flash(btn, ok ? "Copied ✓" : "Copy failed");
  if (session !== null) session.xterm.focus();
}

if (copyAllBtn) {
  copyAllBtn.addEventListener("click", () => {
    if (session === null) return;
    const sel = selectedText();
    copyAndReport(copyAllBtn,
      sel || bufferText(session.xterm, 0).join("\n"),
      sel ? "the selection" : "the output");
  });
  copyLastBtn.addEventListener("click", () => {
    copyAndReport(copyLastBtn, lastResultText(), "the last result");
  });
}

// ---- share links: #cmd=<base64url of UTF-8 text> ----

// Share links carry the text in the URL hash, which is never sent to a
// server. Base64url over UTF-8 keeps the link safe to paste anywhere.
function encodeShare(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeShare(b64url) {
  try {
    const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (e) {
    return null;
  }
}

// Shared text is untrusted: drop control characters (escape sequences
// and the like) and cap the length.
function cleanSnippet(t) {
  return t.replace(/\r\n?/g, "\n")
          .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
          .slice(0, 4000)
          .replace(/\s+$/, "");
}

if (shareBtn) {
  shareBtn.addEventListener("click", async () => {
    const text = cleanSnippet(selectedText() ||
      (cmdHistory.length > 0 ? cmdHistory[cmdHistory.length - 1] : ""));
    if (!text) {
      announce("Nothing to share yet: run a command or select text first.");
      flash(shareBtn, "Nothing to share");
      return;
    }
    const url = location.origin + location.pathname + location.search +
                "#cmd=" + encodeShare(text);
    if (url.length > 6000) {
      announce("That is too long for a link.");
      flash(shareBtn, "Too long");
      return;
    }
    // Phones: the system share sheet. Elsewhere: copy the link.
    if (navigator.share && window.matchMedia("(pointer: coarse)").matches) {
      try {
        await navigator.share({ title: "GAP command", url: url });
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return;
      }
    }
    const ok = await copyText(url);
    announce(ok ? "Link copied. It inserts the command at the prompt without running it."
                : "Could not copy the link.");
    flash(shareBtn, ok ? "Link copied ✓" : "Copy failed");
  });
}

// Is GAP sitting at an empty prompt, ready for input?
// Share links are offered only once GAP is waiting at an empty prompt, so
// the inserted text does not land in the middle of the start-up banner.
function atPrompt() {
  if (session === null || !session.started) return false;
  const buf = session.xterm.buffer.active;
  const line = buf.getLine(buf.baseY + buf.cursorY);
  return !!line && /^gap>\s*$/.test(line.translateToString(true));
}

function waitForPrompt(callback) {
  const began = Date.now();
  const timer = setInterval(() => {
    if (atPrompt()) {
      clearInterval(timer);
      callback();
    } else if (Date.now() - began > 30 * 60 * 1000) {
      clearInterval(timer);
    }
  }, 300);
}

// A visitor following a share link sees the text first and decides:
// nothing is inserted (let alone run) without a click.
// SECURITY: never auto-insert or auto-run shared text. The visitor sees it
// in a dialog first; the hash is removed from the address bar afterwards so
// a reload does not offer it again.
let pendingShare = "";
function handleShareHash() {
  const m = /^#cmd=([A-Za-z0-9_-]+)$/.exec(location.hash);
  if (!m || !shareDialog) return;
  const decoded = decodeShare(m[1]);
  history.replaceState(null, "", location.pathname + location.search);
  if (decoded === null) return;
  const text = cleanSnippet(decoded);
  if (!text) return;
  waitForPrompt(() => {
    pendingShare = text;
    shareCodeEl.textContent = text;
    shareWarnEl.hidden = !text.includes("\n");
    if (shareDialog.showModal) shareDialog.showModal();
    else shareDialog.setAttribute("open", "");
  });
}

if (shareDialog) {
  const closeShare = () => {
    if (shareDialog.close) shareDialog.close();
    else shareDialog.removeAttribute("open");
  };
  document.getElementById("share-insert").addEventListener("click", () => {
    closeShare();
    insertAtPrompt(pendingShare);
  });
  document.getElementById("share-cancel").addEventListener("click", closeShare);
}
window.addEventListener("hashchange", handleShareHash);

// ---- saved-data controls ----

if (persistBox) {
  persistBox.checked = persistOn;
  persistBox.addEventListener("change", () => {
    persistOn = persistBox.checked;
    try { localStorage.setItem(PERSIST_KEY, persistOn ? "on" : "off"); }
    catch (e) { /* ignore */ }
    if (persistOn) {
      saveHistory();
      scheduleSaveFiles();
      announce("Saving files and history in this browser is on.");
    } else {
      clearStored();
      announce("Saving is off. Stored data was removed from this browser.");
    }
  });
  clearSavedBtn.addEventListener("click", async () => {
    await clearStored();
    cmdHistory = [];
    renderHistory();
    for (const [p, e] of Array.from(fileEntries)) {
      if (e.status === "previous") fileEntries.delete(p);
    }
    renderFiles();
    announce("Saved data cleared.");
  });
}

// Without SharedArrayBuffer the worker can't talk to the page
// synchronously; xterm-pty would stall on every read.
if (typeof SharedArrayBuffer === "undefined") {
  loadingEl.style.display = "none";
  unsupportedEl.style.display = "block";
} else {
  // Start-up order: history first (instant), then GAP, then the saved files.
  // The files load in the background so they never delay GAP's start; they
  // appear in the panel as soon as they are read.
  loadHistory();
  renderHistory();
  renderFiles();
  startSession();
  // Restore files from an earlier visit alongside GAP's startup.
  loadSavedFiles().then(() => {
    filesLoaded = true;
    renderFiles();
  });
  handleShareHash();
}
