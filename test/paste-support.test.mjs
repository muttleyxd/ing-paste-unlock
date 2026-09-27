// Pins the behaviour of extension/src/paste-support.js:
//  - the propagation contract for ordinary paste: the page's blocker never runs
//    and the event stays uncancelled, so the browser pastes normally;
//  - the masked-password step: the requested characters from the clipboard land
//    in exactly the requested boxes, and the default insertion is cancelled.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const sourcePath = join(dirname(fileURLToPath(import.meta.url)), "..", "extension", "src", "paste-support.js");
const extensionSource = readFileSync(sourcePath, "utf8");

const PASSWORD = "abcdefghijklmno";
// 0-based indexes of the boxes the site leaves enabled; an observed run asked
// for 1-based positions 1, 3, 4, 7 and 8.
const REQUESTED = [0, 2, 3, 6, 7];
const BOX_COUNT = 8;

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met in time");
}

function setup(bodyHtml, options = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const logs = [];
  window.console.debug = (...args) => logs.push(args.join(" "));
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: {
      readText:
        options.readText ??
        (async () => {
          throw Object.assign(new Error("clipboard read refused"), { name: "NotAllowedError" });
        }),
    },
  });
  window.browser = {
    runtime: {
      sendMessage: options.sendMessage ?? (async () => ({ error: "no background page in tests" })),
    },
  };
  // Stands in for the content script being injected at document_start, i.e.
  // before any page script gets a chance to register its own listeners.
  window.eval(extensionSource);
  return { window, document: window.document, logs, close: () => dom.window.close() };
}

function inputEvent(window, type, init) {
  const EventCtor = type === "beforeinput" && typeof window.InputEvent === "function" ? window.InputEvent : window.Event;
  const event = new EventCtor(type, { bubbles: true, cancelable: true, ...init });
  if (type === "beforeinput" && event.inputType !== init.inputType) {
    Object.defineProperty(event, "inputType", { value: init.inputType });
  }
  return event;
}

// The masked step lives in a shadow root on the real page, so the fixture does
// too: that is what makes `event.target` retargeting part of the contract.
function maskedStep(window, document, { boxCount = BOX_COUNT, requested = REQUESTED } = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  const boxes = [];
  for (let index = 0; index < boxCount; index += 1) {
    const input = document.createElement("input");
    input.type = "password";
    input.name = `password-${index}`;
    input.disabled = !requested.includes(index);
    shadow.append(input);
    boxes.push(input);
  }
  return { host, boxes };
}

function blockerOn(window, type = "paste") {
  const state = { ran: false };
  window.addEventListener(
    type,
    (event) => {
      state.ran = true;
      event.preventDefault();
    },
    true,
  );
  return state;
}

test("a capture listener registered after the content script cannot cancel the paste", () => {
  const { window, document, logs, close } = setup('<input id="pw" type="password">');
  const input = document.getElementById("pw");
  const blocker = blockerOn(window);
  let pageTargetRan = false;
  input.addEventListener("paste", () => {
    pageTargetRan = true;
  });

  const event = inputEvent(window, "paste", {});
  input.dispatchEvent(event);

  assert.equal(blocker.ran, false, "the page's capture blocker must never run");
  assert.equal(pageTargetRan, false, "the event must not reach the page's target listener");
  assert.equal(event.defaultPrevented, false, "the paste must stay uncancelled");
  assert.equal(logs.length, 1, "exactly one debug line per intercepted event");
  close();
});

test("an inline onpaste handler is bypassed and the paste stays uncancelled", () => {
  const { window, document, close } = setup(
    '<input id="pw" type="password" onpaste="window.__inlineRan = true; return false">',
  );
  const input = document.getElementById("pw");

  const event = inputEvent(window, "paste", {});
  input.dispatchEvent(event);

  assert.equal(window.__inlineRan, undefined, "the inline handler must never run");
  assert.equal(event.defaultPrevented, false);
  close();
});

test("a beforeinput veto for insertFromPaste is bypassed", () => {
  const { window, document, close } = setup('<input id="pw" type="password">');
  const input = document.getElementById("pw");
  const blocker = blockerOn(window, "beforeinput");

  const event = inputEvent(window, "beforeinput", { inputType: "insertFromPaste" });
  input.dispatchEvent(event);

  assert.equal(blocker.ran, false);
  assert.equal(event.defaultPrevented, false);
  close();
});

test("Ctrl+V is intercepted, other keys are left alone", () => {
  const { window, document, close } = setup('<input id="pw" type="password">');
  const input = document.getElementById("pw");
  const seen = [];
  window.addEventListener(
    "keydown",
    (event) => {
      seen.push(event.key);
      event.preventDefault();
    },
    true,
  );

  const pasteKey = new window.KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true, cancelable: true });
  input.dispatchEvent(pasteKey);
  assert.deepEqual(seen, [], "the page must not see Ctrl+V");
  assert.equal(pasteKey.defaultPrevented, false);

  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));
  assert.deepEqual(seen, ["a"], "unrelated keys must still reach the page");
  close();
});

test("non-editable targets are not touched", () => {
  const { window, document, logs, close } = setup('<div id="box">tekst</div>');
  const blocker = blockerOn(window);

  document.getElementById("box").dispatchEvent(inputEvent(window, "paste", {}));

  assert.equal(blocker.ran, true, "the page keeps its own paste handling outside editable fields");
  assert.equal(logs.length, 0);
  close();
});

test("editable targets behind an open shadow root are intercepted", () => {
  const { window, document, close } = setup('<div id="host"></div>');
  const shadow = document.getElementById("host").attachShadow({ mode: "open" });
  shadow.innerHTML = '<input id="pw" type="password" disabled>';
  const input = shadow.getElementById("pw");
  const blocker = blockerOn(window);

  const event = inputEvent(window, "paste", { composed: true });
  input.dispatchEvent(event);

  assert.equal(blocker.ran, false, "the page's blocker must not see the retargeted event");
  assert.equal(event.defaultPrevented, false);
  close();
});

test("the page sees events from a shadow root retargeted to the host", () => {
  const { window, document, close } = setup('<div id="host"></div>');
  const host = document.getElementById("host");
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = '<div id="plain">nie pole</div>';
  const seen = [];
  window.addEventListener("paste", (event) => seen.push(event.target), true);

  shadow.getElementById("plain").dispatchEvent(inputEvent(window, "paste", { composed: true }));

  assert.deepEqual(seen, [host], "retargeting is why the composed path has to be inspected");
  close();
});

test("textarea and contenteditable targets are protected too", () => {
  const { window, document, close } = setup('<textarea id="ta"></textarea><div id="ed" contenteditable="true"></div>');
  const blocker = blockerOn(window);

  const textareaEvent = inputEvent(window, "paste", {});
  document.getElementById("ta").dispatchEvent(textareaEvent);
  assert.equal(blocker.ran, false);
  assert.equal(textareaEvent.defaultPrevented, false);

  document.getElementById("ed").dispatchEvent(inputEvent(window, "paste", {}));
  assert.equal(blocker.ran, false);
  close();
});

test("masked step: a paste fills only the requested boxes from the clipboard", async () => {
  let reads = 0;
  const { window, document, close } = setup("", {
    readText: async () => {
      reads += 1;
      return PASSWORD;
    },
  });
  const { boxes } = maskedStep(window, document);
  const blocker = blockerOn(window);

  const event = inputEvent(window, "paste", { composed: true });
  boxes[REQUESTED[0]].dispatchEvent(event);
  await waitFor(() => boxes[REQUESTED[0]].value === PASSWORD[REQUESTED[0]]);

  assert.equal(event.defaultPrevented, true, "the whole string must never be inserted into one box");
  assert.equal(blocker.ran, false, "the page's blocker is still silenced");
  assert.equal(reads, 1);
  for (const index of REQUESTED) {
    assert.equal(boxes[index].value, PASSWORD[index], `box ${index} must hold character ${index + 1} of the password`);
  }
  for (const index of boxes.keys()) {
    if (!REQUESTED.includes(index)) {
      assert.equal(boxes[index].value, "", `box ${index} is not requested and must stay empty`);
    }
  }
  close();
});

test("masked step: Ctrl+V is the same trigger", async () => {
  const { window, document, close } = setup("", { readText: async () => PASSWORD });
  const { boxes } = maskedStep(window, document);

  const event = new window.KeyboardEvent("keydown", {
    key: "v",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  boxes[REQUESTED[0]].dispatchEvent(event);
  await waitFor(() => boxes[REQUESTED[0]].value === PASSWORD[REQUESTED[0]]);

  assert.equal(event.defaultPrevented, true, "the browser must not paste the whole string itself");
  for (const index of REQUESTED) {
    assert.equal(boxes[index].value, PASSWORD[index]);
  }
  close();
});

test("masked step: falls back to the background page for the clipboard", async () => {
  const asked = [];
  const { window, document, close } = setup("", {
    readText: async () => {
      throw Object.assign(new Error("clipboard read refused"), { name: "NotAllowedError" });
    },
    sendMessage: async (message) => {
      asked.push(message);
      return { text: PASSWORD };
    },
  });
  const { boxes } = maskedStep(window, document);

  boxes[REQUESTED[0]].dispatchEvent(inputEvent(window, "paste", { composed: true }));
  await waitFor(() => boxes[REQUESTED[0]].value === PASSWORD[REQUESTED[0]]);

  assert.equal(asked.length, 1);
  assert.equal(asked[0].type, "ing-paste-unlock:read-clipboard");
  for (const index of REQUESTED) {
    assert.equal(boxes[index].value, PASSWORD[index]);
  }
  close();
});

test("masked step: the component host name alone identifies the widget", async () => {
  const { window, document, close } = setup('<masked-fixture></masked-fixture>', { readText: async () => "z" });
  const host = document.createElement("ing-authorization-password");
  document.body.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = '<input type="password" name="password-0">';
  const box = shadow.querySelector("input");

  box.dispatchEvent(inputEvent(window, "paste", { composed: true }));
  await waitFor(() => box.value === "z");

  assert.equal(box.value, "z");
  close();
});

test("a lone password input in the light DOM keeps the ordinary paste path", async () => {
  let reads = 0;
  const { window, document, close } = setup('<input id="pw" type="password">', {
    readText: async () => {
      reads += 1;
      return PASSWORD;
    },
  });
  const input = document.getElementById("pw");
  const blocker = blockerOn(window);

  const event = inputEvent(window, "paste", {});
  input.dispatchEvent(event);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(blocker.ran, false, "the page's blocker is silenced");
  assert.equal(event.defaultPrevented, false, "the paste stays uncancelled");
  assert.equal(reads, 0, "the clipboard must not be touched for an ordinary field");
  assert.equal(input.value, "");
  close();
});

test("masked step: a paste aimed at another text field is not hijacked", async () => {
  const { window, document, close } = setup('<input id="other" type="text">', { readText: async () => PASSWORD });
  const { boxes } = maskedStep(window, document);
  const other = document.getElementById("other");
  const blocker = blockerOn(window);

  const event = inputEvent(window, "paste", { composed: true });
  other.dispatchEvent(event);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(event.defaultPrevented, false, "ordinary paste stays uncancelled");
  assert.equal(blocker.ran, false, "the page's blocker is still silenced");
  for (const box of boxes) {
    assert.equal(box.value, "");
  }
  close();
});

test("masked step: a clipboard shorter than the requested positions fills what it can", async () => {
  const { window, document, close } = setup("", { readText: async () => "abc" });
  const { boxes } = maskedStep(window, document);

  boxes[REQUESTED[0]].dispatchEvent(inputEvent(window, "paste", { composed: true }));
  await waitFor(() => boxes[0].value === "a");
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(boxes[0].value, "a");
  assert.equal(boxes[2].value, "c");
  assert.equal(boxes[3].value, "", "position 4 has no character in a 3-character clipboard");
  assert.equal(boxes[6].value, "");
  assert.equal(boxes[7].value, "");
  close();
});
