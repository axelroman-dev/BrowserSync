// The password generator UI, built into a container by the vault dialog and
// the popup: the generated password with regenerate/copy, a strength meter,
// and the options for either kind (see passwordGenerator.js). Options are
// saved as they change, so every place that generates (the in-page menu and
// the right-click menu included) uses the last ones picked.
import { t } from "./i18n.js";
import {
  generatePassword,
  loadGeneratorOptions,
  saveGeneratorOptions,
  strengthLevel,
  LIMITS,
} from "./passwordGenerator.js";

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "dataset") Object.assign(node.dataset, value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

// Character sets render as toggle chips, the other options as switches -
// both are plain checkboxes underneath, styled in generatorPanel.css.
function checkbox(name, labelText, className = "gen-switch") {
  const input = el("input", { type: "checkbox", name });
  return { input, row: el("label", { className }, [input, el("span", { textContent: labelText })]) };
}

function rangeWithNumber(name, { min, max }) {
  const range = el("input", { type: "range", name, min, max, className: "gen-range" });
  const number = el("input", { type: "number", min, max, className: "gen-number", "aria-label": name });
  return { range, number };
}

/** A label + number on one line, the slider full width under it. */
function sliderField(labelText, control) {
  return el("div", { className: "gen-field" }, [
    el("div", { className: "gen-field-head" }, [el("span", { textContent: labelText }), control.number]),
    control.range,
  ]);
}

const ICONS = {
  regenerate: '<path d="M20 12a8 8 0 0 1-14.3 4.9M4 12a8 8 0 0 1 14.3-4.9"/><path d="M18.5 3v4.2h-4.2M5.5 21v-4.2h4.2"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
};

function iconButton(icon, title) {
  const btn = el("button", { type: "button", className: "gen-icon-button", title, "aria-label": title });
  btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[icon]}</svg>`;
  return btn;
}

/** Fills `output` with the password, digits and symbols in their own colors so they're easy to tell apart. */
function renderPassword(output, password) {
  output.replaceChildren(
    ...Array.from(password, (char) => {
      const kind = /[0-9]/.test(char) ? "gen-digit" : /[A-Za-z]/.test(char) ? null : "gen-symbol";
      return kind ? el("span", { className: kind, textContent: char }) : document.createTextNode(char);
    }),
  );
}

/**
 * Renders the generator into `container`. `onUse(password)`, when given,
 * adds a "Use this password" button (the vault dialog fills its field).
 * Returns { regenerate } for callers that want a fresh password on open.
 */
export async function mountGeneratorPanel(container, { onUse } = {}) {
  let options = await loadGeneratorOptions();
  let current = "";

  const output = el("div", { className: "gen-output", "aria-label": t("generator.title"), "aria-live": "polite" });
  const regenerateBtn = iconButton("regenerate", t("generator.regenerate"));
  const copyBtn = iconButton("copy", t("common.copy"));
  const meterFill = el("span", { className: "gen-meter-fill" });
  const strengthText = el("span", { className: "gen-strength-text" });

  const typeChars = el("input", { type: "radio", name: "gen-type", value: "chars" });
  const typeWords = el("input", { type: "radio", name: "gen-type", value: "words" });

  const length = rangeWithNumber("length", LIMITS.length);
  const lower = checkbox("lower", "a-z", "gen-chip");
  const upper = checkbox("upper", "A-Z", "gen-chip");
  const digits = checkbox("digits", "0-9", "gen-chip");
  const symbols = checkbox("symbols", "!@#$%", "gen-chip");
  const avoidAmbiguous = checkbox("avoidAmbiguous", t("generator.avoidAmbiguous"));

  const words = rangeWithNumber("words", LIMITS.words);
  const separator = el("input", { type: "text", maxLength: LIMITS.separatorMaxLength, className: "gen-separator", spellcheck: false });
  const capitalize = checkbox("capitalize", t("generator.capitalize"));
  const includeNumber = checkbox("includeNumber", t("generator.includeNumber"));

  const charsOptions = el("div", { className: "gen-options" }, [
    sliderField(t("generator.length"), length),
    el("div", { className: "gen-checks" }, [lower.row, upper.row, digits.row, symbols.row]),
    avoidAmbiguous.row,
  ]);
  const wordsOptions = el("div", { className: "gen-options" }, [
    sliderField(t("generator.wordCount"), words),
    el("label", { className: "gen-field-inline" }, [el("span", { textContent: t("generator.separator") }), separator]),
    capitalize.row,
    includeNumber.row,
  ]);

  const panel = el("div", { className: "generator" }, [
    el("div", { className: "gen-display" }, [
      el("div", { className: "gen-output-row" }, [output, el("div", { className: "gen-display-actions" }, [regenerateBtn, copyBtn])]),
      el("div", { className: "gen-strength" }, [el("span", { className: "gen-meter" }, [meterFill]), strengthText]),
    ]),
    el("div", { className: "gen-type", role: "radiogroup" }, [
      el("label", {}, [typeChars, el("span", { textContent: t("generator.typeChars") })]),
      el("label", {}, [typeWords, el("span", { textContent: t("generator.typeWords") })]),
    ]),
    charsOptions,
    wordsOptions,
  ]);
  if (onUse) {
    const useBtn = el("button", { type: "button", className: "primary-button gen-use", textContent: t("generator.use") });
    useBtn.addEventListener("click", () => onUse(current));
    panel.appendChild(useBtn);
  }
  container.replaceChildren(panel);

  const checks = { lower, upper, digits, symbols, avoidAmbiguous, capitalize, includeNumber };

  function syncControls() {
    typeChars.checked = options.type === "chars";
    typeWords.checked = options.type === "words";
    charsOptions.hidden = options.type !== "chars";
    wordsOptions.hidden = options.type !== "words";
    length.range.value = length.number.value = options.length;
    words.range.value = words.number.value = options.words;
    separator.value = options.separator;
    for (const [name, { input }] of Object.entries(checks)) input.checked = options[name];
    // The last enabled character set can't be turned off.
    const enabled = ["lower", "upper", "digits", "symbols"].filter((name) => options[name]);
    for (const name of ["lower", "upper", "digits", "symbols"]) checks[name].input.disabled = enabled.length === 1 && options[name];
  }

  async function regenerate() {
    const { password, bits } = await generatePassword(options);
    current = password;
    renderPassword(output, password);
    const level = strengthLevel(bits);
    meterFill.dataset.level = level;
    meterFill.style.width = `${Math.min(100, (bits / 128) * 100)}%`;
    strengthText.textContent = t("generator.strength", { level: t(`generator.level.${level}`), bits: Math.round(bits) });
  }

  async function update(changes) {
    options = await saveGeneratorOptions({ ...options, ...changes });
    syncControls();
    await regenerate();
  }

  typeChars.addEventListener("change", () => update({ type: "chars" }));
  typeWords.addEventListener("change", () => update({ type: "words" }));
  for (const [name, control] of [["length", length], ["words", words]]) {
    // The slider follows live; saving waits for the value to settle.
    control.range.addEventListener("input", () => (control.number.value = control.range.value));
    control.range.addEventListener("change", () => update({ [name]: Number(control.range.value) }));
    control.number.addEventListener("change", () => update({ [name]: Number(control.number.value) }));
  }
  separator.addEventListener("change", () => update({ separator: separator.value }));
  for (const [name, { input }] of Object.entries(checks)) input.addEventListener("change", () => update({ [name]: input.checked }));
  regenerateBtn.addEventListener("click", regenerate);
  copyBtn.addEventListener("click", async () => {
    await navigator.clipboard.writeText(current);
    copyBtn.classList.add("copied");
    copyBtn.querySelector("svg").innerHTML = ICONS.check;
    copyBtn.title = t("common.copied");
    setTimeout(() => {
      copyBtn.classList.remove("copied");
      copyBtn.querySelector("svg").innerHTML = ICONS.copy;
      copyBtn.title = t("common.copy");
    }, 1200);
  });

  syncControls();
  await regenerate();
  return { regenerate };
}
