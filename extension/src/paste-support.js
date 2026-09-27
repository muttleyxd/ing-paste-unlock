// Paste support for the Moje ING login page.
//
// Two jobs, one event pipeline:
//
//  1. Ordinary paste fields. The page blocks paste with its own JavaScript, so
//     this script registers its listeners first -- at `document_start` -- in the
//     capture phase, and stops the paste-related events from reaching the page's
//     handlers. The events are never cancelled in this path, so the browser
//     performs its ordinary paste insertion.
//
//  2. The masked password step ("Wpisz wskazane znaki hasła"). The form asks for
//     specific characters of the password, each in its own box, so an ordinary
//     paste cannot fill it: the whole string would land in one box. On paste or
//     Ctrl+V there, the script reads the clipboard and writes the requested
//     characters into the requested boxes itself, then cancels the default
//     insertion. Submitting stays the user's action.
//
// For the same node and phase, listeners fire in registration order, which is
// why `document_start` matters: a listener registered at `document_idle` can
// lose the race to the page's own capture listener on a late re-render.
(() => {
  "use strict";

  const TAG = "[ing-paste-unlock]";
  const CAPTURE = { capture: true };
  const READ_CLIPBOARD = "ing-paste-unlock:read-clipboard";
  const TRAILING_POSITION = /(\d+)\s*$/;
  const MASKED_HOST = /authorization-password|masked/i;

  // ------------------------------------------------------------------ targets

  function isEditableTarget(node) {
    if (!node || typeof node !== "object" || node.nodeType !== 1) return false;
    if (node.tagName === "INPUT" || node.tagName === "TEXTAREA") return true;
    // Checked both ways: the property covers inherited editability, the
    // attribute covers elements in engines where the property is missing.
    if (node.isContentEditable === true) return true;
    const attr = typeof node.getAttribute === "function" ? node.getAttribute("contenteditable") : null;
    return attr !== null && attr.toLowerCase() !== "false";
  }

  function composedPath(event) {
    return typeof event.composedPath === "function" ? event.composedPath() : [event.target];
  }

  // The real ING login renders its password boxes inside several nested open
  // shadow roots, so a listener out here sees `event.target` retargeted to the
  // host custom element (`login-oauth-subapp`). The element that actually owns
  // the edit is the innermost node of the composed path.
  function findEditableInPath(event) {
    for (const node of composedPath(event)) {
      if (isEditableTarget(node)) return node;
    }
    return null;
  }

  // Deliberately never calls preventDefault(): only the page's handlers are
  // silenced, so the browser's default paste still runs. Kept synchronous and
  // free of DOM or clipboard access so it cannot disturb that default action.
  function intercept(event, kind) {
    const editable = findEditableInPath(event);
    if (!editable) return;
    event.stopImmediatePropagation();
    console.debug(TAG, "let", kind, "through on", String(editable.tagName).toLowerCase());
  }

  // ------------------------------------------------------- masked password step

  function collectPasswordBoxes() {
    const boxes = [];
    const visit = (root) => {
      for (const input of root.querySelectorAll("input")) {
        if (input.type === "password") boxes.push(input);
      }
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot) visit(element.shadowRoot);
      }
    };
    visit(document);
    return boxes;
  }

  // A box belongs to the masked password step when its shadow root host is the
  // masked-password component, or when that host holds several password boxes.
  // An ordinary password field is a single input in the light DOM and must keep
  // the ordinary paste path instead of hijacking Ctrl+V.
  function isMaskedStepBox(box) {
    const root = typeof box.getRootNode === "function" ? box.getRootNode() : null;
    const host = root && root.host ? root.host : null;
    if (!host) return false;
    const tag = typeof host.tagName === "string" ? host.tagName : "";
    if (MASKED_HOST.test(tag)) return true;
    let siblings = 0;
    for (const input of root.querySelectorAll("input")) {
      if (input.type === "password") siblings += 1;
    }
    return siblings > 1;
  }

  function maskedStepBoxes() {
    return collectPasswordBoxes().filter((box) => isMaskedStepBox(box));
  }

  // The site enables exactly the positions it asks for and disables the rest, so
  // an enabled box is a requested one. Its 1-based position comes from the
  // trailing number of its name (`password-3` -> position 4), falling back to
  // document order.
  function requestedBoxes() {
    const requested = [];
    maskedStepBoxes().forEach((box, index) => {
      if (box.disabled) return;
      const match = TRAILING_POSITION.exec(box.name || box.id || "");
      requested.push({ box, position: match ? Number(match[1]) + 1 : index + 1 });
    });
    return requested;
  }

  function isMaskedStepEvent(event) {
    const boxes = requestedBoxes();
    if (!boxes.length) return false;
    const path = composedPath(event);
    if (path.some((node) => boxes.some((entry) => entry.box === node))) return true;
    // Ctrl+V with nothing editable under the cursor, right after the step
    // appeared: treat it as "fill the form" too, but never steal a paste aimed
    // at another field on the page.
    return !path.some((node) => isEditableTarget(node));
  }

  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

  function pressKey(box, type, character) {
    const keyCode = character.charCodeAt(0);
    box.dispatchEvent(
      new KeyboardEvent(type, {
        key: character,
        code: `Key${character.toUpperCase()}`,
        keyCode,
        which: keyCode,
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
  }

  // The widget may take the character from the keystroke and keep its own model,
  // so mimic a real key first and only write the value directly if that left the
  // box empty. `insertText` rather than `insertFromPaste` on purpose: the site's
  // paste blocker must not be provoked by our own insertion.
  function typeCharacter(box, character) {
    box.focus();
    pressKey(box, "keydown", character);
    pressKey(box, "keypress", character);
    if (box.value !== character && typeof valueSetter === "function") {
      valueSetter.call(box, character);
      box.dispatchEvent(
        new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: character }),
      );
    }
    pressKey(box, "keyup", character);
  }

  async function readClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (typeof text === "string") return text;
    } catch (error) {
      console.debug(TAG, "content-script clipboard read refused:", String(error));
    }
    try {
      const answer = await browser.runtime.sendMessage({ type: READ_CLIPBOARD });
      if (answer && typeof answer.text === "string") return answer.text;
      console.debug(TAG, "background clipboard read failed:", answer ? String(answer.error) : "no answer");
    } catch (error) {
      console.debug(TAG, "background clipboard request failed:", String(error));
    }
    return null;
  }

  function fillMaskedPassword(password) {
    const requested = requestedBoxes();
    const missing = [];
    let filled = 0;
    for (const { box, position } of requested) {
      const character = password[position - 1];
      if (!character) {
        missing.push(position);
        continue;
      }
      typeCharacter(box, character);
      filled += 1;
    }
    console.debug(
      TAG,
      "filled",
      filled,
      "of",
      requested.length,
      "requested box(es)",
      requested.map((entry) => entry.position).join(","),
      missing.length ? `- clipboard shorter than position(s) ${missing.join(",")}` : "",
    );
  }

  // The clipboard read is asynchronous while preventDefault has to happen now,
  // so the default insertion is cancelled first: a whole password dropped into a
  // single-character box would be rejected anyway.
  async function fillFromClipboard(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const password = await readClipboard();
    if (password === null) {
      console.debug(TAG, "could not read the clipboard, nothing was filled");
      return;
    }
    fillMaskedPassword(password);
  }

  // ----------------------------------------------------------------- listeners

  window.addEventListener(
    "paste",
    (event) => {
      if (isMaskedStepEvent(event)) {
        void fillFromClipboard(event);
        return;
      }
      intercept(event, "paste");
    },
    CAPTURE,
  );

  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "v" && event.key !== "V") return;
      if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (isMaskedStepEvent(event)) {
        void fillFromClipboard(event);
        return;
      }
      intercept(event, "Ctrl+V keydown");
    },
    CAPTURE,
  );

  window.addEventListener(
    "beforeinput",
    (event) => {
      if (typeof event.inputType !== "string" || !event.inputType.startsWith("insertFromPaste")) return;
      intercept(event, event.inputType);
    },
    CAPTURE,
  );
})();
