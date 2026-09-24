// Content script for in-page password suggestions and the "save this
// password?" prompt - registered by lib/pageCredentials.js only while the
// user has enabled the feature. Runs inside arbitrary web pages, so it
// holds as little as possible: it never sees the vault, only the single
// credential the service worker sends after the user clicks one in the
// extension-owned iframe (content/frame.html). Plain script, not a module:
// dynamically registered content scripts can't be ES modules.
(() => {
  if (window.__browserSyncCredentials) return;
  window.__browserSyncCredentials = true;

  const FRAME_URL = chrome.runtime.getURL("content/frame.html");
  const USERNAME_TYPES = new Set(["text", "email", "tel"]);
  const Z_TOP = "2147483647";

  let menu = null; // { host, field }
  let savePrompt = null;
  let lastCapture = null;

  // ---- Field detection -------------------------------------------------

  function isVisible(el) {
    if (!el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 30 || rect.height < 12) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.1;
  }

  function passwordFields(root = document) {
    return [...root.querySelectorAll('input[type="password"]')].filter(isVisible);
  }

  /** The closest visible text/email field before the password field, within its form when it has one. */
  function findUsernameField(passwordField) {
    const scope = passwordField.form ?? document;
    let candidate = null;
    for (const input of scope.querySelectorAll("input")) {
      if (input === passwordField) break;
      if (USERNAME_TYPES.has(input.type) && isVisible(input)) candidate = input;
    }
    return candidate;
  }

  /** The first visible password field after a username field, within its form when it has one. */
  function findPasswordField(usernameField) {
    const scope = usernameField.form ?? document;
    const fields = passwordFields(scope);
    return fields.find((field) => usernameField.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING) ?? null;
  }

  /**
   * Password fields, the username field that goes with one, and inputs the
   * site itself marks as a username (autocomplete="username") - which also
   * covers "email first, password on the next step" logins.
   */
  function isLoginField(el) {
    if (!(el instanceof HTMLInputElement) || !isVisible(el)) return false;
    if (el.type === "password") return true;
    if (!USERNAME_TYPES.has(el.type)) return false;
    if (/\busername\b/.test(el.autocomplete)) return true;
    const passwordField = findPasswordField(el);
    return Boolean(passwordField) && findUsernameField(passwordField) === el;
  }

  /** The username/password pair a fill should target, starting from whichever of them the menu was opened on. */
  function fieldPair(field) {
    if (field.type === "password") return { usernameField: findUsernameField(field), passwordField: field };
    return { usernameField: field, passwordField: findPasswordField(field) };
  }

  // ---- Key icon ---------------------------------------------------------
  // One icon, shown only inside the login field that has focus.

  let iconField = null;
  const iconHost = createIcon();

  function createIcon() {
    const host = document.createElement("browsersync-icon");
    host.style.cssText = `position:absolute;z-index:${Z_TOP};width:22px;height:22px;margin:0;padding:0;border:0;display:none;`;
    const shadow = host.attachShadow({ mode: "closed" });
    const button = document.createElement("button");
    button.type = "button";
    button.title = "BrowserSync";
    button.setAttribute("aria-label", "BrowserSync");
    button.style.cssText =
      "all:initial;display:flex;align-items:center;justify-content:center;width:22px;height:22px;" +
      "border-radius:5px;background:#2f6fed;cursor:pointer;box-shadow:0 1px 2px rgb(0 0 0 / .25);";
    button.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" ' +
      'stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/>' +
      '<path d="M10.7 12.3 20 3m-4 4 3 3m-5.5-.5 2 2"/></svg>';
    // mousedown, not click: keeps focus in the field, and a page can't
    // synthesize it with isTrusted set.
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!event.isTrusted || !iconField) return;
      if (menu?.field === iconField) closeMenu();
      else openMenu(iconField);
    });
    shadow.appendChild(button);
    return host;
  }

  function showIcon(field) {
    iconField = field;
    // Appended lazily (and re-appended if the page wiped the DOM) so pages
    // without a login form never get our element at all.
    if (!iconHost.isConnected) document.documentElement.appendChild(iconHost);
    iconHost.style.display = "";
    positionIcon();
  }

  function hideIcon() {
    iconField = null;
    iconHost.style.display = "none";
  }

  function positionIcon() {
    if (!iconField) return;
    if (!isVisible(iconField)) return hideIcon();
    const rect = iconField.getBoundingClientRect();
    iconHost.style.top = `${rect.top + window.scrollY + (rect.height - 22) / 2}px`;
    iconHost.style.left = `${rect.right + window.scrollX - 22 - 6}px`;
  }

  document.addEventListener(
    "focusin",
    (event) => {
      if (isLoginField(event.target)) showIcon(event.target);
    },
    true,
  );
  document.addEventListener(
    "focusout",
    () => {
      // Checked after the focus has landed: moving between the username and
      // password fields just moves the icon (focusin above) - anything else
      // hides it. Clicking the icon itself never takes the focus.
      setTimeout(() => {
        if (!isLoginField(document.activeElement)) hideIcon();
      }, 0);
    },
    true,
  );

  let repositionQueued = false;
  function queueReposition() {
    if (repositionQueued) return;
    repositionQueued = true;
    requestAnimationFrame(() => {
      repositionQueued = false;
      positionIcon();
      if (menu) positionMenu();
    });
  }
  window.addEventListener("scroll", queueReposition, true);
  window.addEventListener("resize", queueReposition);

  // ---- Extension iframes (menu + save prompt) ---------------------------

  function createFrame(mode, width, height) {
    const host = document.createElement("browsersync-frame");
    host.style.cssText = `position:absolute;z-index:${Z_TOP};margin:0;padding:0;border:0;opacity:1;transform:none;filter:none;`;
    const shadow = host.attachShadow({ mode: "closed" });
    const iframe = document.createElement("iframe");
    iframe.src = `${FRAME_URL}?mode=${mode}`;
    iframe.style.cssText =
      `all:initial;display:block;width:${width}px;height:${height}px;border:1px solid #d7dbe0;` +
      "border-radius:10px;box-shadow:0 6px 24px rgb(0 0 0 / .18);";
    iframe.setAttribute("allowtransparency", "false");
    shadow.appendChild(iframe);
    document.documentElement.appendChild(host);
    return host;
  }

  function openMenu(field) {
    closeMenu();
    menu = { host: createFrame("suggest", 300, 190), field };
    positionMenu();
  }

  function positionMenu() {
    if (!menu.field.isConnected) return closeMenu();
    const rect = menu.field.getBoundingClientRect();
    const left = Math.min(rect.left, window.innerWidth - 310);
    menu.host.style.top = `${rect.bottom + window.scrollY + 4}px`;
    menu.host.style.left = `${Math.max(4, left) + window.scrollX}px`;
  }

  function closeMenu() {
    menu?.host.remove();
    menu = null;
  }

  function openSavePrompt() {
    closeSavePrompt();
    savePrompt = createFrame("save", 340, 150);
    savePrompt.style.position = "fixed";
    savePrompt.style.top = "12px";
    savePrompt.style.right = "12px";
  }

  function closeSavePrompt() {
    savePrompt?.remove();
    savePrompt = null;
  }

  document.addEventListener(
    "mousedown",
    (event) => {
      if (menu && !event.composedPath().includes(menu.host)) closeMenu();
    },
    true,
  );
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenu();
  });

  // ---- Filling ------------------------------------------------------------

  // React/Vue track input values through the prototype setter, so assigning
  // .value directly would be silently reverted on their next render.
  const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  function setFieldValue(field, value) {
    field.focus();
    nativeValueSetter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "bs-fill") {
      const field = menu?.field;
      closeMenu();
      // The service worker already matched the credential to this tab's
      // origin; checking again here covers a navigation in between.
      if (message.origin !== location.origin || !field?.isConnected) return;
      const { usernameField, passwordField } = fieldPair(field);
      if (usernameField && message.username) setFieldValue(usernameField, message.username);
      // Absent on "email first" logins; that step only needs the username.
      if (passwordField) setFieldValue(passwordField, message.password);
    } else if (message?.type === "bs-close") {
      if (message.target === "save") closeSavePrompt();
      else closeMenu();
    }
  });

  // ---- Capturing submitted logins -----------------------------------------

  function capture(root) {
    const fields = passwordFields(root).filter((field) => field.value);
    if (!fields.length) return;
    // Sign-up and change-password forms have several password fields
    // (old / new / confirm); the last one holds the password to keep.
    const password = fields[fields.length - 1].value;
    const username = findUsernameField(fields[0])?.value ?? "";
    const signature = `${username}\n${password}`;
    if (lastCapture?.signature === signature && Date.now() - lastCapture.at < 2000) return;
    lastCapture = { signature, at: Date.now() };

    const passwordField = fields[fields.length - 1];
    const urlBefore = location.href;
    chrome.runtime.sendMessage({ type: "cs-capture", username, password }).then(
      () => {
        // A full page load asks on its own (see the end of this file). A
        // single-page app doesn't reload, so check once it had time to
        // react: if the login form is gone or the URL changed, the login
        // most likely worked. If the form is still there, it probably
        // failed, and asking to save a wrong password would be worse.
        setTimeout(() => {
          if (!isVisible(passwordField) || location.href !== urlBefore) checkPendingSave();
        }, 2500);
      },
      () => {},
    );
  }

  document.addEventListener("submit", (event) => capture(event.target), true);
  document.addEventListener(
    "click",
    (event) => {
      if (!event.isTrusted) return;
      const button = event.target.closest?.('button, input[type="submit"], input[type="button"], [role="button"]');
      if (!button) return;
      capture(button.closest("form") ?? document);
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.isTrusted && event.key === "Enter" && event.target instanceof HTMLInputElement) {
        capture(event.target.form ?? document);
      }
    },
    true,
  );

  function checkPendingSave() {
    chrome.runtime.sendMessage({ type: "cs-check-pending" }).then(
      (response) => {
        if (response?.show) openSavePrompt();
      },
      () => {},
    );
  }

  // A login field focused before this script ran (autofocus) gets its icon too.
  if (isLoginField(document.activeElement)) showIcon(document.activeElement);
  checkPendingSave();
})();
