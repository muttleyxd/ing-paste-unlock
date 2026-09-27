// Background page: reads the clipboard on request.
//
// The content script tries `navigator.clipboard.readText()` first, but Firefox
// refuses that from a content script in some situations (document not focused,
// no user activation). This page has the same `clipboardRead` permission and no
// page-imposed restrictions, so it is the fallback.
browser.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== "ing-paste-unlock:read-clipboard") return undefined;
  return navigator.clipboard.readText().then(
    (text) => ({ text }),
    (error) => ({ error: String(error) }),
  );
});
