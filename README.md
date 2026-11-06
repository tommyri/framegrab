<img src="assets/icon.svg" alt="" width="72" height="72">

# Framegrab

A Chromium browser extension (Brave, Chrome, Edge) for developer screenshots. Each capture goes straight to the clipboard, ready to paste into a GitHub PR or Slack.

## Install

1. Download and unzip the [latest release](https://github.com/tommyri/framegrab/releases/latest), or clone this repo.
2. Open `brave://extensions` (or `chrome://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and choose the unzipped folder, or the `extension` folder in a clone.
5. Pin Framegrab to the toolbar.

After changing the code, click the reload icon on the extension's card.

## Use

| Capture | Shortcut (macOS) | What you get |
| --- | --- | --- |
| Visible area | `⌥⇧V` | The window as you see it |
| Select an area | None by default | Any rectangle you drag across the window |
| Full page | `⌥⇧F` | The whole page, scrolled and stitched |
| Pick an element | `⌥⇧E` | One element, even if it's taller than the window |

To select an area, drag a rectangle and release to capture. You can scroll before you start dragging, and `Esc` cancels.

In the picker, click to capture. `↑` and `↓` move to the parent or child element, `Enter` captures and `Esc` cancels. `Esc` also stops a full-page capture.

### Before/after

1. Capture the area as it looks now, then choose **Set as before** in the toast. A **B** badge appears on the toolbar icon.
2. Make your change.
3. Press `⌥⇧A` (`Alt+Shift+G` on Windows and Linux) or choose **Capture after** in the popup.

You get one labelled image on your clipboard. Framegrab repeats the same kind of capture as the before. For an element it finds the same one again, even after a reload. If it can't find it, the picker opens, and if it finds the wrong one, choose **Pick element** in the toast. For an area it captures the same part of the window, so keep the page scrolled to the same place. Choose **Select area** in the toast to select it again.

Images sit side by side when they're narrow or tall, and stack when they're wide. The before stays saved so you can keep iterating, until you choose **Clear before** or set a new one. Regular captures are never combined.

### Blur

Choose **Blur items** in the popup, then press `Enter` when you're done:

- **Part of a line:** drag across the text you want hidden, such as a token in a sentence.
- **A whole element:** click it. `↑` and `↓` move to the parent or child element first.

Click a blurred item again to unblur it.

Blurred items stay blurred on the page and in every kind of capture, including after a reload, until you choose **Clear** in the popup or close the browser. Before/after images use the blurs saved with the before image, as well as any on the page. Blurred text from a before image isn't searched for on a different site, so **Capture after** stops there until you blur it again.

Framegrab paints a generated frosted patch over the element rather than blurring it. The image contains none of the original pixels, so the content can't be recovered, unlike real blur, which can sometimes be reversed for text. Only the element's size and position remain visible. The patch takes its colour from the surrounding page.

If a blurred item can't be found after the page changes, Framegrab stops and asks before capturing. Blurred text has to be found again exactly, so if the text itself changes, that counts as not found. Framegrab stores a hash to recognise it, not the text. It also refuses to capture if a popup or dialog is open inside a blurred item, because that content would show unblurred.

### Annotate

Choose **Annotate** in the toast to open the capture in a new tab, then add arrows, boxes and text. If the toast has gone, choose **Annotate last capture** in the popup. Choose **Copy** or **Download** to get the finished image.

| Action | How |
| --- | --- |
| Pick a tool | `A` arrow, `B` box, `T` text |
| Move an annotation | Drag it |
| Delete an annotation | Click it, then press `⌫` |
| Change its colour | Click it, then choose a colour |
| Edit text | Double-click it |
| Undo and redo | `⌘Z` and `⇧⌘Z` |

Annotations are saved with the capture, so reloading the tab keeps them, and they stay editable after you copy or download. Framegrab keeps only the last 5 captures, so older ones and their annotations disappear.

Text is a single line, and arrows and boxes can't be resized, so undo and redraw them instead. The toast's **Download** and **Set as before** always use the capture without annotations.

If a shortcut clashes with another one, change it on the browser's extension shortcuts page (`brave://extensions/shortcuts`). Select an area, Blur and Annotate last capture have no default shortcut because browsers allow an extension only four, but you can assign them there.

**Image size** in the popup switches between full resolution and Standard (1x). Standard files are smaller and display at a natural size in a PR.

## Limits

- Full-page capture takes about half a second per screen, because browsers allow two captures per second.
- Images stop at 16,384 px on the long side. Resolution drops first, then the page height is cut off at 16,384 CSS px.
- Elements wider than the window are cropped to its width.
- A selected area has to fit in the window. You can't scroll while dragging, so use Full page or Pick an element for anything taller.
- The picker selects an iframe as a whole, not the elements inside it.
- An element without an id or test id is found again by its position in the page, so a change to the structure around it can select a different element. This also applies to blurs after a reload, so check them before sharing. The toast warns you when that has happened.
- Blur can't select part of a form field's value or reach inside an iframe, only cover the whole element.
- In an app-style layout that scrolls a panel instead of the page, Full page captures that panel.
- Stitched captures hide fixed headers and widgets after the first screen, and sticky elements stay in their normal position.
- Browsers block extensions on internal pages such as `brave://` and the extension stores.
- Plain `http://` sites other than localhost have no clipboard access. The toast's Copy button opens a preview tab that can copy.

## Permissions

`activeTab` gives access only to the tab you invoke Framegrab on, so it can't read other sites. Captures stay on your machine: the last 5 are kept in the extension's local storage and nothing is uploaded.

## Develop

You need Node 22 or later and Chromium from Playwright:

```bash
npm ci
```

```bash
npx playwright install chromium
```

```bash
npm test
```

| Path | Contents |
| --- | --- |
| `extension/` | The extension itself, with no build step |
| `assets/` | Icon sources. Run `npm run icons` after changing them |
| `scripts/` | Icon, packaging and release scripts |
| `tests/` | Tests that run the real extension in Chromium and check the captured pixels |

`npm run package` writes the extension to `dist/framegrab-<version>.zip`.

## Release

Versions use [CalVer](https://calver.org) in the form `YYYY.M.MICRO`, such as `2026.11.0`. `MICRO` counts the releases in a month from 0. Browsers reject version numbers with leading zeros, so the month isn't padded.

Add your changes under **Unreleased** in [CHANGELOG.md](CHANGELOG.md) as you make them. To release:

1. Check what would be released, if you like, with `npm run release:preview`.
2. In GitHub, open **Actions**, choose **Release** and click **Run workflow** on `main`.

The workflow runs the tests, sets the version, moves the changelog entries under it, commits and tags on `main`, and publishes a GitHub release with the zip attached. It stops if **Unreleased** is empty. Tick **dry run** to do everything except the commit, tag and release.

If you protect `main`, allow GitHub Actions to push to it, or the release's commit will be rejected.

## License

[MIT](LICENSE)
