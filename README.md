# ing-paste-unlock

A small Firefox WebExtension for the Moje ING login page, so a password manager's
copy/paste flow works there. Two jobs, both driven by the same event pipeline:

1. **Ordinary paste.** The page blocks paste from JavaScript. The add-on registers
   its listeners first and stops the page's blockers from seeing the event, so
   Ctrl+V behaves normally.
2. **The masked password step.** That step asks for *specific characters* of the
   password, each in its own box ("Wpisz wskazane znaki hasła dla loginu - ..."),
   so an ordinary paste cannot fill it. On Ctrl+V there, the add-on reads the
   clipboard itself and writes the requested characters into the requested boxes.

The add-on never submits the form: clicking **Zaloguj** stays your action.

## How it works

The content script registers capture-phase listeners on `window` for `paste`,
`keydown` (Ctrl+V) and `beforeinput` (`insertFromPaste`). Because it is injected
at `document_start`, it registers before any page script, so its listeners run
first. For editable targets it either

- calls `stopImmediatePropagation()` and nothing else, so the browser performs its
  ordinary paste into a normal field, or
- on the masked step, calls `preventDefault()` as well, reads the clipboard, and
  fills the requested boxes character by character.

Targets are found through `event.composedPath()`, because ING's inputs live inside
open shadow roots where `event.target` is retargeted to the host. The masked step
is recognised by its component host name (`ing-authorization-password`, or any
host holding more than one password box); a lone password field keeps the ordinary
path and the clipboard is never read for it.

Filling tries a real key sequence first (`keydown`, `keypress`, then `keyup`) and
only writes the value directly — native `HTMLInputElement` setter plus a bubbling
`input` event with `inputType: "insertText"` — if the keystrokes left the box
empty. `insertText` rather than `insertFromPaste` on purpose, so the site's paste
blocker is not provoked by the add-on's own insertion.

## Permissions and privacy

- `clipboardRead` — required to fill the masked step from Ctrl+V. The clipboard is
  read only when you paste on the masked form, never on page load, never on any
  other host.
- Host access is limited to `https://login.ingbank.pl/*`.
- No network requests, no storage, no telemetry, no content is transmitted
  anywhere; `data_collection_permissions: none`.
- `src/clipboard.js` is a background page whose only job is the clipboard read,
  used as a fallback when Firefox refuses the read from the content script.

## Scope

- Host: `https://login.ingbank.pl/*` only (the Moje ING login SPA, confirmed
  2026-09-27; the reachable path is `/mojeing/app/#login`).
- Targets: `input`, `textarea` and `contenteditable` elements on that host.
- Not included: publishing to AMO, icons, an options page, auto-submitting the
  login form.

## Build

```sh
npm run check     # web-ext lint + unit tests
npm run build     # web-artifacts/ing_paste_unlock-<version>.xpi (and .zip)
```

## Install

The add-on is not signed, so how you install it depends on your Firefox:

- **Temporary, any Firefox.** `about:debugging#/runtime/this-firefox` →
  *Load Temporary Add-on…* → pick `extension/manifest.json`. It disappears when
  Firefox restarts.
- **Permanent, unsigned.** Needs a Firefox that does not enforce signatures —
  Developer Edition or Nightly. In that profile set
  `about:config` → `xpinstall.signatures.required` → `false`, restart, then
  `about:addons` → gear ⚙ → *Install Add-on From File…* → the built `.xpi`. A
  release Firefox refuses this even with the pref flipped.
- **Permanent, any Firefox.** Sign the add-on through addons.mozilla.org, then
  install the signed `.xpi`.

Add-ons install per profile, not per machine, and the content script only
injects on a fresh document — reload the login page after installing.

While developing, `npm run start` opens Firefox with the add-on loaded straight
from `extension/`, so an edit needs only a page reload.

## Verify

```sh
npm install          # once, for jsdom and web-ext
npm run lint         # web-ext lint --source-dir extension
npm test             # node --test test/
```

`test/paste-support.test.mjs` drives the real `extension/src/paste-support.js`
inside jsdom and pins the contract:

- a page blocker registered after the content script never runs, an inline
  `onpaste` never runs, a `beforeinput` veto never runs, and the paste event stays
  uncancelled in all those cases;
- events from behind a shadow root are still intercepted, and a companion test
  pins the retargeting that makes the composed path necessary;
- on the masked step the requested characters from the clipboard land in exactly
  the requested boxes, a disabled box stays empty, a short clipboard fills only
  what it can, the default insertion is cancelled, and the background page is used
  when the content script cannot read the clipboard;
- a paste aimed at another field is not hijacked, and a lone password input keeps
  the ordinary path without the clipboard being read.

## What the real page does (measured 2026-09-27)

Measured in a live Firefox through remote debugging:

- The login SPA renders inside six nested **open shadow roots**
  (`login-oauth-subapp > provider-login-content > login-form >
  ming-authorization > ing-authorization-nma > ing-authorization-password`),
  so the composed path has to be inspected: at a window-level listener
  `event.target` is retargeted to the outermost host.
- The password step is **hasło maskowane**: 32 per-character
  `input[type=password]` boxes where only the requested positions are enabled
  (an observed run asked for positions 1, 3, 4, 7 and 8). The heading reads
  "Wpisz wskazane znaki hasła dla loginu - ...".
- The page **does** block paste: a `paste` event dispatched on a password box
  comes back `defaultPrevented: true`. `beforeinput` (`insertFromPaste`) and
  `keydown` are not blocked.

## License

Released into the public domain under the [Unlicense](UNLICENSE).
