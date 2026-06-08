'use strict';

/*! *****************************************************************************
Copyright (c).

Permission to use, copy, modify, and/or distribute this software for free is
hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
***************************************************************************** */

var obsidian = require('obsidian');

// ── Constants ──────────────────────────────────────────────────────────────

const VIEW_TYPE_REGEX_REPLACE = 'regex-find-replace-view';

const DEFAULT_SETTINGS = {
	selOnly:             false,
	wrapAround:          true,
	prefillFind:         false,
	findReplaceInFiles:  false,
	showRibbonIcon:      true,
	showQuickRef:        true,
	showMatchDisplay:    true,
	logToConsole:        false,
	findHistory:         [],
	replaceHistory:      [],
	pathHistory:         [],
	maxHistory:          10,
	regexFlags:          { i: false, m: true, u: true, v: false, s: false},
	unicodeN:            false,
	findZeroLen:         false
};

// ── CM6 Search-Match Highlight ─────────────────────────────────────────────

let _hlAddEff            = null;  // StateEffect: set highlight to [from, to]
let _hlClearEff          = null;  // StateEffect: remove all highlights
let _hlField             = null;  // StateField that owns the Decoration range-set
let _hlAppendConfig      = null;  // StateEffect.appendConfig reference
let _hlPrec              = null;  // Prec.highest: gives field top decoration priority
let _foldedRanges        = null;  // RangeSet of currently folded ranges
let _unfoldEffect        = null;  // StateEffect to unfold a {from,to} range
let _ZeroWidthMarkerClass= null;  // WidgetType subclass for zero-length match indicator

(function () {
	try {
		const { StateEffect, StateField, Prec } = require('@codemirror/state');
		const { Decoration, EditorView, WidgetType } = require('@codemirror/view');

		_hlAddEff       = StateEffect.define();
		_hlClearEff     = StateEffect.define();
		_hlAppendConfig = StateEffect.appendConfig;
		_hlPrec         = Prec;

		// Inline widget rendered at a zero-length match position.
		class ZeroWidthMarker extends WidgetType {
			toDOM() {
				const el = document.createElement('span');
				el.className = 'frr-zero-match-marker';
				return el;
			}
			eq()          { return true;  } // all instances are identical
			ignoreEvent() { return true;  } // don't swallow mouse/keyboard events
		}
		_ZeroWidthMarkerClass = ZeroWidthMarker;

		_hlField = StateField.define({
			create: () => Decoration.none,
			update(deco, tr) {
				deco = deco.map(tr.changes); // keep position in sync with edits
				for (const ef of tr.effects) {
					if (ef.is(_hlClearEff)) return Decoration.none;
					if (ef.is(_hlAddEff)) {
						const { from, to, cls, type } = ef.value;
						const hlCls = cls || 'obsidian-search-match-highlight';

						if (type === 'line') {
							// Apply a line-level class to every line touched by the match.
							const decos    = [];
							const lineDeco = Decoration.line({ class: hlCls });
							let pos = from;
							while (pos <= to) {
								const line = tr.state.doc.lineAt(pos);
								decos.push(lineDeco.range(line.from));
								if (line.to >= to) break;
								pos = line.to + 1;
							}
							return Decoration.none.update({ add: decos, sort: true });

						} else if (type === 'widget' && _ZeroWidthMarkerClass) {
							// Insert a thin vertical-bar widget at the match position.
							const decos = [];
							decos.push(Decoration.widget({ widget: new _ZeroWidthMarkerClass(), side:  1 }).range(from));
							if (from !== to)
								decos.push(Decoration.widget({ widget: new _ZeroWidthMarkerClass(), side: -1 }).range(to));
							return Decoration.none.update({ add: decos, sort: true });

						} else {
							// Inline mark decoration for ordinary same-line matches.
							const mark = Decoration.mark({ class: hlCls });
							return Decoration.none.update({ add: [mark.range(from, to)] });
						}
					}
				}
				return deco;
			},
			provide: f => EditorView.decorations.from(f),
		});
	} catch (_) { console.log('[PoREs] CM6 not accessible: Falling back to focus-based highlight'); }

	// Fold utilities live in a separate package
	try {
		const cmLang = require('@codemirror/language');
		_foldedRanges = cmLang.foldedRanges;
		_unfoldEffect = cmLang.unfoldEffect;
	} catch (_) {}
}());

// ── Gutter highlight ───────────────────────────────────────────────────────

// DOM references to currently highlighted gutter number elements
let _hlGutterEls = [];

// Remove the frr-gutter-highlight class from all previously tagged gutter cells
function hlClearGutter() {
	_hlGutterEls.forEach(el => el.classList.remove('frr-gutter-highlight'));
	_hlGutterEls = [];
}

// Highlight gutter line-number cells that contain matches
function hlSetGutter(cm, from, to) {
	hlClearGutter();
	if (!cm) return;
	requestAnimationFrame(() => {
		try {
			const lineFrom = cm.state.doc.lineAt(from).number;
			const lineTo   = cm.state.doc.lineAt(to === from ? from : to - 1).number; // to is exclusive; clamp for zero-len
			cm.dom.querySelectorAll('.cm-lineNumbers .cm-gutterElement').forEach(el => {
				const n = parseInt(el.textContent.trim(), 10);
				if (!isNaN(n) && n >= lineFrom && n <= lineTo) {
					el.classList.add('frr-gutter-highlight');
					_hlGutterEls.push(el);
				}
			});
		} catch (_) {}
	});
}

// Remove the highlight decoration from the given CM6 EditorView.
function hlClear(cm) {
	hlClearGutter();
	if (!_hlClearEff || !cm) return;
	if (!_hlField || cm.state.field(_hlField, false) === undefined) return;
	try { cm.dispatch({ effects: _hlClearEff.of(null) }); } catch (_) {}
}

// Set the CM6 selection to [from, to] and apply the highlight decoration in one atomic transaction
function hlSet(cm, from, to, cls, type) {
	if (!_hlField || !cm) return false;
	try {
		if (cm.state.field(_hlField, false) === undefined) {
			const ext = _hlPrec ? _hlPrec.highest(_hlField) : _hlField;
			cm.dispatch({ effects: _hlAppendConfig.of(ext) });
		}
		const effects = [_hlAddEff.of({ from, to, cls: cls || null, type: type || 'mark' })];

		// Bundle unfolds for standard folds (Some folds are managed in Obsidian's own internal state and are not expanded here)
		if (_foldedRanges && _unfoldEffect) {
			try {
				const iter = _foldedRanges(cm.state).iter();
				while (iter.value !== null) {
					if (iter.from <= from && iter.to >= to)
						effects.push(_unfoldEffect.of({ from: iter.from, to: iter.to }));
					iter.next();
				}
			} catch (_) {}
		}
		cm.dispatch({ selection: { anchor: from, head: to }, effects, scrollIntoView: true });
		return true;
	} catch (_) { return false; }
}

// ── Pure helpers ───────────────────────────────────────────────────────────

function pluralize(word, count, suffix) {
	return count === 1 ? `${count} ${word}` : `${count} ${word}${suffix}`;
}

function debounce(fn, delay) {
	let timer;
	return function (...args) {
		clearTimeout(timer);
		timer = setTimeout(() => fn.apply(this, args), delay);
	};
}

function skipZeroLen(text, idx) {
	// Advance past a zero-length match by a full Unicode code point
	const cp = text.codePointAt(idx);
	return idx + (cp !== undefined && cp > 0xFFFF ? 2 : 1);
};

function getRegexFlagsStr(settings) {
	const f = settings.regexFlags || {};
	return ['i', 'm', 'u', 'v', 's'].filter(k => f[k]).join('');
}

function buildFlags(settings) {
	return 'g' + getRegexFlagsStr(settings);
}

function buildFlagsNoG(settings) {
	return getRegexFlagsStr(settings);
}

function buildRegex(search, settings, { global = true, noticeOnError = true } = {}) {
	const flags = global ? buildFlags(settings) : buildFlagsNoG(settings);
	try {
		const namedGroupMap = buildNamedGroupMap(search);
		const preprocessed  = preprocessPattern(search, namedGroupMap);
		const uniSearch = (flags.includes('u') || flags.includes('v'))
			? unicodifyBoundaries(preprocessed, settings.unicodeN, flags.includes('v'))
			: preprocessed;
		return { re: new RegExp(uniSearch, flags), uniSearch, flags, namedGroupMap };
	} catch (e) {
		if (noticeOnError) notice(settings, 'Invalid regex: ' + e.message);
		return null;
	}
}

function buildNamedGroupMap(pattern) {
	const map = {};
	let index = 0;
	let i = 0;
	while (i < pattern.length) {
		if (pattern[i] === '\\') { i += 2; continue; }
		if (pattern[i] === '(') {
			index++;
			if (pattern.slice(i, i + 3) === '(?<' && pattern[i + 3] !== '=' && pattern[i + 3] !== '!') {
				const close = pattern.indexOf('>', i + 3);
				if (close !== -1) map[pattern.slice(i + 3, close)] = index;
			}
		}
		i++;
	}
	return map;
}

function preprocessPattern(pattern, namedGroupMap) {
	let result = '';
	let i = 0;
	while (i < pattern.length) {
		if (pattern[i] === '\\') {
			result += pattern[i] + (pattern[i + 1] ?? '');
			i += 2;
		} else if (pattern[i] === '$') {
			const next = pattern[i + 1];
			if (next >= '1' && next <= '9') {
				let numStr = '';
				let j = i + 1;
				while (j < pattern.length && pattern[j] >= '0' && pattern[j] <= '9') numStr += pattern[j++];
				result += '\\' + numStr;
				i = j;
			} else if (next === '0') {
				result += '\\0';
				i += 2;
			} else if (next === '<') {
				// Replace named group with numbered group
				const close = pattern.indexOf('>', i + 2);
				if (close !== -1) {
					const name = pattern.slice(i + 2, close);
					const num  = namedGroupMap[name];
					result += num !== undefined ? `\${${num}}` : '$<' + name + '>';
					i = close + 1;
				} else { result += '$'; i++; }
			} else { result += '$'; i++; }
		} else { result += pattern[i++]; }
	}
	return result;
}

const readNum = (str, pos) => {
	let numStr = '';
	while (pos < str.length && str[pos] >= '0' && str[pos] <= '9') numStr += str[pos++];
	return numStr;
};

// ── collect matches ────────────────────────────────────────────────────────

function collectMatches(docText, re, from = 0, findZeroLen = false) {
	const matches = [];
	let skipped = 0;
	re.lastIndex = from;
	let match;
	while ((match = re.exec(docText)) !== null) {
		if (match[0].length === 0) {
			re.lastIndex = skipZeroLen(docText, match.index);
			if (findZeroLen) {
				matches.push({
					from:   match.index,
					to:     match.index,
					groups: match.slice(1),
					match:  match[0]
				});
			} else {
				skipped++;
			}
		} else {
			matches.push({
				from:   match.index,
				to:     match.index + match[0].length,
				groups: match.slice(1),
				match:  match[0]
			});
		}
	}
	return { matches, skipped };
}

function collectMatchesInScope(docText, re, scopes, findZeroLen = false, originalSearch = null) {
	const matches = [];
	let skipped   = 0;
	const flags   = re.flags;

	// Use Unicode-aware word-char detection for prefix/suffix
	const isWC    = c => (flags.includes('u') || flags.includes('v')) ? _UW.test(c) : /\w/.test(c);

	for (const scope of scopes) {
		const scopeText   = docText.slice(scope.from, scope.to);
		const prevDocChar = scope.from > 0 ? docText[scope.from - 1] : '';
		const nextDocChar = scope.to < docText.length ? docText[scope.to] : '';

		// 1-char prefix for correct \b / ^ context at selection start
		const prefix = prevDocChar !== '' ? prevDocChar : '\n';
		const padded = prefix + scopeText;
		const pfxLen = 1;

		// patch \b at end of pattern if selection ends mid-word.
		let scopeSource = re.source;
		const boundaryCheckSource = originalSearch ?? re.source;

		// Only needed when the selection ends mid-word in the document
		if (patternEndsWithBoundary(boundaryCheckSource) && isWC(nextDocChar) && scopeText.length > 0 && isWC(scopeText[scopeText.length - 1])) {
			const lastIdx = scopeSource.lastIndexOf(_UWB);
			if (lastIdx >= 0) {
				// /u on: Patch the expanded \b lookaround equivalent
				scopeSource = scopeSource.slice(0, lastIdx + _UWB.length) + '(?!$)' +
							  scopeSource.slice(lastIdx + _UWB.length);
			} else {
				// /u off: Patch the last native \b directly.
				const nativeBIdx = scopeSource.lastIndexOf('\\b');
				if (nativeBIdx >= 0) {
					scopeSource = scopeSource.slice(0, nativeBIdx + 2) + '(?!$)' +
								  scopeSource.slice(nativeBIdx + 2);
				}
			}
		}

		const scopeRe = new RegExp(scopeSource, flags);

		// collect matches in padded text then convert to absolute positions
		const { matches: paddedMatches, skipped: paddedSkipped } = collectMatches(padded, scopeRe, pfxLen, findZeroLen);
		skipped += paddedSkipped;

		for (const m of paddedMatches) {
			matches.push({
				...m,
				from: scope.from + (m.from - pfxLen),
				to:   scope.from + (m.to   - pfxLen),
			});
		}
	}

	return { matches, skipped };
}

function makeReplacer(rawReplStr) {
	return function (...all) {
		let offsetIdx = 1;
		while (offsetIdx < all.length && typeof all[offsetIdx] !== 'number') offsetIdx++;
		const groups = all.slice(1, offsetIdx);

		let result = '';
		let i = 0;
		while (i < rawReplStr.length) {
			if (rawReplStr[i] === '\\') {
				const next = rawReplStr[i + 1];
				i += 2;
				if      (next === 'n')                 result += '\n';   // line break
				else if (next === 't')                 result += '\t';   // tab
				else if (next === '\\')                result += '\\';   // backslash 
				else if (next === '0')                 result += all[0]; // entire match
				else if (next >= '1' && next <= '9') {
					const numStr = next + readNum(rawReplStr, i + 1);
					const g = groups[+numStr - 1];     result += g !== undefined ? g : '';
					i += numStr.length - 1;
				} else if (next !== undefined)         result += next;   // normalize character
				else                                   result += '\\';   // lone trailing \ 
			} else if (rawReplStr[i] === '$' && rawReplStr[i + 1] === '{') {
				const numStr = readNum(rawReplStr, i + 2);
				let j = i + 2 + numStr.length;
				if (numStr.length > 0 && rawReplStr[j] === '}') {
					if (numStr === '0')                result += all[0]; // special character group
					else { const g = groups[+numStr-1];result += g !== undefined ? g : ''; }
					i = j + 1;
				} else { i++;                          result += '$'; }  // normal $
			}
			
			else result += rawReplStr[i++];
		}
		return result;
	};
}

function isExactMatch(text, re) {
	if (!text || !re) return false;
	try {
		const m = re.exec(text);
		return m !== null && m.index === 0 && m[0].length === text.length;
	} catch (_) { return false; }
}

// Manages History: deduplicates, evicts enpty strings, and prepends val
function _pushHistory(arr, val, maxH) {
	const i = arr.indexOf(val);
	if (i > -1) arr.splice(i, 1);
	if (val !== '' && arr[0] === '') arr.shift(); // evict a leading empty-string placeholder when a real value arrives
	arr.unshift(val);
	if (arr.length > maxH) arr.pop();
}

function addToHistory(settings, { find = '', replace = '', path = '', saveReplace = false, savePath = false } = {}) {
	const maxH = settings.maxHistory || 0;
	if (maxH === 0) return;
	_pushHistory(settings.findHistory,    find,    maxH);
	if (saveReplace) _pushHistory(settings.replaceHistory, replace, maxH);
	if (savePath)    _pushHistory(settings.pathHistory,    path,    maxH);
}

// Trim all history arrays to maxHistory
function trimHistories(settings) {
	const maxH = settings.maxHistory;
	if (maxH <= 0) return;
	['findHistory', 'replaceHistory', 'pathHistory'].forEach(k => {
		if (settings[k] && settings[k].length > maxH)
			settings[k] =  settings[k].slice(0, maxH);
	});
}

// ── Logger ─────────────────────────────────────────────────────────────────

function logMsg(settings, ...args) {
	if (settings && settings.logToConsole) console.log('[PoREs]', ...args);
}

// Wraps obsidian.Notice; also logs to console when logToConsole is enabled.
function notice(settings, msg) {
	new obsidian.Notice(msg);
	if (settings && settings.logToConsole) console.log('[PoREs]', msg);
}

// ── Word-boundary pattern helpers ──────────────────────────────────────────

// Must end with b or B
function patternEndsWithBoundary(pat) {
	let i = pat.length - 1;
	while (i >= 0 && pat[i] === ')') i--; // skip trailing close-parens
	if (i < 0 || (pat[i] !== 'b' && pat[i] !== 'B')) return false;
	i--;
	let bs = 0;
	while (i >= 0 && pat[i] === '\\') { bs++; i--; }
	return bs % 2 === 1; // ignores an escaped \b
}

// ── Unicode word-boundary helpers ──────────────────────────────────────────

// Unicode-aware word-character test, used for prefix/suffix context detection.
const _UW = /[\p{L}\p{N}_]/u;

// Replacement strings for \b and \B (valid only inside a /u or /v regex).
const _UWB  = String.raw`(?:(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_]))`;
const _UNWB = String.raw`(?:(?<=[\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<![\p{L}\p{N}_])(?![\p{L}\p{N}_]))`;

// Only called, when the /u or /v flag is active
function unicodifyBoundaries(pat, unicodeN, isV) {
	let result = '';
	let i = 0;
	while (i < pat.length) {
		if (pat[i] === '[') {
			// \w → \p{L}\p{N}_
			// \d → \p{N}
			// \b/\B → unicode word boundary
			result += '[';
			i++;
			while (i < pat.length) {
				if (pat[i] === '\\') {
					const bsStart = i;
					while (i < pat.length && pat[i] === '\\') i++;
					const bsCount = i - bsStart;
					const next    = i < pat.length ? pat[i] : '';
					if          (bsCount % 2 === 1)         { result += pat.slice(bsStart,  bsStart + bsCount - 1);
						if      (next === 'w')              { result += '\\p{L}\\p{N}_';    i++; }
						else if (next === 'W') {
							// With /v, nested character classes are valid
							// With /u only, there is no way to nest [^\p{L}\p{N}_] inside a class.
							if  (isV)                       { result += '[^\\p{L}\\p{N}_]'; i++; }
							else throw new Error('\\W inside a character class produces ASCII-only results with the /u flag. Use the /v flag, or rewrite as [^\\w].');
						}
						else if (next === 'd' && unicodeN)  { result += '\\p{N}';           i++; }
						else if (next === 'D' && unicodeN)  { result += '\\P{N}';           i++; }
						else                                { result += pat.slice(bsStart + bsCount - 1, i);
							if  (next)                      { result += next;               i++; }
						}
					} else                                  { result += pat.slice(bsStart,  i);
						// Don't consume ']' here, let the outer else-if branch close the class.
						if      (next && next !== ']')      { result += next;               i++; }
					}
				} else if       (pat[i] === ']')            { result += ']';                i++; break; }
				else                                        { result += pat[i++]; }
			}
		} else if (pat[i] === '\\') {
			// Outside a character class
			const bsStart = i;
			while (i < pat.length && pat[i] === '\\') i++;
			const bsCount = i - bsStart;
			const next    = i < pat.length ? pat[i] : '';
			if          (bsCount % 2 === 1)                 { result += pat.slice(bsStart,  bsStart + bsCount - 1);
				if      (next === 'b')                      { result += _UWB;               i++; }
				else if (next === 'B')                      { result += _UNWB;              i++; }
				else if (next === 'w')                      { result += '[\\p{L}\\p{N}_]';  i++; }
				else if (next === 'W')                      { result += '[^\\p{L}\\p{N}_]'; i++; }
				else if (next === 'd' && unicodeN)          { result += '\\p{N}';           i++; }
				else if (next === 'D' && unicodeN)          { result += '\\P{N}';           i++; }
				else                                        { result += pat.slice(bsStart + bsCount - 1, i);
					if  (next)                              { result += next;               i++; }
				}
			} else                                          { result += pat.slice(bsStart,  i);
					if  (next)                              { result += next;               i++; }
			}
		} else                                              { result += pat[i++];                }
	}
	return result;
}

// ── Confirm Modal ──────────────────────────────────────────────────────────

class ConfirmModal extends obsidian.Modal {
	constructor(app, message, onConfirm) {
		super(app);
		this.message   = message;
		this.onConfirm = onConfirm;
	}
	onOpen() {
		const { contentEl } = this;
		this.modalEl.addClass('frr-confirm-modal');
		contentEl.createEl('p', { cls: 'frr-confirm-msg', text: this.message });
		const row = contentEl.createDiv({ cls: 'frr-confirm-row' });
		new obsidian.ButtonComponent(row).setButtonText('Cancel').onClick(() => this.close());
		new obsidian.ButtonComponent(row).setButtonText('Proceed').setCta()
			.onClick(() => { this.close(); this.onConfirm(); });
	}
	onClose() { this.contentEl.empty(); }
}

// ── Shared UI builder ──────────────────────────────────────────────────────

// Builds the complete Find/Replace UI
//
// opts fields:
//   isModal             {boolean}   – hosted inside a Modal vs side panel
//   prefillSelection    {string}    – pre-fill Find field on open (modal only)
//   onClose             {function}  – close the hosting modal after Replace All
//   fileResults         {array}     – previous find-in-files results to restore ({path,count}[])
//   onFileResultsChange {function}  – called with the updated results whenever they change
//   fileStatus          {object}    – previous file operation status to restore
//   onFileStatusChange  {function}  – called when file status changes

function buildFindReplaceUI(containerEl, getEditor, settings, plugin, opts) {
	opts = opts || {};

	let selScopes       = null; // array of {from, to}
	let lastHighlight   = null; // {from, to} absolute offsets of the last decorated match
	let findHistIdx     = -1;
	let findDraft       = null; // typed value saved before arrow-key navigation begins
	let replaceHistIdx  = -1;
	let replaceDraft    = null;
	let pathHistIdx     = -1;
	let pathDraft       = null;
	const cleanups      = [];
	const allCloseDrops = [];
	const arrowUpdaters = [];

	// ── Match display ──────────────────────────────────────────────────────

	let matchDisplayEl = null;
	let matchLabelEl   = null;
	let matchTextEl    = null;

	containerEl.createEl('h3', { cls: 'frr-match-panel-header', text: 'Power of RegEx search' });
	matchDisplayEl = containerEl.createDiv({ cls: 'frr-match-display' });
	matchDisplayEl.style.display = settings.showMatchDisplay !== false ? '' : 'none';
	matchLabelEl = matchDisplayEl.createDiv({ cls: 'frr-match-label' });
	matchLabelEl.setText('—');
	matchTextEl = matchDisplayEl.createDiv({ cls: 'frr-match-display-text' });
	matchTextEl.style.height    = '52px';
	matchTextEl.style.minHeight = '52px';

	// ── History input helper ───────────────────────────────────────────────

	function addHistoryInput(label, placeholder, getHistory, getIdx, setIdx, getDraft, setDraft, getAutocomplete) {
		const row = containerEl.createDiv({ cls: 'frr-row' });
		row.createDiv({ cls: 'frr-label' }).setText(label);

		const wrapper = row.createDiv({ cls: 'frr-input-wrapper' });
		const comp    = new obsidian.TextComponent(wrapper);
		comp.setPlaceholder(placeholder);

		const arrowBtn = wrapper.createEl('button', { cls: 'frr-history-btn' });
		arrowBtn.setText('▾');
		arrowBtn.setAttribute('aria-label', 'Show history');
		arrowBtn.setAttribute('type', 'button');
		arrowBtn.setAttribute('tabindex', '-1');

		const histDropdown = wrapper.createDiv({ cls: 'frr-dropdown' });

		// Path suggestions in dropdown
		const suggDropdown = getAutocomplete ? wrapper.createDiv({ cls: 'frr-suggestions' }) : null;
		if (suggDropdown) suggDropdown.style.display = 'none';
		let activeSugIdx = -1;

		const closeHist = () => { histDropdown.style.display = 'none'; };
		const closeSugg = () => {
			if (suggDropdown) { suggDropdown.style.display = 'none'; activeSugIdx = -1; }
		};

		// Register closers so any open() call can close every other dropdown first
		allCloseDrops.push(closeHist);
		if (suggDropdown) allCloseDrops.push(closeSugg);

		const updateArrow = () => {
			const hist = getHistory().filter(i => i !== '');
			arrowBtn.style.display = (settings.maxHistory > 0 && hist.length > 0) ? '' : 'none';
		};
		updateArrow();
		arrowUpdaters.push(updateArrow);

		// ── Open history dropdown ──────────────────────────────────────────

		const openHist = () => {
			allCloseDrops.forEach(fn => { if (fn !== closeHist) fn(); });

			histDropdown.empty();
			const hist = getHistory().filter(i => i !== '');
			if (!hist.length) { closeHist(); return; }

			hist.forEach(item => {
				const itemRow = histDropdown.createDiv({ cls: 'frr-dropdown-item' });

				const lbl = itemRow.createSpan({ cls: 'frr-dropdown-label' });
				lbl.setText(item);
				lbl.setAttribute('title', item); // full text on hover for truncated entries
				lbl.addEventListener('mousedown', e => {
					e.preventDefault();
					if (getIdx() === -1) setDraft(comp.getValue()); // save draft before overwriting with a history entry
					const histArr = getHistory().filter(i => i !== '');
					const itemIdx = histArr.indexOf(item);
					comp.setValue(item);
					setIdx(itemIdx >= 0 ? itemIdx : -1);
					closeHist();
					comp.inputEl.focus();
				});

				// Remove single history entry with x button
				const xBtn = itemRow.createEl('button', { cls: 'frr-dropdown-x', text: '×' });
				xBtn.setAttribute('type', 'button');
				xBtn.setAttribute('tabindex', '-1');
				xBtn.setAttribute('aria-label', 'Remove entry');
				xBtn.addEventListener('mousedown', e => {
					e.preventDefault();
					e.stopPropagation();
					logMsg(settings, '[History] Deleted entry:', item);
					const arr          = getHistory();
					// Compute filtered index NOW, at click time, not at render time
					const filteredHist = arr.filter(i => i !== '');
					const deletedIdx   = filteredHist.indexOf(item);

					const rawIdx = arr.indexOf(item);
					if (rawIdx > -1) arr.splice(rawIdx, 1);

					const currentIdx = getIdx();
					if (currentIdx !== -1) {
						if (deletedIdx === currentIdx) {
							setIdx(-1);
						} else if (deletedIdx < currentIdx) {
							const newIdx  = currentIdx - 1;
							const newHist = arr.filter(i => i !== '');
							setIdx(newIdx);
							comp.inputEl.value = newHist[newIdx] ?? '';
						}
					}

					plugin.saveSettings();
					const remaining = arr.filter(i => i !== '');
					if (remaining.length > 0) openHist(); else closeHist();
					updateArrow();
				});
			});

			histDropdown.style.display = 'block';
		};

		// ── Open suggestion dropdown (path autocomplete) ───────────────────

		const openSugg = (suggs) => {
			if (!suggDropdown) return;
			allCloseDrops.forEach(fn => { if (fn !== closeSugg) fn(); });

			suggDropdown.empty();
			activeSugIdx = -1;

			suggs.forEach(s => {
				const item = suggDropdown.createDiv({ cls: 'frr-suggestion-item' });
				item.setText(s);
				item.setAttribute('title', s);
				item.addEventListener('mousedown', e => {
					e.preventDefault();
					comp.setValue(s);
					closeSugg();
					comp.inputEl.focus();
				});
			});
			suggDropdown.style.display = 'block';
		};

		arrowBtn.addEventListener('click', e => {
			e.stopPropagation();
			histDropdown.style.display === 'none' ? openHist() : closeHist();
		});

		// Close all dropdowns when clicking anywhere outside this wrapper
		const outsideHandler = e => { if (!wrapper.contains(e.target)) { closeHist(); closeSugg(); } };
		document.addEventListener('click', outsideHandler);
		cleanups.push(() => document.removeEventListener('click', outsideHandler));

		// Close when focus leaves the wrapper entirely (covers Tab navigation)
		wrapper.addEventListener('focusout', e => {
			if (!e.relatedTarget || !wrapper.contains(e.relatedTarget)) {
				closeHist(); closeSugg();
			}
		});

		// ── Keyboard navigation ────────────────────────────────────────────

		comp.inputEl.addEventListener('keydown', e => {

			// Up/Down arrows cycle through history
			if (settings.maxHistory > 0) {
				const hist = getHistory().filter(i => i !== '');
				if (e.key === 'ArrowDown') {
					e.preventDefault();
					if (!hist.length) return;
					if (getIdx() === -1) setDraft(comp.getValue()); // save current input before leaving
					const ni = Math.min(getIdx() + 1, hist.length - 1);
					setIdx(ni); comp.setValue(hist[ni]);
				} else if (e.key === 'ArrowUp') {
					e.preventDefault();
					const ni = getIdx() - 1;
					if (ni < 0) { setIdx(-1); comp.setValue(getDraft() ?? comp.getValue()); } // restore draft
					else        { setIdx(ni); comp.setValue(hist[ni]); }
				}
			}
			if (e.key === 'Tab') { closeHist(); closeSugg(); }
		});

		// Reset history index whenever the user edits the field manually
		comp.inputEl.addEventListener('input', () => { setIdx(-1); setDraft(null); });

		// Trigger path suggestions while typing (debounced)
		if (getAutocomplete) {
			comp.inputEl.addEventListener('input', debounce(() => {
				const val = comp.getValue().trim();
				if (!val) { closeSugg(); return; }
				const suggs = getAutocomplete(val);
				if (suggs.length > 0) openSugg(suggs); else closeSugg();
			}, 150));
		}

		return { comp, row };
	}

	const getActiveFileName = () => {
		const ed = getEditor();
		if (!ed) return '—';
		try {
			const name = ed.getDoc?.().editorComponent?.file?.name;
			if (name) return name;
		} catch (_) {}
		// Fallback
		try { if (ed.file?.name) return ed.file.name; } catch (_) {}
		return '—';
	};

	const clearHighlight = (cm) => {
		hlClear(cm);
		if (matchLabelEl) matchLabelEl.setText(getActiveFileName());
		if (matchTextEl)  matchTextEl.setText('');
	};

	// ── Find / Replace rows ───────────────────────────────────────────────

	const { comp: findComp, row: findRow } = addHistoryInput(
		'Find:', 'e.g. (\\w+)',
		() => settings.findHistory,
		() => findHistIdx, v => { findHistIdx = v; },
		() => findDraft, v => { findDraft = v; }
	);
	const flagsPostfix = findRow.createDiv({ cls: 'frr-postfix' });
	flagsPostfix.setText('/g' + getRegexFlagsStr(settings));

	const { comp: replaceComp } = addHistoryInput(
		'Replace:', 'e.g. $1 or \\1',
		() => settings.replaceHistory,
		() => replaceHistIdx, v => { replaceHistIdx = v; },
		() => replaceDraft, v => { replaceDraft = v; }
	);

	// ── Toggle row ────────────────────────────────────────────────────────

	const toggleRowEl = containerEl.createDiv({ cls: 'frr-row frr-toggle-row' });

	const inSelGroup = toggleRowEl.createDiv({ cls: 'frr-toggle-group' });
	inSelGroup.createDiv({ cls: 'frr-toggle-label' }).setText('In selection');
	const inSelToggle = new obsidian.ToggleComponent(inSelGroup.createDiv({ cls: 'frr-toggle-wrap' }));
	inSelToggle.setTooltip('Restricts "Replace All" to the selected text.');
	inSelToggle.setValue(!!settings.selOnly);

	const wrapGroup = toggleRowEl.createDiv({ cls: 'frr-toggle-group' });
	wrapGroup.createDiv({ cls: 'frr-toggle-label' }).setText('Wrap around');
	const wrapToggle = new obsidian.ToggleComponent(wrapGroup.createDiv({ cls: 'frr-toggle-wrap' }));
	wrapToggle.setTooltip('Wrap the search around when reaching the end of the document.');
	wrapToggle.setValue(!!settings.wrapAround);

	// Capture all current editor selections into selScopes.
	const captureScope = () => {
		const ed = getEditor();
		if (!ed) { selScopes = null; return; }
		if (ed.getViewType?.()) { selScopes = null; return; } // canvas, image, PDF, etc.

		// CM6 path returns all ranges for multi-cursor selections.
		try {
			const cm = ed.cm;
			if (cm?.state?.selection?.ranges) {
				const nonEmpty = cm.state.selection.ranges.filter(r => r.from !== r.to);
				if (nonEmpty.length > 0) {
					const sorted = [...nonEmpty].sort((a, b) => a.from - b.from);
					selScopes = sorted.map(r => ({ from: r.from, to: r.to }));
					return;
				}
			}
		} catch (e) { logMsg(settings, "captureScope CM6 error:", e); }

		// Fallback: standard Obsidian API (single selection only)
		const from = ed.posToOffset(ed.getCursor('from'));
		const to   = ed.posToOffset(ed.getCursor('to'));
		selScopes = from < to ? [{ from, to }] : null;
	};

	// Capture scope when enabling so the selection is read while the editor still has focus
	inSelToggle.onChange(enabled => {
		logMsg(settings, '[Toggle] In selection:', enabled);
		if (enabled) captureScope();
		else selScopes = null; // clear it when disabled
	});
	wrapToggle.onChange(v => { logMsg(settings, '[Toggle] Wrap around:', v); });

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
		plugin.notifySettingsChange();
	};

	// Sync navigation state after saving history so arrow keys work correctly afterwards
	const afterHistorySaved = () => {
		findHistIdx = replaceHistIdx = pathHistIdx = 0;
		findDraft = replaceDraft = pathDraft = null;
		arrowUpdaters.forEach(fn => fn());
	};

	const persistWithHistory = () => {
		addToHistory(settings, { find: findComp.getValue(), replace: replaceComp.getValue(), saveReplace: true });
		afterHistorySaved();
		persist();
		plugin.saveSettings();
	};

	// ── Editor focus helper ───────────────────────────────────────────────

	const focusEditor = () => { if (opts.isModal) return; const ed = getEditor(); if (ed) ed.focus(); };

	// ── Main Functions ────────────────────────────────────────────────────

	const doFindNext = (search, wrap, silent = false) => {
		if (!search) return 'empty';
		const ed = getEditor();
		if (!ed)                             return 'noeditor';
		if (ed.getViewType?.() === 'canvas') return 'canvas';
		if (ed.getViewType?.())              return 'noeditor'; // any other file

		const built = buildRegex(search, settings);
		if (!built) return 'error';

		const doWrap  = !!wrap;
		const docText = ed.getValue();
		const { matches, skipped } = collectMatches(docText, built.re, 0, settings.findZeroLen);

		if (matches.length === 0) {
			lastHighlight = null;
			if (matchLabelEl) matchLabelEl.setText(getActiveFileName());
			if (matchTextEl)  matchTextEl.setText('');
			return skipped > 0 ? 'notfound_zero' : 'notfound';
		}

		// Remap to the {absFrom, absLen} shape the navigation logic below expects
		const flatMatches = matches.map(m => ({ absFrom: m.from, absLen: m.to - m.from }));

		let startAt;
		if (lastHighlight !== null && flatMatches.some(m => m.absFrom === lastHighlight.from && m.absFrom + m.absLen === lastHighlight.to)) {
			// For zero-length matches: from === to --> skip forward by one code point
			startAt = lastHighlight.from === lastHighlight.to ? skipZeroLen(docText, lastHighlight.from) : lastHighlight.to;
		} else {
			// No tracked highlight
			lastHighlight = null;
			const curSelFrom = ed.posToOffset(ed.getCursor('from'));
			const curSelTo   = ed.posToOffset(ed.getCursor('to'));
			const selLen     = curSelTo - curSelFrom;
			const selIsKnownMatch = selLen > 0 && flatMatches.some(m => m.absFrom === curSelFrom && m.absLen === selLen);
			startAt = selIsKnownMatch ? curSelTo : curSelFrom;
		}

		let picked  = flatMatches.find(m => m.absFrom >= startAt);
		let didWrap = false;
		if (!picked) {
			picked = flatMatches[0];
			if (lastHighlight !== null && flatMatches.length === 1 &&
			   picked.absFrom === lastHighlight.from && picked.absFrom + picked.absLen === lastHighlight.to)
				return 'notfound_last'; // return if it finds only that one match
			if (doWrap)
				didWrap = true;
			else
				return 'notfound_wrapped';
		}

		const absFrom = picked.absFrom;
		const absTo   = absFrom + picked.absLen;
		lastHighlight = { from: absFrom, to: absTo };

		// Silent calls skip all visual updates.
		if (!silent) {
			const idx        = flatMatches.findIndex(m => m.absFrom === picked.absFrom && m.absLen === picked.absLen);
			const matchIdx   = idx >= 0 ? idx + 1 : 1;
			const total      = flatMatches.length;
			const matchedText = docText.slice(absFrom, absTo);
			const hlCls      = /^\t+$/.test(matchedText) ? 'obsidian-search-match-highlight frr-tab-highlight' : null;

			if (matchLabelEl) matchLabelEl.setText(`found match ${matchIdx} of ${total}:`);
			if (matchTextEl)  {
				// Appends their escape-sequence notation to newlines and tabs
				const displayText = matchedText
					.replace(/\t/g, '→\t')
					.replace(/\n/g, '↵\n');
				matchTextEl.setText(displayText || '(zero-length match)');
			}

			const cm = ed.cm;
			const isZeroLen     = absFrom === absTo;
			const isNewlineOnly = !isZeroLen && /^\n+$/.test(matchedText);
			const decoType      = isZeroLen || isNewlineOnly ? 'widget' : 'mark';

			hlSet(cm, absFrom, absTo, hlCls, decoType);
			hlSetGutter(cm, absFrom, absTo);
		}
		return didWrap ? 'found_wrapped' : 'found';
	};

	// Replace the current selection if it is an exact match, then advance.
	const doReplace = (search, rawReplace, wrap) => {
		if (!search) return 'empty';
		const ed = getEditor();
		if (!ed)                             return 'noeditor';
		if (ed.getViewType?.() === 'canvas') return 'canvas';
		if (ed.getViewType?.())              return 'noeditor'; // any other file

		const docText  = ed.getValue();
		const built    = buildRegex(search, settings, { global: false });
		if (!built) return 'error';
		const { re, uniSearch, flags: flagsNoG, namedGroupMap } = built;
		const stickyRe  = new RegExp(uniSearch, flagsNoG + 'y');
		const processed = preprocessPattern(rawReplace, namedGroupMap);

		let selFrom = ed.posToOffset(ed.getCursor('from'));
		let selTo   = ed.posToOffset(ed.getCursor('to'));

		if (lastHighlight !== null) {
			const cursorText = selFrom < selTo ? docText.slice(selFrom, selTo) : '';
			re.lastIndex = 0;
			if (!isExactMatch(cursorText, re)) {
				const hlText = docText.slice(lastHighlight.from, lastHighlight.to);
				re.lastIndex = 0;
				if (isExactMatch(hlText, re)) {
					selFrom = lastHighlight.from;
					selTo   = lastHighlight.to;
				}
			}
		}

		const selText  = selFrom < selTo ? docText.slice(selFrom, selTo) : '';
		let didReplace = false;

		re.lastIndex = 0;
		if (selText && isExactMatch(selText, re)) {
			// Normal match
			re.lastIndex = 0;
			const replacement = selText.replace(re, makeReplacer(processed));
			ed.replaceRange(replacement, ed.offsetToPos(selFrom), ed.offsetToPos(selTo));
			ed.setCursor(ed.offsetToPos(selFrom + replacement.length));
			lastHighlight = null;
			didReplace = true;

		} else if (!selText && lastHighlight !== null && selFrom === lastHighlight.from && lastHighlight.from === lastHighlight.to) {
			// Zero-length match
			try {
				stickyRe.lastIndex = selFrom;
				const m = stickyRe.exec(docText);
				if (m !== null) {
					const replacerFn = makeReplacer(processed);

					// Mirror the args String.prototype.replace passes to its callback
					const callArgs = [m[0], ...m.slice(1), m.index, docText];
					const replacement = replacerFn(...callArgs);
					ed.replaceRange(replacement, ed.offsetToPos(selFrom), ed.offsetToPos(selFrom));
					ed.setCursor(ed.offsetToPos(selFrom + replacement.length));
					lastHighlight = null;
					didReplace = true;

					// Advance an extra time for zero length match
					doFindNext(search, false, true);
				}
			} catch (_) {}
		}

		const findResult = doFindNext(search, wrap);
		if (didReplace) {
			if (findResult === 'found_wrapped')    return 'replaced_wrapped';
			if (findResult.startsWith('notfound')) return 'replaced_last';
			return 'replaced';
		}
		return findResult;
	};

	// Replaces all matches in the current file or in the selection
	const doReplaceAll = (search, rawReplace, wrap) => {
		if (!search) return 'empty';
		const ed = getEditor();
		if (!ed)                             return 'noeditor';
		if (ed.getViewType?.() === 'canvas') return 'canvas';
		if (ed.getViewType?.())              return 'noeditor'; // image, PDF, or any other non-markdown view

		const useScope = !!inSelToggle.getValue() && selScopes !== null && selScopes.length > 0;

		if (!!inSelToggle.getValue() && !useScope) return 'noselection';

		const doWrap  = !!wrap;
		const docText = ed.getValue();
		const changes = [];

		const built = buildRegex(search, settings);
		if (!built) return 'error';
		const { re, uniSearch, flags, namedGroupMap } = built;

		const replacer = makeReplacer(preprocessPattern(rawReplace, namedGroupMap));
		const startFrom = doWrap ? 0 : ed.posToOffset(ed.getCursor('from'));

		const { matches, skipped } = useScope
			? collectMatchesInScope(docText, re, selScopes, settings.findZeroLen, search)
			: collectMatches(docText, re, startFrom, settings.findZeroLen);

		for (const m of matches) {
			const callArgs = [m.match, ...m.groups, m.from, docText];
			changes.push({ from: m.from, to: m.to, insert: replacer(...callArgs) });
		}

		if (changes.length === 0) {
			if (skipped > 0) {
				const msg = `Pattern only produces zero-length matches: Nothing replaced.\n(${skipped} skipped)`;
				notice(settings, msg);
				logMsg(settings, ' ' + msg);
			} else if (!useScope && !doWrap) {
				const hasAny = new RegExp(uniSearch, flags).test(docText);
				notice(settings, hasAny ? 'No matches from cursor position to end.\n(Wrap around is off)' : 'No match found.');
			} else {
				notice(settings, 'No match found.');
			}
			return 'notfound';
		}

		if (ed.cm) {
			try { ed.cm.dispatch({ changes }); }
			catch (e) { notice(settings, 'Replace failed: ' + e.message); return 'error'; }
		} else {
			// Fallback
			[...changes].reverse().forEach(c =>
				ed.replaceRange(c.insert, ed.offsetToPos(c.from), ed.offsetToPos(c.to))
			);
		}

		const scopeLabel = useScope ? 'selection' : (doWrap ? 'document' : 'document (from cursor)');
		if (settings.logToConsole) {
			logMsg(settings, `  ${pluralize('replacement', changes.length, 's')} in ${scopeLabel}:`);
			changes.forEach((c, i) => logMsg(settings, `    [${i + 1}] offset ${c.from}–${c.to}: "${c.insert}"`));
		}
		notice(settings, `Made ${pluralize('replacement', changes.length, 's')} in ${scopeLabel}.`);
		if (skipped > 0) {
			const skipMsg = `Note: ${pluralize('zero-length match', skipped, 'es')} were skipped.`;
			notice(settings, skipMsg);
			logMsg(settings, '  ' + skipMsg);
		}
		lastHighlight = null;
		if (opts.isModal) opts.onClose && opts.onClose();
		return 'replaced';
	};

	// ── Logging helper ────────────────────────────────────────────────────

	// Logs the operation, user inputs, active flags, and the transformed pattern
	const logOp = (opName, find, extra) => {
		if (!settings.logToConsole) return;
		const built = buildRegex(find, settings, { noticeOnError: false });
		const transformed = built?.uniSearch ?? find;
		console.log(`[PoREs] [${opName}] find: "${find}${(transformed !== find) ? '" → "' + transformed : ''}" | flags: /g${getRegexFlagsStr(settings)}${extra || ''}`);
	};

	// ── Main buttons handlers ─────────────────────────────────────────────

	findNextBtn.onClick(() => {
		const s = findComp.getValue();
		if (!s)                                { notice(settings, 'Nothing to search for!'); return; }
		logOp('Find Next', s, ` | wrap: ${!!wrapToggle.getValue()}`);
		const result = doFindNext(s, !!wrapToggle.getValue());

		if      (result === 'found')           { logMsg(settings, '  Result: found'); }
		else if (result === 'found_wrapped')   { notice(settings, 'Wrapped around.'); logMsg(settings, '  Result: found (wrapped around)'); }
		else if (result === 'notfound')        { notice(settings, 'No matches.'); logMsg(settings, '  Result: no match'); }
		else if (result === 'notfound_last')   { notice(settings, 'This is the only match'); logMsg(settings, '  Result: no wrap, no match'); }
		else if (result === 'notfound_wrapped'){ notice(settings, 'No match from cursor position to end.\n(Wrap around is off)'); logMsg(settings, '  Result: no wrap, no match'); }
		else if (result === 'notfound_zero')   { notice(settings, 'Only found zero-length match\n(Skipped)'); logMsg(settings, '  Result: skipped zero-length match'); }
		else if (result === 'noeditor')        { notice(settings, 'No active editor.'); }
		else if (result === 'canvas')          { notice(settings, 'Canvas is not supported yet.'); }
		else if (result === 'error')             return;
		else                                     logMsg(settings, `  Result: ${result}`);

		addToHistory(settings, { find: s });
		afterHistorySaved();
		persist();
		plugin.saveSettings();

		// Keep keyboard focus on the button so Enter triggers the next Find.
		if (result === 'found' || result === 'found_wrapped')
			setTimeout(() => findNextBtn.buttonEl.focus(), 0);
	});

	replaceBtn.onClick(() => {
		const s = findComp.getValue(), r = replaceComp.getValue();
		if (!s)                                { notice(settings, 'Nothing to search for!'); return; }
		logOp('Replace', s, ` | replace: "${r}" | wrap: ${!!wrapToggle.getValue()}`);
		const result = doReplace(s, r, !!wrapToggle.getValue());

		if      (result === 'replaced')        { logMsg(settings, '  Result: replaced'); }
		else if (result === 'replaced_wrapped'){ notice(settings, 'Wrapped around.'); logMsg(settings, '  Result: replaced (wrapped around)'); }
		else if (result === 'replaced_last')   { notice(settings, 'Replaced the last match.'); logMsg(settings, '  Result: replaced, no further matches found'); }
		else if (result === 'notfound')        { notice(settings, 'No matches.'); logMsg(settings, '  Result: no match'); focusEditor(); }
		else if (result === 'notfound_wrapped'){ notice(settings, 'No match from cursor position to end.\n(Wrap around is off)'); logMsg(settings, '  Result: no wrap, no match'); }
		else if (result === 'notfound_zero')   { notice(settings, 'Only found zero-length match\n(Skipped)'); logMsg(settings, '  Result: skipped zero-length match'); }
		else if (result === 'noeditor')        { notice(settings, 'No active editor.'); }
		else if (result === 'canvas')          { notice(settings, 'Canvas is not supported yet.'); }
		else if (result === 'error')             return;
		else                                     logMsg(settings, `  Result: ${result}`);

		addToHistory(settings, { find: s, replace: r, saveReplace: true });
		afterHistorySaved();
		persist();
		plugin.saveSettings();

		// Same focus-back behaviour as Find Next
		if (['replaced', 'replaced_last', 'replaced_wrapped', 'found', 'found_wrapped'].includes(result))
			setTimeout(() => replaceBtn.buttonEl.focus(), 0);
	});

	replaceAllBtn.onClick(() => {
		const s = findComp.getValue(), r = replaceComp.getValue();
		if (!s)                                { notice(settings, 'Nothing to search for!'); return; }
		logOp('Replace All', s, ` | replace: "${r}" | inSel: ${!!inSelToggle.getValue()} | wrap: ${!!wrapToggle.getValue()}`);
		const result = doReplaceAll(s, r, !!wrapToggle.getValue());

		if      (result === 'noeditor')        { notice(settings, 'No active editor.'); }
		else if (result === 'canvas')          { notice(settings, 'Canvas is not supported yet.'); }
		else if (result === 'noselection')     { notice(settings, 'No text selected.'); }
		else if (result === 'error')             return;
		else if (result === 'notfound')          ;
		else                                     logMsg(settings, `  Result: ${result}`);

		addToHistory(settings, { find: s, replace: r, saveReplace: true });
		afterHistorySaved();
		persist();
		plugin.saveSettings();
	});

	// Capture scope on mouse/pointerdown, so the selection is read before the button click
	replaceAllBtn.buttonEl.addEventListener('pointerdown', () => {
		if (inSelToggle.getValue()) captureScope();
	});

	// ── File search section ───────────────────────────────────────────────

	// All file-search elements are created, but hidden when the feature is disabled in Settings
	const filePathSep = containerEl.createEl('hr', { cls: 'frr-section-sep' });

	// Returns matching vault folder paths for the given prefix
	const getPathSuggestions = (val) => {
		const lower = val.toLowerCase();
		let folders = [];
		try {
			// Obsidian 1.x exposes getAllFolders()
			if (typeof plugin.app.vault.getAllFolders === 'function') {
				folders = plugin.app.vault.getAllFolders(true)
					.map(f => f.path)
					.filter(p => p !== '/' && p !== '');
			} else {
				// Fallback to extracting from markdown files
				const set = new Set();
				plugin.app.vault.getMarkdownFiles().forEach(f => {
					const parts = f.path.split('/');
					for (let i = 1; i < parts.length; i++) {
						set.add(parts.slice(0, i).join('/'));
					}
				});
				folders = Array.from(set);
			}
		} catch (e) { logMsg(settings, "getPathSuggestions error:", e); }
		return folders
			.filter(p => p.toLowerCase().startsWith(lower) && p.toLowerCase() !== lower)
			.sort()
			.slice(0, 8);
	};

	const { comp: pathComp, row: filePathRow } = addHistoryInput(
		'Path:', 'Vault root  (e.g. folder/subfolder)',
		() => settings.pathHistory,
		() => pathHistIdx, v => { pathHistIdx = v; },
		() => pathDraft, v => { pathDraft = v; },
		getPathSuggestions
	);
	filePathRow.createDiv({ cls: 'frr-postfix' }).setText('*.md');

	const fileBtnRow = containerEl.createDiv({ cls: 'frr-row frr-btn-row' });
	const makeFileBtn = (text, cta) => {
		const w = fileBtnRow.createDiv({ cls: 'frr-btn-wrap' });
		const b = new obsidian.ButtonComponent(w);
		b.setButtonText(text);
		if (cta) b.setCta();
		return b;
	};
	const findInFilesBtn    = makeFileBtn('Find in Files');
	const replaceInFilesBtn = makeFileBtn('Replace in Files', true);

	// ── File scanning helpers ─────────────────────────────────────────────

	// Returns TFile objects in the vault matching pathFilter
	const getFilteredFiles = (pathFilter) => {
		if (pathFilter !== '') {
			const entry = plugin.app.vault.getAbstractFileByPath(pathFilter);

			// Reject if not found at all, or if it resolves to a file instead of a folder
			if (!entry)
				return null;
			if (!(entry instanceof obsidian.TFolder)) {
				notice(settings, `Path is a file, not a folder`);
				return;
			}
		}
		return plugin.app.vault.getMarkdownFiles().filter(f => {
			if (f.path.startsWith('.obsidian/')) return false;
			if (!pathFilter) return true;
			return f.path.startsWith(pathFilter + '/');
		});
	};

	// ── File-operation state ──────────────────────────────────────────────

	let fileSearchStatus = opts.fileStatus || null;
	let isRunning        = false;
	let cancelToken      = null;
	let statusTickerId   = null;
	let statusTextEl     = null;
	let destroyed        = false;

	const getElapsedStr = () => {
		if (!fileSearchStatus) return '';
		const ms = Date.now() - fileSearchStatus.startTime;
		return ms <= 60000 ? ms < 1000 ? `${ms}ms` : `${Math.floor(ms / 1000)}s`: `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
	};

	const updateStatusText = () => {
		if (destroyed || !statusTextEl || !fileSearchStatus) return;
		const { searched, total, matches, done, cancelled, isReplace } = fileSearchStatus;
		const verb    = isReplace ? 'replaced' : 'searched';
		const elapsed = getElapsedStr();
		let text;
		if (!done) {
			text = `${searched} / ${total} files ${verb} · ${elapsed}`;
		} else if (cancelled) {
			text = `Cancelled · ${searched} / ${pluralize('file', total, 's')} ${verb} · ${elapsed}`;
		} else if (matches === 0) {
			text = `No matches · ${pluralize('file', searched, 's')} ${verb} · ${elapsed}`;
		} else {
			const matchLabel = isReplace ? `${pluralize('replacement', matches, 's')} in` : `${pluralize('match', matches, 'es')} across`;
			text = `${matchLabel} ${pluralize('file', fileResults.length, 's')} · ${elapsed}`;
		}
		statusTextEl.setText(text);
	};

	const runFileOperation = async (files, onFile) => {
		isRunning   = true;
		cancelToken = { cancelled: false };
		const token = cancelToken;
		if (statusTickerId !== null) { clearInterval(statusTickerId); statusTickerId = null; }

		fileResults      = [];
		const localStatus = fileSearchStatus; // set by caller before runFileOperation
		
		renderResults();
		await Promise.resolve(); // yield to the paint cycle so the header is visible before the loop
		statusTickerId = setInterval(updateStatusText, 1000);

		try {
			for (const file of files) {
				if (token.cancelled) break;
				let content;
				try { content = await plugin.app.vault.read(file); }
				catch (e) { notice(settings, `Could not read: ${file.path}`); localStatus.searched++; updateStatusText(); continue; }
				
				await onFile(file, content, token);
				
				localStatus.searched++;
				updateStatusText();
			}
		} finally {
			clearInterval(statusTickerId);
			statusTickerId = null;
			localStatus.done      = true;
			localStatus.cancelled = token.cancelled;
			isRunning = false;
		}

		if (destroyed) return false;
		if (opts.onFileResultsChange) opts.onFileResultsChange(fileResults.slice());
		if (opts.onFileStatusChange)  opts.onFileStatusChange(fileSearchStatus);
		renderResults();
		return !token.cancelled;
	};

	// ── File main functions ───────────────────────────────────────────────

	// Scan vault files for matches and populate the in-UI results list
	const doFindInFiles = async (search, files) => {
		if (isRunning) { notice(settings, 'A search is already running.'); return; }
		const built = buildRegex(search, settings);
		if (!built) return;

		fileSearchStatus = { total: files.length, searched: 0, matches: 0, startTime: Date.now(), done: false, cancelled: false, isReplace: false };
		let zeroLenSkipped = 0;

		const completed = await runFileOperation(files, async (file, content) => {
			const { matches, skipped } = collectMatches(content, built.re, 0, settings.findZeroLen);
			zeroLenSkipped += skipped;
			if (matches.length > 0) {
				fileResults.push({ path: file.path, count: matches.length });
				fileSearchStatus.matches += matches.length;
				logMsg(settings, `  ${file.path} (${matches.length})`);
			}
		});

		if (!completed) return;
		logMsg(settings, `  Done: ${pluralize('match', fileSearchStatus.matches, 'es')} in ${pluralize('file', fileResults.length, 's')}. Time: ${getElapsedStr()}`);
		const suffix = zeroLenSkipped > 0 ? `\n(Skipped ${zeroLenSkipped} zero-length matches)` : '';
		if (fileSearchStatus.matches > 0)
			notice(settings, `Found ${pluralize('match', fileSearchStatus.matches, 'es')} in ${pluralize('file', fileResults.length, 's')}.${suffix}`);
		else
			notice(settings, `No matches found.${suffix}`);
	};

	// Replace across vault files
	const doReplaceInFiles = async (search, rawReplace, files) => {
		if (isRunning) { notice(settings, 'A replacement is already running.'); return; }
		const built = buildRegex(search, settings);
		if (!built) return;
		const { namedGroupMap } = built;
		const replacer = makeReplacer(preprocessPattern(rawReplace, namedGroupMap));

		fileSearchStatus = { total: files.length, searched: 0, matches: 0, startTime: Date.now(), done: false, cancelled: false, isReplace: true };
		let zeroLenSkipped = 0;

		const completed = await runFileOperation(files, async (file, content, token) => {
			const { matches, skipped } = collectMatches(content, built.re, 0, settings.findZeroLen);
			zeroLenSkipped += skipped;
			if (matches.length === 0) return;

			// apply replacements in reverse so offsets stay valid
			let newContent = content;
			for (const m of [...matches].reverse()) {
				const callArgs = [m.match, ...m.groups, m.from, content];
				newContent = newContent.slice(0, m.from) + replacer(...callArgs) + newContent.slice(m.to);
			}

			try { await plugin.app.vault.modify(file, newContent); }
			catch (e) { notice(settings, `Could not write: ${file.path}`); return; }

			fileResults.push({ path: file.path, count: matches.length });
			fileSearchStatus.matches += matches.length;
			logMsg(settings, `  ${file.path} (${matches.length})`);
		});

		if (!completed) { notice(settings, 'An instance is still running, aborting new search'); return; }
		logMsg(settings, `  Done: ${pluralize('match', fileSearchStatus.matches, 'es')} in ${pluralize('file', fileResults.length, 's')}. Time: ${getElapsedStr()}`);
		const suffix = zeroLenSkipped > 0 ? `\n(Skipped ${zeroLenSkipped} zero-length ${pluralize('match', fileSearchStatus.matches, 'es')})` : '';
		if (fileSearchStatus.matches > 0)
			notice(settings, `Made ${pluralize('replacement', fileSearchStatus.matches, 's')} in ${pluralize('file', fileResults.length, 's')}.${suffix}`);
		else
			notice(settings, `No matches found.${suffix}`);
	};

	// ── File button handlers ──────────────────────────────────────────────

	findInFilesBtn.onClick(async () => {
		const s = findComp.getValue();
		if (!s) { notice(settings, 'Nothing to search for!'); return; }
		const pathFilter = pathComp.getValue().trim().replace(/\/+$/, '');
		if (pathComp.getValue() !== pathFilter) pathComp.setValue(pathFilter);

		const files = getFilteredFiles(pathFilter);
		if (files === null) { notice(settings, `Path not found in vault: "${pathFilter}"`); return; }
		if (!files) return;

		logOp('Find in Files', s, ` | path: "${pathFilter || '(vault root)'}"`);
		addToHistory(settings, { find: s, path: pathFilter, savePath: true });
		afterHistorySaved();
		await plugin.saveSettings();

		await doFindInFiles(s, files);
	});

	replaceInFilesBtn.onClick(() => {
		const s = findComp.getValue();
		if (!s) { notice(settings, 'Nothing to search for!'); return; }
		const pathFilter = pathComp.getValue().trim().replace(/\/+$/, '');
		if (pathComp.getValue() !== pathFilter) pathComp.setValue(pathFilter);

		const files = getFilteredFiles(pathFilter);
		if (files === null) { notice(settings, `Path not found in vault: "${pathFilter}"`); return; }
		if (!files) return;

		// Confirmation window before replacing matches in vault
		const vaultName   = plugin.app.vault.getName();
		const displayPath = pathFilter ? `"${vaultName}/${pathFilter}"` : `your vault "${vaultName}"`;
		new ConfirmModal(
			plugin.app,
			`Replace all matches in ${displayPath}?\n\nThis cannot be undone!`,
			async () => {
				logOp('Replace in Files', s, ` | replace: "${replaceComp.getValue()}" | path: "${pathFilter || '(vault root)'}"`);
				addToHistory(settings, { find: s, replace: replaceComp.getValue(), path: pathFilter, saveReplace: true, savePath: true });
				afterHistorySaved();
				await plugin.saveSettings();

				await doReplaceInFiles(s, replaceComp.getValue(), files);
			}
		).open();
	});

	// ── File results panel ────────────────────────────────────────────────

	// Results live in-memory per UI instance
	const resultsSep  = containerEl.createEl('hr',  { cls: 'frr-results-sep' });
	const resultsWrap = containerEl.createDiv({ cls: 'frr-results-wrap' });
	resultsSep.style.display  = 'none';
	resultsWrap.style.display = 'none';

	let fileResults = (opts.fileResults || []).slice();

	const renderResults = () => {
		if (destroyed) return;
		resultsWrap.empty();
		statusTextEl = null;

		const showPanel = fileSearchStatus !== null || fileResults.length > 0;
		resultsSep.style.display = resultsWrap.style.display = showPanel ? '' : 'none';
		if (!showPanel) return;

		// ── Status header (sticky top) ────────────────────────────────────

		if (fileSearchStatus !== null) {
			const statusRow = resultsWrap.createDiv({ cls: 'frr-results-status' });
			statusTextEl = statusRow.createSpan({ cls: 'frr-results-status-text' });
			updateStatusText();

			const xBtn = statusRow.createEl('button', { cls: 'frr-dropdown-x', text: '×' });
			xBtn.setAttribute('type', 'button');
			xBtn.setAttribute('tabindex', '-1');
			xBtn.setAttribute('aria-label', isRunning ? 'Cancel operation' : 'Dismiss');
			xBtn.addEventListener('click', () => {
				if (isRunning && cancelToken) {
					cancelToken.cancelled = true;
				} else {
					fileSearchStatus = null;
					fileResults      = [];
					if (opts.onFileResultsChange) opts.onFileResultsChange([]);
					renderResults();
				}
			});
		}

		// ── File list ─────────────────────────────────────────────────────

		fileResults.forEach(({ path, count }) => {
			const item     = resultsWrap.createDiv({ cls: 'frr-result-item' });
			const fileName = path.split('/').pop();
			item.createSpan({ cls: 'frr-result-text', text: `${fileName}  (${count})` });
			item.setAttribute('title', path);
			item.addEventListener('click', () => {
				const file = plugin.app.vault.getAbstractFileByPath(path);
				if (!(file instanceof obsidian.TFile)) return;

				// Prefer an already-open editor pane; avoid hijacking the side panel leaf
				const existingLeaf = plugin.app.workspace.getMostRecentLeaf();
				const targetLeaf = (existingLeaf && existingLeaf.view?.getViewType() !== VIEW_TYPE_REGEX_REPLACE) ? existingLeaf : plugin.app.workspace.getLeaf('tab');

				targetLeaf.openFile(file);
				matchLabelEl.setText(fileName);
			});
		});
	};

	if (fileResults.length > 0 || fileSearchStatus !== null) renderResults();

	// ── Show/hide File section ────────────────────────────────────────────

	const updateFileSearchVisibility = () => {
		const show = !!(settings.findReplaceInFiles);
		[filePathSep, filePathRow, fileBtnRow].forEach(el => {
			el.style.display = show ? (el === filePathRow || el === fileBtnRow ? 'flex' : '') : 'none';
		});

		// When the feature is disabled, clear any results
		if (!show && (fileResults.length > 0 || fileSearchStatus !== null)) {
			if (isRunning && cancelToken) cancelToken.cancelled = true;
			fileResults      = [];
			fileSearchStatus = null;
			if (opts.onFileResultsChange) opts.onFileResultsChange([]);
			renderResults();
		}
	};
	updateFileSearchVisibility();

	// ── Keyboard shortcuts ────────────────────────────────────────────────

	findComp.inputEl.addEventListener('keydown', e => {
		if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); findNextBtn.buttonEl.click(); }
		else if (e.key === 'Escape' && !opts.isModal) persistWithHistory();
	});

	replaceComp.inputEl.addEventListener('keydown', e => {
		if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); replaceBtn.buttonEl.click(); }
		else if (e.key === 'Escape' && !opts.isModal) persistWithHistory();
	});

	pathComp.inputEl.addEventListener('keydown', e => {
		if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); findInFilesBtn.buttonEl.click(); }
		else if (e.key === 'Escape' && !opts.isModal) persistWithHistory();
	});

	findComp.inputEl.addEventListener('input', () => {
		lastHighlight = null;
		const ed = getEditor();
		if (matchTextEl)  matchTextEl.setText('');
		try { if (ed && ed.cm) clearHighlight(ed.cm); } catch (_) {}
	});

	// ── Side-panel focus-out save ─────────────────────────────────────────

	if (!opts.isModal) {
		const onPanelFocusOut = e => {
			if (!containerEl.contains(e.relatedTarget)) persist();
		};
		containerEl.addEventListener('focusout', onPanelFocusOut);
		cleanups.push(() => containerEl.removeEventListener('focusout', onPanelFocusOut));
	}

	// ── Manual cursor-move detection ──────────────────────────────────────

	const _movers = new Set([
		'ArrowUp','ArrowDown','ArrowLeft','ArrowRight',
		'Home','End','PageUp','PageDown',
	]);
	const onDocMousedown = e => {
		if (!containerEl.contains(e.target)) {
			lastHighlight = null;
			try { const ed = getEditor(); if (ed && ed.cm) clearHighlight(ed.cm); } catch (_) {}
		}
	};
	const onDocKeydown = e => {
		if (_movers.has(e.key) && !containerEl.contains(document.activeElement)) {
			lastHighlight = null;
			try { const ed = getEditor(); if (ed && ed.cm) clearHighlight(ed.cm); } catch (_) {}
		}
	};

	// Clear lastHighlight on any editor content change so stale offsets are never used
	const editorChangeRef = plugin.app.workspace.on('editor-change', () => {
		lastHighlight = null;
		const ed = getEditor();
		if (matchTextEl)  matchTextEl.setText('');
		try { if (ed && ed.cm) clearHighlight(ed.cm); } catch (_) {}
	});

	const activeLeafChangeRef = plugin.app.workspace.on('active-leaf-change', (leaf) => {
		if (opts.isModal) return;
		if (!leaf || leaf.view?.getViewType() === VIEW_TYPE_REGEX_REPLACE) return;

		if (leaf.view instanceof obsidian.MarkdownView) {
			lastHighlight = null;
			if (matchLabelEl) matchLabelEl.setText(leaf.view.file?.name ?? '—');
			if (matchTextEl)  matchTextEl.setText('');
		} else {
			if (matchLabelEl) matchLabelEl.setText('—');
			if (matchTextEl)  matchTextEl.setText('');
		}
	});

	document.addEventListener('mousedown', onDocMousedown);
	document.addEventListener('keydown',   onDocKeydown);
	cleanups.push(() => {
		document.removeEventListener('mousedown', onDocMousedown);
		document.removeEventListener('keydown',   onDocKeydown);
		plugin.app.workspace.offref(editorChangeRef);
		plugin.app.workspace.offref(activeLeafChangeRef);
	});

	// ── Prefill & restore ─────────────────────────────────────────────────

	const lastFind    = settings.findHistory[0]    ?? '';
	const lastReplace = settings.replaceHistory[0] ?? '';
	const lastPath    = settings.pathHistory[0]    ?? '';

	if (opts.isModal && settings.prefillFind && opts.prefillSelection) {
		findComp.setValue(opts.prefillSelection);
		inSelToggle.setValue(false);
	} else {
		findComp.setValue(lastFind);
	}
	replaceComp.setValue(lastReplace);
	pathComp.setValue(lastPath);

	setTimeout(() => { findComp.inputEl.focus(); findComp.inputEl.select(); }, 50);

	if (matchLabelEl) matchLabelEl.setText(getActiveFileName());

	// ── updateFlags ───────────────────────────────────────────────────────

	// Called by the settings pub/sub on any settings change.
	const updateFlags = () => {
		flagsPostfix.setText('/g' + getRegexFlagsStr(settings));
		updateFileSearchVisibility();
		arrowUpdaters.forEach(fn => fn());
		if (matchDisplayEl) matchDisplayEl.style.display = settings.showMatchDisplay !== false ? '' : 'none';
		inSelToggle.setValue(!!settings.selOnly);
		wrapToggle.setValue(!!settings.wrapAround);
		findHistIdx = replaceHistIdx = pathHistIdx = -1;
		findDraft = replaceDraft = pathDraft = null;
	};

	const destroy = () => {
		destroyed = true;
		if (statusTickerId !== null) { clearInterval(statusTickerId); statusTickerId = null; }
		if (cancelToken) cancelToken.cancelled = true;
		cleanups.forEach(fn => fn());
		try { const ed = getEditor(); if (ed && ed.cm) clearHighlight(ed.cm); } catch (_) {}
	};

	return { destroy, persist, persistWithHistory, updateFlags };
}

// ── Modal ─────────────────────────────────────────────────────────────────

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
		titleEl.style.display = 'none'; // header rendered inside content via buildFindReplaceUI
		this._closed = false;

		this._ui = buildFindReplaceUI(
			contentEl, () => this.editor, this.settings, this.plugin,
			{
				isModal:             true,
				prefillSelection:    this.prefillSelection,
				onClose:             () => { this._closed = true; this.close(); },
				fileResults:         this.plugin.lastFileResults,
				onFileResultsChange: r => { this.plugin.lastFileResults = r; },
				fileStatus:          this.plugin.lastFileStatus,
				onFileStatusChange:  s => { this.plugin.lastFileStatus = s; }
			}
		);
	}

	onClose() {
		if (this._ui) {
			if (!this._closed) this._ui.persistWithHistory();
			this._ui.destroy();
			this._ui = null;
		}
		this.contentEl.empty();
	}
}

// ── Side Panel View ───────────────────────────────────────────────────────

class FindAndReplaceView extends obsidian.ItemView {
	constructor(leaf, settings, plugin) {
		super(leaf);
		this.settings       = settings;
		this.plugin         = plugin;
		this._ui            = null;
		this._unsubSettings = null;
		this._fileResults   = [];
		this._fileStatus    = null;
	}

	getViewType()    { return VIEW_TYPE_REGEX_REPLACE; }
	getDisplayText() { return 'RegEx Find/Replace'; }
	getIcon()        { return 'search-x'; }

	async onOpen() {
		const container = this.contentEl;
		container.empty();
		container.addClass('find-replace-view');

		this._ui = buildFindReplaceUI(
			container,
			() => {
				const v = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
				if (v) return v.editor;

				const lastView = this.plugin.lastActiveView;
				if (!lastView) return null;
				if (lastView instanceof obsidian.MarkdownView) return lastView.editor;
				return lastView;
			},
			this.settings, this.plugin,
			{
				isModal:             false,
				fileResults:         this._fileResults,
				onFileResultsChange: r => { this._fileResults = r; },
				fileStatus:          this._fileStatus,
				onFileStatusChange:  s => { this._fileStatus = s; }
			}
		);

		this._unsubSettings = this.plugin.addSettingsListener(() => {
			if (this._ui) this._ui.updateFlags();
		});
	}

	async onClose() {
		if (this._unsubSettings) {
			this._unsubSettings();
			this._unsubSettings = null;
		}
		if (this._ui) {
			this._ui.persistWithHistory();
			this._ui.destroy();
			this._ui = null;
		}
	}
}

// ── Plugin ────────────────────────────────────────────────────────────────

class RegexFindReplacePlugin extends obsidian.Plugin {
	async onload() {
		await this.loadSettings();

		this._settingsListeners = [];
		this.lastActiveView     = null;
		this._ribbonIcon        = null;
		this.lastFileResults    = [];
		this.lastFileStatus     = null;

		this.registerEvent(
			this.app.workspace.on('active-leaf-change', leaf => {
				if (!leaf || leaf.view?.getViewType() === VIEW_TYPE_REGEX_REPLACE) return; // dont focus to the panel itself
				this.lastActiveView = leaf.view || null;
			})
		);

		this.app.workspace.onLayoutReady(() => {
			if (this.lastActiveView) return;
			this.app.workspace.iterateAllLeaves(leaf => {
				if (leaf.view?.getViewType() === VIEW_TYPE_REGEX_REPLACE) return;
				// Find a MarkdownView on startup
				if (leaf.view instanceof obsidian.MarkdownView) {
					this.lastActiveView   = leaf.view;
				} else if (!this.lastActiveView) {
					this.lastActiveView = leaf.view || null;
				}
			});
		});

		this.registerView(VIEW_TYPE_REGEX_REPLACE, leaf => new FindAndReplaceView(leaf, this.settings, this));
		this.addSettingTab(new RegexFindReplaceSettingTab(this.app, this));

		// Commands
		this.addCommand({
			id: 'obsidian-regex-replace', name: 'Open Find and Replace (popup)',
			callback: () => this.openPopup(),
		});

		this.addCommand({
			id: 'obsidian-regex-replace-panel', name: 'Open Find and Replace (side panel)',
			callback: () => this.activateView(),
		});

		this.addCommand({
			id: 'obsidian-regex-replace-in-files', name: 'Toggle Find/Replace in Files',
			callback: () => {
				this.settings.findReplaceInFiles = !this.settings.findReplaceInFiles;
				this.saveSettings();
				this.notifySettingsChange();
				notice(this.settings, `Find/Replace in Files ${this.settings.findReplaceInFiles ? 'enabled' : 'disabled'}`);
			},
		});

		// Ribbon icon opens the popup
		this.app.workspace.onLayoutReady(() => {
			if (this.settings.showRibbonIcon !== false) {
				this._ribbonIcon = this.addRibbonIcon('search-x', 'RegEx Find/Replace', () => this.openPopup());
			}
		});
	}

	// Open the popup modal against the currently active editor
	openPopup() {
		let editor = null;
		let prefill = '';

		const mdView = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
		if (mdView)
			editor = mdView.editor;
		else {
			// Active leaf is the side panel (or something else) — fall back to lastActiveView
			const lastView = this.lastActiveView;
			if (lastView instanceof obsidian.MarkdownView) {
				editor = lastView.editor;
			}
		}

		if (!editor) {
			const activeView = this.app.workspace.activeLeaf?.view;
			if (activeView?.getViewType() === 'canvas')
				notice(this.settings, 'Canvas is not supported yet.');
			else if (!this.settings.findReplaceInFiles)
				notice(this.settings, 'No active editor.');

			// Only open without editor, if Vault search can be used
			if (!this.settings.findReplaceInFiles) return;
			new FindAndReplaceModal(this.app, null, this.settings, this, '').open();
			return;
		}

		const sel = editor.getSelection();
		prefill = this.settings.prefillFind && sel && sel.indexOf('\n') < 0 ? sel : '';
		new FindAndReplaceModal(this.app, editor, this.settings, this, prefill).open();
	}

	addSettingsListener(fn) {
		this._settingsListeners = this._settingsListeners || [];
		this._settingsListeners.push(fn);
		return () => { this._settingsListeners = this._settingsListeners.filter(f => f !== fn); };
	}

	notifySettingsChange() { (this._settingsListeners || []).forEach(fn => fn()); }

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

	async loadSettings() {
		const loaded = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);

		this.settings.findHistory    = Array.isArray(loaded && loaded.findHistory)    ? [...loaded.findHistory]    : [];
		this.settings.replaceHistory = Array.isArray(loaded && loaded.replaceHistory) ? [...loaded.replaceHistory] : [];
		this.settings.pathHistory    = Array.isArray(loaded && loaded.pathHistory)    ? [...loaded.pathHistory]    : [];

		if (typeof this.settings.regexFlags !== 'object' || !this.settings.regexFlags)
			this.settings.regexFlags = Object.assign({}, DEFAULT_SETTINGS.regexFlags);

		if (this.settings.regexFlags.u && this.settings.regexFlags.v)
			this.settings.regexFlags.u = false;

		this.settings.wrapAround = Boolean(this.settings.wrapAround);
		this.settings.selOnly    = Boolean(this.settings.selOnly);

		if (typeof this.settings.findReplaceInFiles !== 'boolean') this.settings.findReplaceInFiles = false;
		if (typeof this.settings.showRibbonIcon     !== 'boolean') this.settings.showRibbonIcon     = true;
		if (typeof this.settings.showQuickRef       !== 'boolean') this.settings.showQuickRef       = true;
		if (typeof this.settings.showMatchDisplay   !== 'boolean') this.settings.showMatchDisplay   = true;
		if (typeof this.settings.logToConsole       !== 'boolean') this.settings.logToConsole       = false;
		if (typeof this.settings.unicodeN           !== 'boolean') this.settings.unicodeN           = false;
		if (typeof this.settings.findZeroLen        !== 'boolean') this.settings.findZeroLen        = false;

		trimHistories(this.settings);
	}

	async saveSettings() { await this.saveData(this.settings); }
}

// ── Settings Tab ──────────────────────────────────────────────────────────

class RegexFindReplaceSettingTab extends obsidian.PluginSettingTab {
	constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

	// Trim histories when the settings tab closes
	hide() {
		trimHistories(this.plugin.settings);
		this.plugin.saveSettings();
		this.plugin.notifySettingsChange();
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		function createFragmentWithHTML(html) {
			const fragment = new DocumentFragment();
			fragment.createSpan({}, (span) => {span.innerHTML = html;});
			return fragment;
		}

		// ── Quick Reference ───────────────────────────────────────────────────

		// Wrapped in a div so visibility can be toggled without rebuilding the page.
		const quickRefEl = containerEl.createDiv();
		quickRefEl.style.display = this.plugin.settings.showQuickRef !== false ? '' : 'none';

		quickRefEl.createEl('h2', { text: 'RegEx Quick Reference' });
		const table = quickRefEl.createDiv({ cls: 'regex-help' }).createEl('table', { cls: 'regex-help-table' });

		// Helper: append an array of [pattern, desc] rows into a <tbody>
		const appendRows = (tbody, rows) => {
			rows.forEach(([pattern, desc]) => {
				const tr = tbody.createEl('tr');
				if (pattern !== '' && desc === '') {
					tr.createEl('td', { attr: { colspan: '2' }, cls: 'regex-help-header', text: pattern });
				} else if (!(pattern === '' && desc === '')) {
					tr.createEl('td', { cls: 'regex-help-pattern', text: pattern });
					tr.createEl('td', { text: desc });
				}
			});
		};

		// Static rows
		appendRows(table.createEl('tbody'), [
			['Find Field',       ''],
			['some text',        'Finds the phrase "some text", just like the default Find/Replace'],
			['.',                'Any character (flag s allows . to also match a newline)'],
			['\\d  \\w  \\s',    'Digit · Word character · Whitespace'],
			['\\D  \\W  \\S',    'Inverse of \\d  \\w  \\s'],
			['\\b  \\B',         'Word boundary · Not a word boundary'],
			['\\n  \\t',         'Newline · Tab'],
			['\\xNM  \\x41',     'Character with the hexadecimal byte value of NM · \\x41 = "A"'],
			['^  $',             'Start/End of line/document (flag m changes between line and document)'],
			['[abc]',            'Character class: matches a, b, or c'],
			['[^abc]',           'Inverted character class: matches anything except a, b, c'],
			['*  +  ?',          'Zero-or-more · One-or-more · Optional'],
			['*?  +?',           'Zero-or-more · One-or-more  (this changes greedy to lazy behavior)'],
			['\\d+  \\d+?',      'At least one number: As many as possible · As few as possible'],
			['\\\\  \\+  \\(',   'Escape characters: \\ · + · ('],
			['{n}',              'Exactly n repetitions'],
			['{n,m}',            'Between n and m repetitions'],
			['{n,}',             'At least n repetitions'],
			['(abc)',            'Capturing group: reference in Replace with \\1 or $1'],
			['(?:abc)',          'Non-capturing group: groups without a back-reference'],
			['a|b',              'Alternation: matches a or b'],
			['(car|bike)',       'Alternation: matches car or bike'],
			['(?=abc)',          'Positive lookahead: ensures "abc" follows'],
			['(?!abc)',          'Negative lookahead: ensures "abc" does NOT follow'],
			['(?<=abc)',         'Positive lookbehind: ensures "abc" precedes'],
			['(?<!abc)',         'Negative lookbehind: ensures "abc" does NOT precede'],
			['(\\w+).*\\1',      'Find repetition: matches anything until the content of the first group is found again'],
			['(?<named>abc)',    'Group name: give a capture group the name "named" and capture the text "abc"'],
		]);

		// Unicode-conditional rows in their own <tbody> so they can be patched in-place.
		const unicodeTbody = table.createEl('tbody');
		const getUnicodeRows = () => {
			if (this.plugin.settings.regexFlags?.v) return [
				['\\p{P}',           'Unicode property: All unicode punctuation characters'],
				['\\p{Letter}',      'Unicode property: any letter'],
				['\\P{Letter}',      'Unicode property: not a letter'],
				['\\p{Script=Latin}','Unicode script property: Latin characters'],
				['\\p{RGI_Emoji}',   'Valid Unicode emoji sequence'],
				['&&',               'Set intersection inside character classes'],
				['[[\\p{L}]&&\\p{ASCII}]', 'Nested intersection: ASCII letters'],
				['--',               'Set subtraction inside character classes'],
				['[[a-z]--[aeiou]]', 'Subtraction: lowercase consonants'],
				['[[\\p{L}]--[A-Z]]','Subtraction: all Unicode letters except A-Z'],
				['[\\q{abc}]',       'String: Include a string in character class'],
			];
			else if (this.plugin.settings.regexFlags?.u) return [
				['\\p{P}',           'Unicode property: All unicode punctuation characters'],
				['\\p{Letter}',      'Unicode property: any letter'],
				['\\P{Letter}',      'Unicode property: not a letter'],
			];
			return [];
		};
		const renderUnicodeRows = () => { unicodeTbody.empty(); appendRows(unicodeTbody, getUnicodeRows()); };
		renderUnicodeRows();

		// Trailing rows (always shown)
		appendRows(table.createEl('tbody'), [
				['Replace Field',    ''],
				['\\n  \\t',         'ASCII characters: Newline · Tab'],
				['\\\\  \\$',        'Escape characters: \\ · $'],
				['\\0  $0',          'Insert the full match'],
				['\\1  $1',          'Insert the first captured group'],
				['\\12  $12',        'Insert the twelfth captured group'],
				['$<named>',         'Insert the named captured group "named"'],
				['${1}',             'Insert the first captured group'],
				['${1}2',            'Insert the first captured group followed by a "2"'],
			  //['${1?yes:no}',      'If group 1 matched → yes, else → no'],
			  //['${1?\1:X}',        'If group 1 matched, insert group 1, else X'],
			  //['${1?text:}',       'Insert "text" if group 1 matched'],
			  //['${1?:text}',       'Insert "text" if group 1 did NOT match'],
		]);

		// Links for further reading and learning
		new obsidian.Setting(quickRefEl)
			.setName(createFragmentWithHTML('Additional Information'))
			.setDesc(createFragmentWithHTML('This <a href="https://github.com/Silt-Strider/power-of-regex?tab=readme-ov-file#obsidian-plugin---power-of-regex-search">ReadMe</a> file; An interactive lessons on <a href="https://regexone.com/">RegexOne</a>; A fun sandbox at <a href="https://regexr.com/">RegExr</a>'));

		// ── Settings ──────────────────────────────────────────────────────────

		containerEl.createEl('h2', { text: 'Settings' });

		// Find/Replace in Files
		new obsidian.Setting(containerEl)
			.setName('Enable Find/Replace in Files')
			.setDesc('Adds the UI section to Find/Replace matches somewhere in your Vault')
			.addToggle(t => t.setValue(!!(this.plugin.settings.findReplaceInFiles))
				.onChange(async (v) => {
					this.plugin.settings.findReplaceInFiles = v;
					await this.plugin.saveSettings();
					this.plugin.notifySettingsChange();
				}));

		// Prefill from selection
		new obsidian.Setting(containerEl)
			.setName('Prefill find field from selection')
			.setDesc('Copy the currently selected line of text into the Find field when opening the popup.')
			.addToggle(t => t.setValue(this.plugin.settings.prefillFind)
				.onChange(async (v) => {
					this.plugin.settings.prefillFind = v;
					await this.plugin.saveSettings();
				}));

		// Find zero-length matches
		new obsidian.Setting(containerEl)
			.setName('Find zero-length matches')
			.setDesc('Allows expressions like \\b, .*?, and (?=abc) to match positions, if no characters match. When off, these matches are skipped.')
			.addToggle(t => t
				.setValue(this.plugin.settings.findZeroLen ?? false)
				.onChange(async (v) => {
					this.plugin.settings.findZeroLen = v;
					await this.plugin.saveSettings();
				}));

		// ── Display ───────────────────────────────────────────────────────────

		containerEl.createEl('h4', { text: 'Display' });

		// Show quick reference
		new obsidian.Setting(containerEl)
			.setName('Show quick reference')
			.setDesc('Displays the quick reference at the top of this tab.')
			.addToggle(t => t.setValue(this.plugin.settings.showQuickRef !== false)
				.onChange(async (v) => {
					this.plugin.settings.showQuickRef = v;
					await this.plugin.saveSettings();
					quickRefEl.style.display = v ? '' : 'none';
				}));

		// Show ribbon icon
		new obsidian.Setting(containerEl)
			.setName('Show ribbon icon')
			.setDesc('Display the RegEx Find/Replace icon in the left ribbon. The icon opens the popup modal.')
			.addToggle(t => t.setValue(this.plugin.settings.showRibbonIcon !== false)
				.onChange(async (v) => {
					this.plugin.settings.showRibbonIcon = v;
					await this.plugin.saveSettings();
					if (v) {
						this.plugin._ribbonIcon = this.plugin.addRibbonIcon(
							'search-x', 'RegEx Find/Replace', () => this.plugin.openPopup()
						);
					} else if (this.plugin._ribbonIcon) {
						this.plugin._ribbonIcon.remove();
						this.plugin._ribbonIcon = null;
					}
				}));

		// Show match display box
		new obsidian.Setting(containerEl)
			.setName('Show match display')
			.setDesc('Shows a display with the text of the current match.')
			.addToggle(t => t.setValue(this.plugin.settings.showMatchDisplay !== false)
				.onChange(async (v) => {
					this.plugin.settings.showMatchDisplay = v;
					await this.plugin.saveSettings();
					this.plugin.notifySettingsChange();
				}));

		// ── Flags ─────────────────────────────────────────────────────────────

		containerEl.createEl('h4', { text: 'Regex Flags' });

		new obsidian.Setting(containerEl)
			.setName('g - Global')
			.setDesc('This flag is required for Replace All, and Find/Replace in Files to work correctly.');

		const flagToggles = {};
		[
			{ key: 'i', name: 'i - Ignore case', desc: 'Case-insensitive matching.' },
			{ key: 'm', name: 'm - Multiline',   desc: '^ and $ match the start/end of each line instead of the whole document.' },
			{ key: 'u', name: 'u - Unicode',     desc: 'Unicode support. Also upgrades character classes (like \w) to be Unicode-aware.' },
			{ key: 'v', name: 'v - Unicode Sets',desc: 'Expanded Unicode support. Allows more advanced operations.' },
			{ key: 's', name: 's - Dots All',    desc: 'Makes . match newline characters (like \n) as well.' },
		].forEach(({ key, name, desc }) => {
			new obsidian.Setting(containerEl)
				.setName(name).setDesc(desc)
				.addToggle(t => {
					flagToggles[key] = t;
					t.setValue(this.plugin.settings.regexFlags?.[key] ?? DEFAULT_SETTINGS.regexFlags[key] ?? false)
					 .onChange(async (v) => {
						if (!this.plugin.settings.regexFlags) this.plugin.settings.regexFlags = {};
						this.plugin.settings.regexFlags[key] = v;
						if (v && key === 'u') { this.plugin.settings.regexFlags['v'] = false; flagToggles['v']?.setValue(false); }
						if (v && key === 'v') { this.plugin.settings.regexFlags['u'] = false; flagToggles['u']?.setValue(false); }
						await this.plugin.saveSettings();
						this.plugin.notifySettingsChange();
						renderUnicodeRows();
					});
				});
		});

		// ── Flag extentions ───────────────────────────────────────────────────

		containerEl.createEl('h4', { text: 'Flag Extensions' });

		// \d extention for Unicode numerals
		new obsidian.Setting(containerEl)
			.setName('/u flag + \\d → Unicode numerals')
			.setDesc('When the u or v flag is active, replaces \\d with \\p{N} and \\D with \\P{N}, matching digits from all scripts (Arabic-Indic, Devanagari, etc.) in addition to 0–9.\nDont use this, unless you specifically need those digits.')
			.addToggle(t => t
				.setValue(this.plugin.settings.unicodeN ?? false)
				.onChange(async (v) => {
					this.plugin.settings.unicodeN = v;
					await this.plugin.saveSettings();
				}));

		// ── History ───────────────────────────────────────────────────────────

		containerEl.createEl('h4', { text: 'History' });

		// Max history entries
		new obsidian.Setting(containerEl)
			.setName('Max history entries')
			.setDesc('Number of recent searches to remember per field. ↑/↓ in inputs to cycle; click ▾ for the list. Existing entries are trimmed. Set to 0 to just stop recording new entries.')
			.addSlider(s => s
				.setLimits(0, 100, 5)
				.setValue(this.plugin.settings.maxHistory ?? 10)
				.setDynamicTooltip()
				.onChange(async (v) => {
					this.plugin.settings.maxHistory = v;
					await this.plugin.saveSettings();
					this.plugin.notifySettingsChange();
				}));

		// Clear history
		new obsidian.Setting(containerEl)
			.setName('Clear history')
			.setDesc('Permanently delete all saved search/replace/path history entries.')
			.addButton(b => b.setButtonText('Clear').setWarning()
				.onClick(async () => {
					logMsg(this.plugin.settings, `[History] Clearing all: ${this.plugin.settings.findHistory.length} find, ${this.plugin.settings.replaceHistory.length} replace, ${this.plugin.settings.pathHistory.length} path entries.`);
					this.plugin.settings.findHistory    = [];
					this.plugin.settings.replaceHistory = [];
					this.plugin.settings.pathHistory    = [];
					await this.plugin.saveSettings();
					this.plugin.notifySettingsChange();
					notice(this.plugin.settings, 'History cleared.');
				}));

		// ── Debugging ─────────────────────────────────────────────────────────

		containerEl.createEl('h4', { text: 'Debugging' });

		// Logger
		new obsidian.Setting(containerEl)
			.setName('Log to console')
			.setDesc('Logs operations to the console. Useful for debugging.')
			.addToggle(t => t.setValue(!!this.plugin.settings.logToConsole)
				.onChange(async (v) => {
					this.plugin.settings.logToConsole = v;
					await this.plugin.saveSettings();
				}));
	}
}

module.exports = RegexFindReplacePlugin;
