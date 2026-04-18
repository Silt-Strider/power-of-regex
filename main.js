'use strict';

var obsidian = require('obsidian');

/*! *****************************************************************************
Copyright (c)
Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.
THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
***************************************************************************** */

function __awaiter(thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
}

// ── Constants ─────────────────────────────────────────────────────────────────

const VIEW_TYPE_REGEX_REPLACE = 'regex-find-replace-view';

const DEFAULT_SETTINGS = {
    selOnly:        false,
    wrapAround:     true,
    prefillFind:    false,
    findHistory:    [],
    replaceHistory: [],
    maxHistory:     10,
    regexFlags: { g: true, i: false, m: true, u: true, s: false, y: false }
};

const logThreshold = 0;
const logger = (msg, level = 0) => { if (level <= logThreshold) console.log('RegexFiRe: ' + msg); };

// ── Pure helpers ──────────────────────────────────────────────────────────────

function getRegexFlagsStr(settings) {
    const f = settings.regexFlags || {};
    return ['g', 'i', 'm', 'u', 's', 'y'].filter(k => f[k]).join('');
}

function processReplaceString(str) {
    return str.replace(/\\n/gm, '\n').replace(/\\t/gm, '\t');
}

function makeReplacer(replStr) {
    return function () {
        const all = Array.from(arguments);
        let offsetIdx = 1;
        while (offsetIdx < all.length && typeof all[offsetIdx] !== 'number') offsetIdx++;
        const groups = all.slice(1, offsetIdx);
        return replStr
            .replace(/\\(\d+)/g, (m, n) => { const g = groups[+n - 1]; return g !== undefined ? g : m; })
            .replace(/\$(\d+)/g,  (m, n) => { const g = groups[+n - 1]; return g !== undefined ? g : m; });
    };
}

function isExactMatch(text, search, flagsNoG) {
    if (!text || !search) return false;
    try {
        const m = new RegExp(search, flagsNoG).exec(text);
        return m !== null && m.index === 0 && m[0].length === text.length;
    } catch (_) { return false; }
}

function addToHistory(settings, findVal, replaceVal) {
    const maxH = settings.maxHistory || 0;
    if (maxH === 0 || (findVal === '' && replaceVal === '')) return;
    [[settings.findHistory, findVal], [settings.replaceHistory, replaceVal]].forEach(([arr, val]) => {
        const i = arr.indexOf(val);
        if (i > -1) arr.splice(i, 1);
        arr.unshift(val);
        if (arr.length > maxH) arr.pop();
    });
}

// ── Shared UI builder ─────────────────────────────────────────────────────────

function buildFindReplaceUI(containerEl, getEditor, settings, plugin, opts) {
    opts = opts || {};

    let selScope       = null;
    let findHistIdx    = -1;
    let replaceHistIdx = -1;
    const cleanups     = [];

    // ── History input helper ───────────────────────────────────────────────

    function addHistoryInput(label, placeholder, getHistory, getIdx, setIdx) {
        const row = containerEl.createDiv({ cls: 'frr-row' });
        row.createDiv({ cls: 'frr-label' }).setText(label);

        const wrapper = row.createDiv({ cls: 'frr-input-wrapper' });
        const comp    = new obsidian.TextComponent(wrapper);
        comp.setPlaceholder(placeholder);

        const arrowBtn = wrapper.createEl('button', { cls: 'frr-history-btn' });
        arrowBtn.setText('▾');
        arrowBtn.setAttribute('aria-label', 'Show search history');
        arrowBtn.setAttribute('type', 'button');
        arrowBtn.setAttribute('tabindex', '-1');

        const dropdown = wrapper.createDiv({ cls: 'frr-dropdown' });

        const closeDropdown = () => { dropdown.style.display = 'none'; };
        const openDropdown  = () => {
            dropdown.empty();
            const hist = getHistory();
            if (!hist.length) {
                dropdown.createDiv({ cls: 'frr-dropdown-item frr-dropdown-empty', text: '— no history —' });
            } else {
                hist.forEach(item => {
                    const el = dropdown.createDiv({ cls: 'frr-dropdown-item' });
                    el.setText(item === '' ? '(empty string)' : item);
                    el.addEventListener('mousedown', e => {
                        e.preventDefault();
                        comp.setValue(item);
                        setIdx(-1);
                        closeDropdown();
                        comp.inputEl.focus();
                    });
                });
            }
            dropdown.style.display = 'block';
        };

        arrowBtn.addEventListener('click', e => {
            e.stopPropagation();
            dropdown.style.display === 'none' ? openDropdown() : closeDropdown();
        });

        const outsideHandler = e => { if (!wrapper.contains(e.target)) closeDropdown(); };
        document.addEventListener('click', outsideHandler);
        cleanups.push(() => document.removeEventListener('click', outsideHandler));

        comp.inputEl.addEventListener('keydown', e => {
            const hist = getHistory();
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (!hist.length) return;
                const ni = Math.min(getIdx() + 1, hist.length - 1);
                setIdx(ni); comp.setValue(hist[ni]);
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                const ni = getIdx() - 1;
                if (ni < 0) { setIdx(-1); comp.setValue(''); }
                else        { setIdx(ni); comp.setValue(hist[ni]); }
            }
        });

        return { comp, row };
    }

    // ── Find / Replace rows ───────────────────────────────────────────────

    const { comp: findComp, row: findRow } = addHistoryInput(
        'Find:', 'e.g. (\\w+)',
        () => settings.findHistory,
        () => findHistIdx, v => { findHistIdx = v; }
    );
    const flagsPostfix = findRow.createDiv({ cls: 'frr-postfix' });
    flagsPostfix.setText('/' + getRegexFlagsStr(settings));

    const { comp: replaceComp } = addHistoryInput(
        'Replace:', 'e.g. $1 or \\1',
        () => settings.replaceHistory,
        () => replaceHistIdx, v => { replaceHistIdx = v; }
    );

    // ── Toggle row ────────────────────────────────────────────────────────

    const toggleRowEl = containerEl.createDiv({ cls: 'frr-row frr-toggle-row' });

    const inSelGroup = toggleRowEl.createDiv({ cls: 'frr-toggle-group' });
    inSelGroup.createDiv({ cls: 'frr-toggle-label' }).setText('In selection');
    const inSelToggle = new obsidian.ToggleComponent(inSelGroup.createDiv({ cls: 'frr-toggle-wrap' }));
    inSelToggle.setTooltip('Restrict search/replace to the originally selected text. Mutually exclusive with Wrap Around.');
    inSelToggle.setValue(!!settings.selOnly);

    const wrapGroup = toggleRowEl.createDiv({ cls: 'frr-toggle-group' });
    wrapGroup.createDiv({ cls: 'frr-toggle-label' }).setText('Wrap around');
    const wrapToggle = new obsidian.ToggleComponent(wrapGroup.createDiv({ cls: 'frr-toggle-wrap' }));
    wrapToggle.setTooltip('Wrap the search around when reaching the end of the document. Mutually exclusive with In selection.');
    wrapToggle.setValue(!!settings.wrapAround);

    const captureScope = () => {
        const ed = getEditor();
        if (!ed) { selScope = null; return; }
        const from = ed.posToOffset(ed.getCursor('from'));
        const to   = ed.posToOffset(ed.getCursor('to'));
        selScope = from < to ? { from, to } : null;
    };

    inSelToggle.onChange(enabled => {
        if (enabled) {
            captureScope();
            if (!!wrapToggle.getValue()) wrapToggle.setValue(false);
        } else {
            selScope = null;
        }
    });

    wrapToggle.onChange(enabled => {
        if (enabled && !!inSelToggle.getValue()) {
            inSelToggle.setValue(false);
            selScope = null;
        }
    });

    if (!!inSelToggle.getValue()) captureScope();

    // ── Buttons ───────────────────────────────────────────────────────────

    const btnRow = containerEl.createDiv({ cls: 'frr-row frr-btn-row' });
    const makeBtn = (text, cta) => {
        const w = btnRow.createDiv({ cls: 'frr-btn-wrap' });
        const b = new obsidian.ButtonComponent(w);
        b.setButtonText(text);
        if (cta) b.setCta();
        return b;
    };

    const findNextBtn   = makeBtn('Find Next');
    const replaceBtn    = makeBtn('Replace');
    const replaceAllBtn = makeBtn('Replace All', true);

    // ── Save helpers ──────────────────────────────────────────────────────

    const persist = () => {
        settings.selOnly    = !!inSelToggle.getValue();
        settings.wrapAround = !!wrapToggle.getValue();
        plugin.saveData(settings);
    };

    const persistWithHistory = () => {
        addToHistory(settings, findComp.getValue(), replaceComp.getValue());
        persist();
    };

    // ── Regex helpers ─────────────────────────────────────────────────────

    const buildFlags = () => {
        let f = getRegexFlagsStr(settings);
        if (!f.includes('g')) f = 'g' + f;
        return f;
    };

    const buildFlagsNoG = () => getRegexFlagsStr(settings).replace('g', '') || 'mu';

    // ── Editor focus helper ───────────────────────────────────────────────

    const focusEditor = () => {
        if (opts.isModal) return;
        const ed = getEditor();
        if (ed) ed.focus();
    };

    // ── doFindNext ────────────────────────────────────────────────────────

    // Find the next match and, unless silent, select it in the editor.
    const doFindNext = (search, wrap, silent = false) => {
        if (!search) return 'empty';
        const ed = getEditor();
        if (!ed) return 'noeditor';

        const doWrap  = !!wrap;
        const flags   = buildFlags();
        const docText = ed.getValue();

        const useScope = !!inSelToggle.getValue() && selScope !== null;
        const winFrom  = useScope ? selScope.from : 0;
        const winTo    = useScope ? selScope.to   : docText.length;
        const winText  = docText.slice(winFrom, winTo);

        const selFrom  = ed.posToOffset(ed.getCursor('from'));
        const selTo    = ed.posToOffset(ed.getCursor('to'));
        const selText  = selFrom < selTo ? docText.slice(selFrom, selTo) : '';

        let localStart;
        if (selText && isExactMatch(selText, search, buildFlagsNoG())) {
            localStart = Math.max(0, selTo - winFrom);
        } else {
            localStart = Math.max(0, selFrom - winFrom);
        }
        localStart = Math.min(localStart, winText.length);

        let matchIdx = -1, matchLen = 0, didWrap = false;
        try {
            const re = new RegExp(search, flags);
            let match, first = null;
            while ((match = re.exec(winText)) !== null) {
                if (match[0].length === 0) { re.lastIndex++; continue; }
                if (!first) first = match;
                if (match.index >= localStart) {
                    matchIdx = match.index;
                    matchLen = match[0].length;
                    break;
                }
            }
            if (matchIdx === -1 && doWrap && first) {
                matchIdx = first.index;
                matchLen = first[0].length;
                didWrap  = true;
            }
        } catch (e) {
            new obsidian.Notice('Invalid regex: ' + e.message);
            return 'error';
        }

        if (matchIdx !== -1 && matchLen > 0) {
            if (!silent) {
                const gFrom = matchIdx + winFrom;
                const gTo   = gFrom + matchLen;
                const from  = ed.offsetToPos(gFrom);
                const to    = ed.offsetToPos(gTo);
                ed.setSelection(from, to);
                ed.scrollIntoView({ from, to }, true);

                if (!opts.isModal) ed.focus();
            }
            return didWrap ? 'found_wrapped' : 'found';
        }

        return 'notfound';
    };

    // ── doReplace ─────────────────────────────────────────────────────────

    // Replace current selection if exact match, then always call doFindNext.
    const doReplace = (search, rawReplace, wrap) => {
        if (!search) return 'empty';
        const ed = getEditor();
        if (!ed) return 'noeditor';

        const docText  = ed.getValue();
        const selFrom  = ed.posToOffset(ed.getCursor('from'));
        const selTo    = ed.posToOffset(ed.getCursor('to'));
        const selText  = selFrom < selTo ? docText.slice(selFrom, selTo) : '';
        const flagsNoG = buildFlagsNoG();

        let didReplace = false;

        if (selText && isExactMatch(selText, search, flagsNoG)) {
            const replStr     = processReplaceString(rawReplace);
            const replacement = selText.replace(new RegExp(search, flagsNoG), makeReplacer(replStr));
            ed.replaceRange(replacement, ed.offsetToPos(selFrom), ed.offsetToPos(selTo));

            if (!!inSelToggle.getValue() && selScope !== null) {
                const delta = replacement.length - selText.length;
                selScope = { from: selScope.from, to: selScope.to + delta };
            }
            didReplace = true;
        }

        const findResult = doFindNext(search, wrap);

        if (didReplace) {
            return findResult === 'found_wrapped' ? 'replaced_wrapped' : 'replaced';
        }
        return findResult;
    };

    // ── doReplaceAll ──────────────────────────────────────────────────────

    // Strategy:
    //   1. Single regex pass → collect all {from, to, insert} descriptors
    //   2. One cm.dispatch({ changes })
    //   3. Pre-CM6 fallback: reverse-order replaceRange
    //
    // Wrap semantics:
    //   wrap=true  → start at top of window (full document/selection replace)
    //   wrap=false → start at cursor, stop at end of window
    //   "In selection" always starts at selScope.from, regardless of wrap.

    const doReplaceAll = (search, rawReplace, wrap) => {
        if (!search) return 'empty';
        const ed = getEditor();
        if (!ed) return 'noeditor';

        const doWrap   = !!wrap;
        const flags    = buildFlags();
        const flagsNoG = buildFlagsNoG();
        const replStr  = processReplaceString(rawReplace);

        const useScope = !!inSelToggle.getValue() && selScope !== null;
        const docText  = ed.getValue();
        const winFrom  = useScope ? selScope.from : 0;
        const winTo    = useScope ? selScope.to   : docText.length;

        // Determine start offset within the window
        let searchStart;
        if (useScope || doWrap) {
            searchStart = winFrom;
        } else {
            const cursorOffset = ed.posToOffset(ed.getCursor('from'));
            searchStart = Math.max(winFrom, Math.min(cursorOffset, winTo));
        }

        const winText    = docText.slice(winFrom, winTo);
        const localStart = searchStart - winFrom;

        try {
            const re      = new RegExp(search, flags);
            const changes = [];
            let sizeOffset = 0;

            let match;
            re.lastIndex = 0;
            while ((match = re.exec(winText)) !== null) {
                if (match[0].length === 0) { re.lastIndex++; continue; }
                if (match.index < localStart) continue;

                const absFrom    = winFrom + match.index;
                const absTo      = absFrom + match[0].length;
                const replacement = match[0].replace(new RegExp(search, flagsNoG), makeReplacer(replStr));
                changes.push({ from: absFrom, to: absTo, insert: replacement });
                sizeOffset += replacement.length - match[0].length;
            }

            if (changes.length === 0) {
                new obsidian.Notice('No match found.');
                return 'notfound';
            }

            // Apply all changes in one transaction
            let applied = false;
            try {
                const cm = ed.cm;
                if (cm && typeof cm.dispatch === 'function' && cm.state) {
                    cm.dispatch({ changes });
                    applied = true;
                }
            } catch (_) {}

            if (!applied) {
                // Pre-CM6: reverse order so earlier absolute offsets stay valid
                for (let i = changes.length - 1; i >= 0; i--) {
                    const c = changes[i];
                    ed.replaceRange(c.insert, ed.offsetToPos(c.from), ed.offsetToPos(c.to));
                }
            }

            if (useScope && selScope !== null) {
                selScope = { from: selScope.from, to: selScope.to + sizeOffset };
            }

            addToHistory(settings, search, rawReplace);
            persist();
            focusEditor();

            const scope = useScope ? 'selection' : (doWrap ? 'document' : 'document (from cursor)');
            new obsidian.Notice(`Made ${changes.length} replacement(s) in ${scope}.`);
            if (opts.isModal) opts.onClose && opts.onClose();
            return 'replaced';

        } catch (e) {
            new obsidian.Notice('Invalid regex: ' + e.message);
            return 'error';
        }
    };

    // ── Wire up buttons ───────────────────────────────────────────────────

    findNextBtn.onClick(() => {
        const s = findComp.getValue();
        if (!s) { new obsidian.Notice('Nothing to search for!'); return; }
        const w = !!wrapToggle.getValue();
        const r = doFindNext(s, w);

        if (r === 'found_wrapped') {
            addToHistory(settings, s, replaceComp.getValue());
            persist();
            new obsidian.Notice('Wrapped around.');
        } else if (r === 'found') {
            addToHistory(settings, s, replaceComp.getValue());
            persist();
        } else if (r === 'notfound') {
            focusEditor();
            new obsidian.Notice('No more matches.');
        } else if (r === 'noeditor') {
            new obsidian.Notice('No active editor.');
        }
    });

    replaceBtn.onClick(() => {
        const s = findComp.getValue(), r = replaceComp.getValue();
        if (!s) { new obsidian.Notice('Nothing to search for!'); return; }
        const w = !!wrapToggle.getValue();
        const result = doReplace(s, r, w);

        if (result === 'replaced' || result === 'replaced_wrapped') {
            addToHistory(settings, s, r);
            persist();
            if (result === 'replaced_wrapped') new obsidian.Notice('Wrapped around.');
        } else if (result === 'notfound') {
            focusEditor();
            new obsidian.Notice('No more matches.');
        } else if (result === 'noeditor') {
            new obsidian.Notice('No active editor.');
        }
    });

    replaceAllBtn.onClick(() => {
        const s = findComp.getValue(), r = replaceComp.getValue();
        if (!s) { new obsidian.Notice('Nothing to search for!'); return; }
        const w = !!wrapToggle.getValue();

        doReplaceAll(s, r, w);
    });

    // ── Keyboard shortcuts ────────────────────────────────────────────────

    findComp.inputEl.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            findNextBtn.buttonEl.click();
        } else if (e.key === 'Escape' && !opts.isModal) {
            persistWithHistory();
        }
    });

    replaceComp.inputEl.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            replaceAllBtn.buttonEl.click();
        } else if (e.key === 'Escape' && !opts.isModal) {
            persistWithHistory();
        }
    });

    // ── Prefill & restore ─────────────────────────────────────────────────

    const lastFind    = settings.findHistory[0]    != null ? settings.findHistory[0]    : '';
    const lastReplace = settings.replaceHistory[0] != null ? settings.replaceHistory[0] : '';

    if (opts.isModal && settings.prefillFind && opts.prefillSelection) {
        findComp.setValue(opts.prefillSelection);
        inSelToggle.setValue(false);
    } else {
        findComp.setValue(lastFind);
    }
    replaceComp.setValue(lastReplace);

    setTimeout(() => { findComp.inputEl.focus(); findComp.inputEl.select(); }, 50);


    const updateFlags = () => flagsPostfix.setText('/' + getRegexFlagsStr(settings));
    const destroy     = () => cleanups.forEach(fn => fn());

    return { destroy, persist, persistWithHistory, updateFlags };
}

// ── Modal ─────────────────────────────────────────────────────────────────────

class FindAndReplaceModal extends obsidian.Modal {
    constructor(app, editor, settings, plugin, prefillSelection) {
        super(app);
        this.editor           = editor;
        this.settings         = settings;
        this.plugin           = plugin;
        this.prefillSelection = prefillSelection || '';
        this._ui              = null;
        this._closed          = false;
    }

    onOpen() {
        const { contentEl, titleEl, modalEl } = this;
        modalEl.addClass('find-replace-modal');
        titleEl.setText('RegEx Find/Replace');
        this._closed = false;

        this._ui = buildFindReplaceUI(
            contentEl,
            () => this.editor,
            this.settings,
            this.plugin,
            {
                isModal:          true,
                prefillSelection: this.prefillSelection,
                onClose:          () => { this._closed = true; this.close(); }
            }
        );
    }

    onClose() {
        if (this._ui) {
            if (!this._closed) {
                this._ui.persistWithHistory();
            }
            this._ui.destroy();
            this._ui = null;
        }
        this.contentEl.empty();
    }
}

// ── Side Panel View ───────────────────────────────────────────────────────────

class FindAndReplaceView extends obsidian.ItemView {
    constructor(leaf, settings, plugin) {
        super(leaf);
        this.settings       = settings;
        this.plugin         = plugin;
        this._ui            = null;
        this._unsubSettings = null;
    }

    getViewType()    { return VIEW_TYPE_REGEX_REPLACE; }
    getDisplayText() { return 'RegEx Find/Replace'; }
    getIcon()        { return 'search'; }

    async onOpen() {
        const container = this.contentEl;
        container.empty();
        container.addClass('find-replace-view');

        this._ui = buildFindReplaceUI(
            container,
            () => {
                const v = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
                return v ? v.editor : (this.plugin.lastActiveEditor || null);
            },
            this.settings,
            this.plugin,
            { isModal: false }
        );

        this._unsubSettings = this.plugin.addSettingsListener(() => {
            if (this._ui) this._ui.updateFlags();
        });
    }

    async onClose() {
        if (this._unsubSettings) { this._unsubSettings(); this._unsubSettings = null; }
        if (this._ui)            { this._ui.destroy();    this._ui = null; }
    }
}

// ── Plugin ────────────────────────────────────────────────────────────────────

class RegexFindReplacePlugin extends obsidian.Plugin {
    onload() {
        return __awaiter(this, void 0, void 0, function* () {
            logger('Loading Plugin...', 9);
            yield this.loadSettings();

            this._settingsListeners = [];
            this.lastActiveEditor   = null;

            this.registerEvent(
                this.app.workspace.on('active-leaf-change', leaf => {
                    if (leaf && leaf.view instanceof obsidian.MarkdownView) {
                        this.lastActiveEditor = leaf.view.editor;
                    }
                })
            );

            // Initialize lastActiveEditor on startup so it is available
            this.app.workspace.onLayoutReady(() => {
                if (this.lastActiveEditor) return;
                this.app.workspace.iterateAllLeaves(leaf => {
                    if (!this.lastActiveEditor && leaf.view instanceof obsidian.MarkdownView) {
                        this.lastActiveEditor = leaf.view.editor;
                    }
                });
            });

            this.registerView(
                VIEW_TYPE_REGEX_REPLACE,
                leaf => new FindAndReplaceView(leaf, this.settings, this)
            );

            this.addSettingTab(new RegexFindReplaceSettingTab(this.app, this));

            this.addCommand({
                id:   'obsidian-regex-replace',
                name: 'Open Find and Replace (popup)',
                callback: () => {
                    const mdView = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
                    const editor = mdView ? mdView.editor : (this.lastActiveEditor || null);
                    if (!editor) {
                        new obsidian.Notice('No active editor.');
                        return;
                    }

                    const sel = editor.getSelection();
                    const prefill = this.settings.prefillFind && sel && sel.indexOf('\n') < 0
                        ? sel
                        : '';
                    new FindAndReplaceModal(this.app, editor, this.settings, this, prefill).open();
                },
            });

            this.addCommand({
                id:       'obsidian-regex-replace-panel',
                name:     'Open Find and Replace (side panel)',
                callback: () => { this.activateView(); },
            });

            this.addRibbonIcon('search', 'RegEx Find/Replace', () => { this.activateView(); });
        });
    }

    onunload() { logger('Bye!', 9); }

    addSettingsListener(fn) {
        this._settingsListeners = this._settingsListeners || [];
        this._settingsListeners.push(fn);
        return () => { this._settingsListeners = this._settingsListeners.filter(f => f !== fn); };
    }

    notifySettingsChange() {
        (this._settingsListeners || []).forEach(fn => fn());
    }

    async activateView() {
        const { workspace } = this.app;
        const leaves = workspace.getLeavesOfType(VIEW_TYPE_REGEX_REPLACE);
        let leaf;
        if (leaves.length > 0) {
            leaf = leaves[0];
        } else {
            leaf = workspace.getRightLeaf(false);
            if (!leaf) return;
            await leaf.setViewState({ type: VIEW_TYPE_REGEX_REPLACE, active: true });
        }
        workspace.revealLeaf(leaf);
    }

    loadSettings() {
        return __awaiter(this, void 0, void 0, function* () {
            const loaded = yield this.loadData();
            this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);

            this.settings.findHistory    = Array.isArray(loaded && loaded.findHistory)
                ? [...loaded.findHistory] : [];
            this.settings.replaceHistory = Array.isArray(loaded && loaded.replaceHistory)
                ? [...loaded.replaceHistory] : [];

            if (typeof this.settings.regexFlags !== 'object' || !this.settings.regexFlags) {
                this.settings.regexFlags = Object.assign({}, DEFAULT_SETTINGS.regexFlags);
            }

            this.settings.wrapAround = Boolean(this.settings.wrapAround);
            this.settings.selOnly    = Boolean(this.settings.selOnly);

            if (this.settings.selOnly && this.settings.wrapAround) {
                this.settings.selOnly    = false;
                this.settings.wrapAround = false;
            }

            ['findText', 'replaceText', 'useRegEx', 'caseInsensitive',
             'processLineBreak', 'processTab'].forEach(k => delete this.settings[k]);
        });
    }

    saveSettings() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.saveData(this.settings);
        });
    }
}

// ── Settings Tab ──────────────────────────────────────────────────────────────

class RegexFindReplaceSettingTab extends obsidian.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'RegEx Quick Reference' });

        const table = containerEl.createDiv({ cls: 'regex-help' }).createEl('table', { cls: 'regex-help-table' });
        [
            ['.', 'Any character (flag \s allows . to also mark a newline'],
            ['\\d  \\w  \\s', 'Digit · Word character · Whitespace'],
            ['\\D  \\W  \\S', 'Inverse of \\d  \\w  \\s'],
            ['\\b', 'Word boundary'],
            ['\\n  \\t', 'Newline · Tab'],
            ['^  $', 'Start/End of line/document (flag /m changes between line and document)'],
            ['[abc]', 'Character class: matches a, b, or c'],
            ['[^abc]', 'Inverted character class: matches anything except a, b, c'],
            ['(abc)', 'Capturing group: reference in Replace with \\1 or $1 to cut and paste'],
            ['(?:abc)', 'Non-capturing group: groups without a back-reference'],
            ['a|b', 'Alternation: matches a or b'],
            ['*  +  ?', 'Zero-or-more · One-or-more · Optional  (greedy by default, append ? to make lazy)'],
            ['{n}', 'Has n repetitions'],
            ['{n,m}', 'Between n and m repetitions'],
        ].forEach(([pattern, desc]) => {
            const tr = table.createEl('tr');
            tr.createEl('td', { cls: 'regex-help-pattern', text: pattern });
            tr.createEl('td', { text: desc });
        });

        containerEl.createEl('h2', { text: 'Settings' });

        new obsidian.Setting(containerEl)
            .setName('Prefill find field from selection')
            .setDesc('Copy the currently selected text (single-line only) into the Find field when opening the popup.')
            .addToggle(t => t
                .setValue(this.plugin.settings.prefillFind)
                .onChange((v) => __awaiter(this, void 0, void 0, function* () {
                    this.plugin.settings.prefillFind = v;
                    yield this.plugin.saveSettings();
                })));

        containerEl.createEl('h4', { text: 'History' });

        new obsidian.Setting(containerEl)
            .setName('Max history entries')
            .setDesc('Number of recent searches to remember. ↑ / ↓ in the input fields to cycle; or click ▾. Set to 0 to disable.')
            .addSlider(s => s
                .setLimits(0, 50, 5)
                .setValue(this.plugin.settings.maxHistory != null ? this.plugin.settings.maxHistory : 10)
                .setDynamicTooltip()
                .onChange((v) => __awaiter(this, void 0, void 0, function* () {
                    this.plugin.settings.maxHistory = v;
                    yield this.plugin.saveSettings();
                })));

        new obsidian.Setting(containerEl)
            .setName('Clear history')
            .setDesc('Permanently delete all saved search/replace history entries.')
            .addButton(b => b
                .setButtonText('Clear')
                .setWarning()
                .onClick(() => __awaiter(this, void 0, void 0, function* () {
                    this.plugin.settings.findHistory    = [];
                    this.plugin.settings.replaceHistory = [];
                    yield this.plugin.saveSettings();
                    new obsidian.Notice('History cleared.');
                })));

        containerEl.createEl('h4', { text: 'Regex Flags' });

        [
            { key: 'g', name: 'g — Global',
              desc: 'Find all matches in the document.' },
            { key: 'i', name: 'i — Ignore case',
              desc: 'Case-insensitive matching' },
            { key: 'm', name: 'm — Multiline',
              desc: '^ and $ match the start/end of each line instead of the whole document.' },
            { key: 'u', name: 'u — Unicode',
              desc: 'Full Unicode support. Required for correct matching of CJK characters and emoji.' },
            { key: 's', name: 's — Dot All',
              desc: 'Makes . match newline characters too (by default . does not cross line boundaries).' },
            { key: 'y', name: 'y — Sticky',
              desc: 'Matches only at the exact position of lastIndex.' },
        ].forEach(({ key, name, desc }) => {
            new obsidian.Setting(containerEl)
                .setName(name)
                .setDesc(desc)
                .addToggle(t => t
                    .setValue(this.plugin.settings.regexFlags && this.plugin.settings.regexFlags[key] != null
                        ? this.plugin.settings.regexFlags[key]
                        : (DEFAULT_SETTINGS.regexFlags[key] || false))
                    .onChange((v) => __awaiter(this, void 0, void 0, function* () {
                        if (!this.plugin.settings.regexFlags) this.plugin.settings.regexFlags = {};
                        this.plugin.settings.regexFlags[key] = v;
                        yield this.plugin.saveSettings();
                        this.plugin.notifySettingsChange();
                    })));
        });
    }
}

module.exports = RegexFindReplacePlugin;