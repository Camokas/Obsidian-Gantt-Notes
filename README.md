<div align="center">

# Gantt Notes

**A Gantt timeline that lives inside an ordinary Obsidian note.**

Lanes · draggable bars · notes per bar · smooth animations · dark theme · desktop and mobile

Plain-text storage that syncs cleanly with [Remotely Save](https://github.com/remotely-save/remotely-save) (WebDAV, S3, …)

</div>

> [!NOTE]
> This plugin was written with AI assistance (Claude) in a "vibe coding" style. It has been tested on desktop; touch gestures on Android are newer and less battle-tested. Keep a backup of notes you care about, and please open an issue if something misbehaves.

## Features

- **A Gantt note is just a note.** A normal `.md` file with a `gantt-plugin` frontmatter key. Search, links, backlinks and version history keep working.
- **Fast editing.** Drag across an empty lane (or double-click) to create a bar. Drag a bar to move it, even to another lane. Drag its edges to resize. Click to edit title, dates, colour, progress and a free-form note with `[[links]]`.
- **Lanes** with colours, collapse/expand and reordering. Overlapping bars stack automatically.
- **Timeline** with Day / Week / Month presets, free zoom (Ctrl + wheel or pinch), weekend shading, a *today* line and a live date tooltip while dragging.
- **Undo / redo** (Ctrl+Z / Ctrl+Y) for every change.
- **Smooth, theme-aware UI.** Follows your Obsidian theme (looks best in dark), animated moves, resizes and zoom. Animations can be switched off.
- **Mobile friendly.** Long-press a bar and drag, pinch to zoom, large touch targets.
- **Quiet by default.** Notes are written only after real edits; opening and scrolling never touch the file. Network access occurs only when you press the update button.
- **Sync-safe editing.** Changes are written promptly, downloaded files are reloaded after Remotely Save finishes, and independent edits from two devices are merged by lane/bar ID.
- **Manual updates.** Check and install published GitHub releases from the plugin settings; GitHub is contacted only when you press the update button.
- English and Russian interface.

## Install

### Manual
1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](../../releases/latest).
2. Put them in `<your vault>/.obsidian/plugins/gantt-notes/`.
3. In Obsidian: **Settings → Community plugins**, turn off Restricted mode, enable **Gantt Notes**.

### With BRAT
Add this repository in the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin.

### On Android / iOS with Remotely Save
Enable Remotely Save's option to sync the config folder (`.obsidian`), sync on desktop, then fully restart Obsidian on the phone and enable the plugin.

## Usage

| Action | How |
| --- | --- |
| New Gantt note | Ribbon icon, command **New Gantt note**, or right-click a folder |
| Turn an existing note into a Gantt | Command **Convert this note to a Gantt note** |
| Create a bar | Drag across an empty lane, double-click, or **Add bar** |
| Move / resize | Drag the bar / drag its edges (touch: long-press first) |
| Edit, duplicate, delete | Click the bar (right-click on desktop for a menu) |
| Zoom | Day / Week / Month buttons, Ctrl + wheel, pinch |
| See the raw Markdown | Tab menu → **Open as Markdown**, or command **Toggle Gantt / Markdown view** |

## How it is stored

````markdown
---
gantt-plugin: timeline
---

```gantt
{"t":"lane","id":"k3x9aa","name":"Project","color":"#7c6cf0"}
{"t":"bar","id":"p0q1zz","lane":"k3x9aa","name":"Planning","start":"2026-11-15","end":"2026-11-21","progress":60}
{"t":"bar","id":"m7d2cc","lane":"k3x9aa","name":"Build","start":"2026-11-21","end":"2026-11-30","note":"See [[Spec]]"}
```
````

One JSON object per line, in a deterministic order, so edits produce tiny diffs and sync tools rarely conflict. Lines the plugin does not understand are preserved untouched. Anything you write above or below the block stays as it is.

## Development

```bash
npm install
npm run build                      # typecheck + production bundle
npm test                           # round-trip tests for the note format
npm run deploy -- "D:\path\to\vault"   # copy the build into a vault
```

Source layout: `src/model.ts` (format and dates), `src/view.ts` (timeline UI and gestures), `src/modals.ts`, `src/settings.ts`, `styles.css`.

Releases are built by GitHub Actions when a `v*` tag is pushed.

## Sync behaviour

Gantt Notes follows Obsidian's `TextFileView` contract, so an open chart reloads when Remotely Save replaces its Markdown file. If local edits and a downloaded version overlap, independent field changes are combined. When the same field was changed differently on both devices, the still-open local edit wins. Remotely Save's own conflict policy still applies before the file reaches Gantt Notes.

## Known limitations

- No read-only preview when a Gantt note is embedded in another note (`![[...]]`) or shown in Reading view; there you see the code block.
- A true same-field conflict cannot be combined automatically; the open local value is kept.

## License

[MIT](LICENSE)
