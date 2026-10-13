#!/usr/bin/env python3
"""Builds the Chrome Web Store screenshots (1280x800, 24-bit PNG, no alpha).

Each screenshot is an HTML page: a headline on one side and the real popup
on the other - the popup markup mirrors extension/popup/popup.html and is
styled by the extension's own CSS, filled with sample data. capture.mjs renders
each page with headless Brave/Chromium, then Pillow drops the alpha channel.

    python3 store/screenshots/build.py [--browser /path/to/chromium]
"""
import argparse
import html
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
EXT = ROOT / "extension"
BUILD = HERE / "build"

# The popup's dark palette, forced so every screenshot matches.
DARK = """
:root { color-scheme: dark; --bg: #1a1d21; --text: #e7eaee; --muted: #9aa4af; --border: #33393f;
  --error-bg: #3a1f20; --error-text: #ff9a9a; --ok: #57d778; --danger: #ff8080; }
.gen-digit { color: #7aa7ff !important; } .gen-symbol { color: #fb923c !important; }
body { overflow: hidden !important; }
"""

TAB_ICONS = {
    "status": ("Sync", '<path d="M20 12a8 8 0 0 1-14.3 4.9M4 12a8 8 0 0 1 14.3-4.9"/><path d="M18.5 3v4.2h-4.2M5.5 21v-4.2h4.2"/>'),
    "passwords": ("Passwords", '<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3M16 7l3 3M14 9l2 2"/>'),
    "generator": ("Generator", '<rect x="3" y="10" width="18" height="11" rx="2"/><path d="M7 10V7a5 5 0 0 1 10 0v3"/><path d="M8 15.5h.01M12 15.5h.01M16 15.5h.01"/>'),
    "settings": ("Settings", '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
}

ROW_ICONS = {
    "user": '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    "key": '<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3M16 7l3 3M14 9l2 2"/>',
    "clock": '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
}


def popup_page(active, body):
    """A standalone page that looks exactly like the popup on `active` tab."""
    tabs = "".join(
        f'<button type="button" class="tab{" active" if name == active else ""}">'
        f'<svg viewBox="0 0 24 24">{icon}</svg><span>{label}</span></button>'
        for name, (label, icon) in TAB_ICONS.items()
    )
    return f"""<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<link rel="stylesheet" href="{EXT.as_uri()}/popup/popup.css">
<link rel="stylesheet" href="{EXT.as_uri()}/lib/generatorPanel.css">
<style>{DARK}</style></head>
<body class="with-tabs"><main class="popup">
<header><span class="brand">BrowserSync</span><div class="header-actions">
<select class="language-select"><option>Auto</option></select></div></header>
{body}
</main><nav class="tab-bar">{tabs}</nav></body></html>"""


def favicon(letter, color):
    svg = (f"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'><rect width='20' height='20' rx='4' fill='{color}'/>"
           f"<text x='10' y='14.5' font-family='Arial' font-weight='700' font-size='12' fill='white' text-anchor='middle'>{letter}</text></svg>")
    return "data:image/svg+xml;utf8," + svg.replace("#", "%23")


def pw_row(site, user, letter, color, totp=False):
    actions = [("user", "Copy username"), ("key", "Copy password")] + ([("clock", "Copy code")] if totp else [])
    buttons = "".join(f'<button class="pw-icon-button"><svg viewBox="0 0 24 24">{ROW_ICONS[i]}</svg></button>' for i, _ in actions)
    return (f'<div class="pw-row"><img class="pw-site-icon" src="{favicon(letter, color)}">'
            f'<div class="pw-row-info"><span class="pw-row-site">{site}</span><span class="pw-row-user">{user}</span></div>'
            f'<div class="pw-row-actions">{buttons}</div></div>')


SYNC_TAB = """
<section>
  <div class="account-card"><span class="account-avatar">A</span>
    <div class="account-text"><strong>alex@mycompany.com</strong><span class="muted">sync.mycompany.com</span></div></div>
  <div class="sync-card"><span class="dot dot-ok"></span>
    <div class="sync-card-text"><strong>Last sync: 2 min ago</strong><span class="muted">Next sync in 13 min</span></div>
    <button class="sync-now-button"><svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 0 1-14.3 4.9M4 12a8 8 0 0 1 14.3-4.9"/><path d="M18.5 3v4.2h-4.2M5.5 21v-4.2h4.2"/></svg><span>Sync now</span></button></div>
  <h3 class="section-title">What's synced</h3>
  <ul class="synced-list">
    <li><span>Bookmarks</span><span class="synced-value">412 on this device</span></li>
    <li><span>History</span><span class="synced-value">Last 90 days</span></li>
    <li><span>Passwords</span><span class="synced-value">On</span></li>
    <li><span>Extensions list</span><span class="synced-value">On</span></li>
  </ul>
  <div class="quick-links"><a class="quick-link">View synced data</a><a class="quick-link">Devices</a><a class="quick-link">Backup</a></div>
</section>"""

PASSWORDS_TAB = f"""
<section>
  <div class="pw-toolbar"><input type="search" class="pw-search" placeholder="Search by site or username"><button class="pw-add-button">+</button></div>
  <h3 class="section-title" style="margin-top:12px">For github.com</h3>
  <div class="pw-list">{pw_row("github.com", "alex@mycompany.com", "G", "#24292f", totp=True)}{pw_row("github.com", "alex-work", "G", "#24292f", totp=True)}</div>
  <h3 class="section-title" style="margin-top:12px">All passwords</h3>
  <div class="pw-list">
    {pw_row("accounts.google.com", "alex@gmail.com", "G", "#4285f4", totp=True)}
    {pw_row("app.netlify.com", "alex@mycompany.com", "N", "#00a39d")}
    {pw_row("figma.com", "alex@mycompany.com", "F", "#a259ff")}
    {pw_row("github.com", "alex@mycompany.com", "G", "#24292f", totp=True)}
    {pw_row("linear.app", "alex@mycompany.com", "L", "#5e6ad2")}
  </div>
</section>"""


def gen_password(text):
    out = []
    for ch in text:
        if ch.isdigit():
            out.append(f'<span class="gen-digit">{html.escape(ch)}</span>')
        elif ch.isalpha():
            out.append(html.escape(ch))
        else:
            out.append(f'<span class="gen-symbol">{html.escape(ch)}</span>')
    return "".join(out)


GENERATOR_TAB = f"""
<section>
  <h2 class="tab-title">Password generator</h2>
  <div id="popup-generator"><div class="generator">
    <div class="gen-display">
      <div class="gen-output-row"><div class="gen-output">{gen_password("Vq7#mK2!rT9x$Lp4wZ&e")}</div>
        <div class="gen-display-actions">
          <button class="gen-icon-button"><svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 0 1-14.3 4.9M4 12a8 8 0 0 1 14.3-4.9"/><path d="M18.5 3v4.2h-4.2M5.5 21v-4.2h4.2"/></svg></button>
          <button class="gen-icon-button"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg></button>
        </div></div>
      <div class="gen-strength"><span class="gen-meter"><span class="gen-meter-fill" data-level="veryStrong" style="width:100%"></span></span><span>Very strong · 128 bits</span></div>
    </div>
    <div class="gen-type"><label><input type="radio" name="t" checked><span>Characters</span></label><label><input type="radio" name="t"><span>Words</span></label></div>
    <div class="gen-options">
      <div class="gen-field"><div class="gen-field-head"><span>Length</span><input class="gen-number" type="number" value="20"></div><input class="gen-range" type="range" min="8" max="64" value="20"></div>
      <div class="gen-checks">
        <label class="gen-chip"><input type="checkbox" checked><span>a-z</span></label>
        <label class="gen-chip"><input type="checkbox" checked><span>A-Z</span></label>
        <label class="gen-chip"><input type="checkbox" checked><span>0-9</span></label>
        <label class="gen-chip"><input type="checkbox" checked><span>!@#$%</span></label>
      </div>
      <label class="gen-switch"><input type="checkbox"><span>Avoid look-alikes (l, I, O, 0, 1)</span></label>
    </div>
  </div></div>
</section>"""

SETTINGS_TAB = """
<section class="settings-tab">
  <h3 class="section-title">Sync</h3>
  <div class="settings-group">
    <label class="switch-row"><span>Sync browsing history</span><input type="checkbox" class="switch" checked></label>
    <label class="field-row"><span>History retention (days)</span><input type="number" value="90"></label>
    <label class="field-row"><span>Sync every (minutes)</span><input type="number" value="15"></label>
  </div>
  <h3 class="section-title">Passwords</h3>
  <div class="settings-group">
    <label class="switch-row"><span>Suggest and save passwords on websites</span><input type="checkbox" class="switch" checked></label>
    <label class="field-row"><span>Autofill</span><select><option>When I click the key icon</option></select></label>
  </div>
  <h3 class="section-title">Account</h3>
  <div class="settings-actions"><button class="secondary-button">Lock now</button><button class="secondary-button logout-button">Log out</button></div>
  <a class="more-settings"><span><strong>More settings</strong><span class="hint block">Devices, backup, restore bookmarks, delete account</span></span><span>›</span></a>
</section>"""

# (file, active tab, popup body, url in the fake address bar, popup side, kicker, headline, accent, text, bullets)
SHOTS = [
    ("1-sync", "status", SYNC_TAB, "sync.mycompany.com", "right", None,
     "Bookmarks, history and passwords", "on your own server",
     "Self-hosted, end-to-end encrypted sync for Chromium browsers — without Chrome Sync, and without trusting anyone else with your data.",
     ["Encrypted on your device — the server never sees your data",
      "Works on Chrome, Brave, Edge, Vivaldi and other Chromium browsers",
      "Bring your own server — you control where your data lives"]),
    ("2-passwords", "passwords", PASSWORDS_TAB, "github.com/login", "left", "Password manager",
     "Your passwords,", "one click away",
     "The logins for the site you're on come first. Copy a username, password or two-step code in one click, or autofill it right on the page.",
     ["Search, add and edit without leaving the popup",
      "Built-in two-step verification codes (TOTP)",
      "Import from Chrome, Firefox or Bitwarden"]),
    ("3-generator", "generator", GENERATOR_TAB, "signup.example.com", "right", "Password generator",
     "Strong passwords,", "your way",
     "Random characters or easy-to-type EFF word passphrases, with a live strength meter. Also one right-click away on any password field.",
     ["Choose length and character sets",
      "Look-alike characters can be left out",
      "Digits and symbols colored so they're easy to read"]),
    ("4-settings", "settings", SETTINGS_TAB, "sync.mycompany.com", "left", "Settings",
     "You decide", "what syncs",
     "Turn history on or off, set how often to sync, and choose how passwords are suggested on websites — all from the popup.",
     ["Lock with one click; your password unlocks it again",
      "Linked devices, encrypted backups and account deletion",
      "No ads, no tracking, open source"]),
]


def frame_page(name, url, side, kicker, headline, accent, text, bullets):
    popup = f"""
<div class="window">
  <div class="chrome"><span class="d r"></span><span class="d y"></span><span class="d g"></span><div class="url">{html.escape(url)}</div></div>
  <div class="toolbar"><img class="ext" src="{(EXT / 'icons/icon48.png').as_uri()}"></div>
  <div class="page"><div class="ph h1"></div><div class="ph"></div><div class="ph s"></div><div class="ph"></div><div class="ph s"></div></div>
  <iframe class="popup" src="{name}.popup.html" scrolling="no"></iframe>
</div>"""
    kicker_html = f'<div class="kicker">{html.escape(kicker)}</div>' if kicker else ""
    copy = f"""
<div class="copy">
  <div class="brand"><img src="{(EXT / 'icons/icon128.png').as_uri()}"><span>BrowserSync</span></div>
  {kicker_html}
  <h1>{html.escape(headline)}<br><em>{html.escape(accent)}</em></h1>
  <p>{html.escape(text)}</p>
  <ul>{"".join(f"<li>{html.escape(b)}</li>" for b in bullets)}</ul>
</div>"""
    order = copy + popup if side == "right" else popup + copy
    return f"""<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
* {{ box-sizing: border-box; }}
html, body {{ margin: 0; width: 1280px; height: 800px; overflow: hidden; }}
body {{
  font-family: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color: #e7eaee;
  background: radial-gradient(ellipse 60% 70% at {"15%" if side == "right" else "85%"} 20%, #1f3b6e 0%, transparent 70%),
              radial-gradient(ellipse 60% 60% at {"90%" if side == "right" else "10%"} 100%, #133457 0%, transparent 70%), #121620;
  display: flex; align-items: center; justify-content: space-between; padding: 0 90px; gap: 60px;
}}
.copy {{ flex: 1; max-width: 560px; text-align: {"left" if side == "right" else "left"}; }}
.brand {{ display: flex; align-items: center; gap: 14px; font-size: 26px; font-weight: 700; margin-bottom: 26px; }}
.brand img {{ width: 52px; height: 52px; border-radius: 12px; }}
.kicker {{ color: #7aa7ff; font-size: 15px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; margin-bottom: 10px; }}
h1 {{ font-size: 46px; line-height: 1.1; letter-spacing: -0.02em; margin: 0 0 20px; }}
h1 em {{ font-style: normal; color: #7aa7ff; }}
p {{ font-size: 19px; line-height: 1.55; color: #b4bcc6; margin: 0 0 26px; }}
ul {{ list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 12px; }}
li {{ font-size: 17px; padding-left: 22px; position: relative; color: #dfe4ea; }}
li::before {{ content: ""; position: absolute; left: 0; top: 8px; width: 8px; height: 8px; border-radius: 50%; background: #57d778; }}
.window {{ position: relative; width: 500px; height: 720px; flex: none; border-radius: 12px; overflow: hidden;
  background: #202329; border: 1px solid #2c3138; box-shadow: 0 30px 80px rgb(0 0 0 / .5); }}
.chrome {{ height: 44px; display: flex; align-items: center; gap: 8px; padding: 0 14px; background: #2a2e35; }}
.d {{ width: 12px; height: 12px; border-radius: 50%; }} .r {{ background: #ff5f57; }} .y {{ background: #febc2e; }} .g {{ background: #28c840; }}
.url {{ flex: 1; margin-left: 12px; height: 26px; border-radius: 13px; background: #1a1d21; color: #9aa4af; font-size: 13px; display: flex; align-items: center; padding: 0 14px; }}
.toolbar {{ height: 40px; display: flex; justify-content: flex-end; align-items: center; padding: 0 12px; background: #23272d; border-bottom: 1px solid #2c3138; }}
.ext {{ width: 22px; height: 22px; border-radius: 5px; outline: 2px solid #7aa7ff; outline-offset: 3px; }}
.page {{ padding: 30px; display: flex; flex-direction: column; gap: 14px; opacity: .5; }}
.ph {{ height: 12px; border-radius: 6px; background: #2f343c; width: 70%; }} .ph.h1 {{ height: 22px; width: 50%; }} .ph.s {{ width: 40%; }}
.popup {{ position: absolute; top: 92px; right: 14px; width: 320px; height: 470px; border: 1px solid #3a4048; border-radius: 10px;
  transform: scale(1.3); transform-origin: top right; box-shadow: 0 16px 40px rgb(0 0 0 / .55); background: #1a1d21; }}
</style></head><body>{order}</body></html>"""


def find_browser(explicit):
    candidates = [explicit] if explicit else []
    candidates += ["/opt/brave.com/brave/brave", "chromium", "chromium-browser", "google-chrome", "brave-browser"]
    for c in candidates:
        if c and (Path(c).exists() or shutil.which(c)):
            return c
    sys.exit("No Chromium-based browser found; pass --browser.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser")
    args = parser.parse_args()
    browser = find_browser(args.browser)
    BUILD.mkdir(exist_ok=True)
    pages = []
    for name, active, body, url, side, kicker, headline, accent, text, bullets in SHOTS:
        (BUILD / f"{name}.popup.html").write_text(popup_page(active, body), encoding="utf-8")
        page = BUILD / f"{name}.html"
        page.write_text(frame_page(name, url, side, kicker, headline, accent, text, bullets), encoding="utf-8")
        pages += [str(page), str(BUILD / f"{name}.raw.png")]
    subprocess.run(["node", str(HERE / "capture.mjs"), browser, str(BUILD / "profile"), *pages], check=True, timeout=120)
    for raw in pages[1::2]:
        out = HERE / ("screenshot-" + Path(raw).name.replace(".raw.png", ".png"))
        Image.open(raw).convert("RGB").resize((1280, 800)).save(out, optimize=True)
        print(out.relative_to(ROOT))


if __name__ == "__main__":
    main()
