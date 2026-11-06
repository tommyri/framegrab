# Changelog

Notable changes to Framegrab. Versions use [CalVer](https://calver.org) in the form `YYYY.M.MICRO`.

Add entries under **Unreleased** as you make changes. A release moves them under its version.

## Unreleased

### Added

- Select an area to capture by dragging a rectangle across the window. Before/after images repeat the same area.

## 2026.11.1 - 2026-11-04

### Added

- Blur part of a line by dragging across the text. The page's DOM isn't changed, and a capture stops if the text changes.
- Annotate captures with arrows, boxes and text in a new tab, then copy or download the result. Open it from the toast, or with **Annotate last capture** in the popup.

## 2026.11.0 - 2026-11-04

### Added

- Capture the visible area, the full page or a single element, with each capture copied to the clipboard.
- Stitch pages and elements taller than the window, without repeating fixed headers or sticky elements.
- Pick elements with the mouse or arrow keys, without clicks reaching the page.
- Switch between full-resolution and Standard (1x) images, with a warning above GitHub's 10 MB limit.
- Combine a before and an after capture into one labelled image, finding the same element again after a reload.
- Blur items with a generated patch that contains none of the original pixels. Blurs survive reloads, and a capture stops if a blurred item can't be found.
- App icon.
- MIT license.
