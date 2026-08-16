# Agent Note: Desktop model image capability control

Status: implemented

[中文](2026-08-16-desktop-model-image-capability.zh.md)

## Problem

The Desktop runtime consumes the published `@deepseek-ai/dsh-client-ui-settings-models` bundle. Hand-declared third-party models default to text input, but the published model editor does not expose the existing `input` modality declaration. Users must otherwise edit `settings.yaml` to enable a provider model that accepts images.

## Decision

Desktop applies a Yarn patch to the pinned rc.6 model settings bundle. Each model row's expanded capability section gains an Image input checkbox. The control writes `input: [text, image]` when enabled and `input: [text]` when disabled. The default remains text-only, and the Host's existing image admission check remains authoritative.

The patch is scoped to the published client bundle consumed by Desktop. It does not modify the pinned upstream submodule or introduce a second settings service. The resolution is version-pinned so a future upstream package change requires an explicit patch refresh.

## Consequences

Desktop users can configure third-party vision models without leaving the application. The Desktop image picker and the model capability control are independent: the picker supplies image content, while the model setting declares whether the selected route may receive it.

A declaration remains an explicit claim about the endpoint. If the endpoint rejects images, the provider error remains possible and the user must disable the capability.

## Verification

The package surface test asserts the patch resolution and its image capability mutation. The image picker and package tests pass, and the Desktop package builds with the patch installed.
