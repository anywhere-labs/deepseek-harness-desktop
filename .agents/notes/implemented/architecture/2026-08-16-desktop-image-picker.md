# Agent Note: Desktop image picker over the upstream attachment path

Status: implemented

English | [中文](2026-08-16-desktop-image-picker.zh.md)

## Problem

The published conversation client accepts image paste and whole-window drop, but its visible plus button opens commands and it exposes no click-to-select image control. Desktop users therefore cannot discover the active attachment capability from the composer chrome.

## Decision

The Desktop Client contributes a paperclip control through the official `conversation.input.left` list slot in compatibility and advanced modes. A hidden browser file input accepts PNG, JPEG, WebP, and GIF images and supports multiple selection and same-file reselection.

The contribution delegates browser draft registration, object URL ownership, input-state ids, preview rail, removal, upload serialization, Host validation, durable storage, prompt admission, and historical rendering to the existing `@deepseek-ai/dsh-client-ui-conversation` controller. Desktop validates the projected count and byte limits before it creates previews, then releases newly created drafts if the input machine refuses their ids.

This control does not claim general file support. The rc.6 durable attachment API and message content model accept raster images only. Adding documents requires a complete upstream attachment capability rather than encoding file paths or document bytes into prompt text.

## Consequences

Both Desktop presentation modes gain the same discoverable image action without replacing the upstream composer or modifying the pinned source submodule. Paste and drag-and-drop continue to use the original path, and sent messages keep the existing durable image references and authorized history reads.

The implementation uses the concrete published conversation controller because its outward service interface does not expose draft-image creation. A future upstream scoped intake operation can replace that narrow adapter without changing the picker component.

## Verification

The Desktop client typecheck covers the slot and controller integration. Focused tests cover accepted image formats and projected count, per-image, and aggregate byte limits. The package build and Loader smoke verify the published client bundle and profile composition.
