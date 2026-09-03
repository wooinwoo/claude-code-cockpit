# Product
<!-- impeccable:product-schema 1 -->

## Platform

Web application packaged as a Tauri desktop app, with browser, PWA, LAN, and mobile access.

## Users

Developers who operate multiple local projects and Claude Code sessions from one machine.

## Product Purpose

Provide one local workspace for terminal sessions, project status, Git operations, pull requests, costs, development servers, and automation.

## Positioning

Cockpit is a terminal multiplexer with nearby project operations, rather than a reporting dashboard with a terminal added to it.

## Operating Context

The desktop terminal is the primary surface and accounts for approximately 99% of current use. Browser and mobile access remain supported for remote checks and lightweight control.

## Capabilities and Constraints

- Preserve the existing HTTP, SSE, and WebSocket contracts.
- Preserve xterm.js terminal creation, restore, split, search, broadcast, export, and mobile controls.
- Preserve every existing secondary view and action.
- The frontend information architecture and DOM may be replaced when that improves usability.
- Keep the existing Vanilla JavaScript behavior modules while using a Tailwind CSS build for the new shell; a framework migration must justify rewriting the terminal integration.
- Remain runtime-independent from Praetorium: do not import it, launch it, call its APIs, or read its state.
- Do not fabricate project status, usage, or operational metrics.

## Brand Commitments

Keep the Cockpit name and factual product copy. The existing visual treatment is an anti-reference; a complete terminal-first visual replacement is authorized.

## Evidence on Hand

The repository README, working frontend and backend, local iconography, fonts, and established feature set are the product evidence.

## Product Principles

- Terminal first and interruption free.
- Important state remains visible without covering terminal output.
- Advanced tools stay one action away but visually quiet.
- Keyboard operation is a first-class workflow.
- Desktop, Tauri, browser, and mobile behavior remain reliable.

## Accessibility & Inclusion

Maintain visible focus, sufficient contrast, reduced-motion support, semantic controls, keyboard reachability, and usable mobile touch targets.
