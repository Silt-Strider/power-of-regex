![release](https://img.shields.io/github/v/release/Silt-Strider/power-of-regex)
![downloads](https://img.shields.io/github/downloads/Silt-Strider/power-of-regex/total.svg)

```power-of-regex-search
 /$$$$$$$           /$$$$$$$  /$$$$$$$$          
| $$__  $$         | $$__  $$| $$_____/          
| $$  \ $$ /$$$$$$ | $$  \ $$| $$        /$$$$$$$
| $$$$$$$//$$__  $$| $$$$$$/ | $$$$$    /$$_____/
| $$____/| $$  \ $$| $$__ \$\| $$__/   |  $$$$$$ 
| $$     | $$  | $$| $$  \ $$| $$       \____  $$
| $$     |  $$$$$$/| $$  | $$| $$$$$$$$ /$$$$$$$/
|__/      \______/ |__/  |__/|________/|_______/ 
```

# Obsidian Plugin - **Power of RegEx search**
Provides a dialog to find and replace text in the currently opened note
In addition to the Obsidian on-board find/replace function, this plugin provides options to
- use regular expressions with customizable flags
- find or replace matches in the currently selected text, the whole document, or in all .md files somewhere in the vault
This plugin aims to do anything regarding RegEx, that can be done in Notepad++

Desktop and mobile versions of Obsidian are supported

![Regex FindReplace Dialog](res/dialog.png)

## How to use
- Type `regex` in the command palette and select "Open Find and Replace" as a popup or side panel (or use the ribbon button)
- Use the text boxes to type the expression to find a match, and another one to replace it with
- Use the Buttons to Find/Replace the next match, or all matches
- Some behavior can be changed in the settings, or with the toggles in the dialog
- Some supported regular expression syntax can be found in the settings for reference
- The input fields each save their content history that can be accessed using the dropdown and the arrow keys

### Features
**Find & Replace** (active editor)
- Find Next: Navigates to the next RegEx match
- Replace: Replaces the currently selected match and jumps to the next one
- Replace All: Replaces all\* matches in the document
	- In selection: Restricts Replace All to the selected text, also supports multi-cursor / non-contiguous selections
	- Wrap around:  Jumps back to the beginning on "Find Next", and makes "Replace All" replace everything (not just from the cursor downwards)
- Pressing `Enter` Finds/Replaces the next match from the text fields

**Find/Replace in Files** (entire Vault)
- Finds/replaces across .md files in the vault
- Optional path filter (Folder/Subfolder)
- Replace: Confirmation dialog before replacing: Cannot be undone (yet)
- Find: Clickable list of all found notes with path and number of matches
- Can be toggled on and off in the settings, or with a command

**RegEx Features**
- Full regex support with configurable flags
- Back-reference support in Replace (`\1` or `$1` for the first one, or `(?<name>\w+)` for a named one)
- `\n` and `\t` are correctly processed in replace strings
- Live display of active flags next to the Find field (i.e. `/gmu`)
- RegEx Quick Reference table directly in settings menu (can be hidden)
- Character classes (like `\w` or `\b`) are automatically expanded to include unicode characters with the `/u` and `/v` flag

**History System**
- Separate histories for the Find, Replace, and Path fields
- Navigation via `↑`/`↓` in the input field
- Dropdown button `▾` lists all recent entries
- Select or delete individual entries
- Configurable maximum: 0-100 entries
- History can be cleared entirely via a button in the settings

**UI Modes**
- Popup Modal: Opens in front of the editor
- Side Panel: Persistent sidebar, stays open (can also be popped out)
- Ribbon icon: Opens popup
- Commands: Open the Popup Modal or the Side Panel
- Pre-fill: Setting to let the find field get populated by the current selection (Popup only)
- Match display: Displays the current match also as text (especially handy on mobile)


## How to install

### From inside Obsidian
This plugin can be installed via the `Community Plugins` tab in the Obsidian Options dialog:
- Disable Safe Mode (to enable community plugins to be installed)
- Browse the community plugins searching for "power of regex"
- Install the Plugin
- Enable the plugin

### Manual installation
The plugin can also be installed manually from the repository:
- Create a new directory in your vaults plugins directory, e.g.   
	`.obsidian/plugins/power-of-regex`

- Head over to https://github.com/Silt-Strider/power-of-regex

- From the latest release, download the files
	- main.js
	- manifest.json
	- styles.css
	  to your newly created plugin directory

- Launch Obsidian and open the settings dialog
- Disable Safe Mode in the "Community Plugins" tab (this allows community plugins to be enabled)
- Enable the plugin


## Major Features Planned for V2.X
- [x] New regex window for the side panel
- [x] Better history system
- [x] Expanded unicode support
- [x] Find/Replace files in Vault
- [ ] Simple if-then logic functionality for capture groups
- [ ] Option to "Favorite" regular expressions for quick access
- [ ] An "Undo" button for "Replace in Files"
- [ ] Persistently mark matches
- [ ] Support for canvas operations


## Version History

### 1.0.0
**Initial Release**: [Regex Find/Replace](https://github.com/Gru80/obsidian-regex-replace)

### 1.1.0
- Case insensitive search can now be enabled in the settings panel of the plugin (regex flag `/i`)
- Find-in-selection toggle switch is disabled if no text is selected in the note
- Performance improvements and bug-fixes

### 1.2.0
- Option to interpret `\n` in replace field to insert line-break accordingly
- Option to pre-fill the find-field with the selected word or phrase
- Used regex-modifier flags are shown in the dialog
 
### 1.3.0
- Resumed plugin development in 2025, after the previous author had 3 years of inactivity (for personal use)
- Made the window remember last used expression in the "Find" and "Replace" text field
- Added functionality to reference capture groups with `\1` to `\9`

### 2.0.0
**Big Update**:
- Organizational:
	- Decided to share the modified plugin (permission was granted in the license)
	- Released "Power of RegEx search" on GitHub and submitted to review for Obsidian
	- Refactored code with Claude (reviewed and modified it myself)
- Functionality:
	- Added a side panel with the same functionality as the popup
	- Added a "Replace" and "Find Next" button
	- Added a longer (adjustable) history length and a drop down menu to select them (using `↑`/`↓` also works)
	- Added the regex flags to settings (`/gimusy`)
	- Now supports CJK characters (regex flag `/u`)
	- Added toggleable "Wrap around" setting
- User Interface:
	- Removed option "Use regular expression"     (now always active)
	- Removed option "Process `\n` as line break" (now always active)
	- Removed option "Process `\t` as tab"        (now always active)
	- Added regex reference help to settings menu
	- The toggleable setting "In selection" is now always visible
	- Pressing `Enter` now either triggers "Find" or "Replace", depending on the text box
- Bug Fixes:
	- Clicking `Replace All` no longer scrolls to top of note and unfolds all headers and lists

### 2.1.0
- Major Changes:
	- Added a "Find/Replace in Files" feature, which has to be toggled on first
	- Added a custom match highlight, instead of relying on the selection (now also highlights the line number)
	- Added the `/v` flag, that supersedes `/u` and enables more operations, such as additional "unicode properties" and subtracting characters from a character class
- Medium Changes:
	- Added support for multiple cursors having multiple selections using "in selection" mode
	- Added support for named capture groups like `(?<name>\w+)`, as well numbered groups >9 like `\42` and that `\0` inserts the whole match
	- Added a toggle for the regex "quick reference" and expanded its content (some rows are dynamic with flags)
	- Added a toggleable match display box showing the matched text
	- Added a toggle to match zero-length matches
	- Added a toggle for the ribbon icon
- Minor Changes:
	- Overhauled how entries are saved to history and made it possible to delete entries
	- Added a toggleable logger, that can be used to debug things and log a history of operations
	- The `/v` (and `/u`) flag now transforms `\d`, `\D`, `\w`, `\W`, `\b`, and `\B` to include unicode characters (`\d` and `\D` optionally)
	- The `/g` flag is essential for many operations and now set to be always active
	- The `/y` flag has been removed as a toggleable option
- Bug Fixes:
	- Fixed bug, where a failed capture group attempt reference would print the call itself, i.e. `\1`
	- Fixed bug, where an expression containing `^` or `$` could find false matches on a "Replace all in selection" operation
		_`$` still matches the end of a selection, but `^` does not match the selection start_ (Notepad++ has the same behavior)
	- Fixed bug, where an expression containing `\b` didnt find correct matches on a "Replace all in selection" operation
	- Fixed bug, where selections sometimes didnt use the correct scope
	- Fixed bugs, where Obsidian could freeze or crash
	- Fixed various smaller bugs

