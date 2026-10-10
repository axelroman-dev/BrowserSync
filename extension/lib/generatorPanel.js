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

function checkbox(name, labelText) {
  const input = el("input", { type: "checkbox", name });
  return { input, row: el("label", { className: "gen-check" }, [input, el("span", { textContent: labelText })]) };
}

function rangeWithNumber(name, { min, max }) {
  const range = el("input", { type: "range", name, min, max, className: "gen-range" });
  const number = el("input", { type: "number", min, max, className: "gen-number", "aria-label": name });
  return { range, number };
}

/**
 * Renders the generator into `container`. `onUse(password)`, when given,
 * adds a "Use this password" button (the vault dialog fills its field).
 * Returns { regenerate } for callers that want a fresh password on open.
 */
export async function mountGeneratorPanel(container, { onUse } = {}) {
  let options = await loadGeneratorOptions();
  let current = "";

  const output = el("input", { type: "text", readOnly: true, spellcheck: false, className: "gen-output", "aria-label": t("generator.title") });
  const regenerateBtn = el("button", { type: "button", className: "secondary-button gen-icon", title: t("generator.regenerate"), textContent: "↻" });
  const copyBtn = el("button", { type: "button", className: "secondary-button", textContent: t("common.copy") });
  const meterFill = el("span", { className: "gen-meter-fill" });
  const strengthText = el("span", { className: "gen-strength-text" });

  const typeChars = el("input", { type: "radio", name: "gen-type", value: "chars" });
  const typeWords = el("input", { type: "radio", name: "gen-type", value: "words" });

  const length = rangeWithNumber("length", LIMITS.length);
  const lower = checkbox("lower", "a-z");
  const upper = checkbox("upper", "A-Z");
  const digits = checkbox("digits", "0-9");
  const symbols = checkbox("symbols", "!@#$%");
  const avoidAmbiguous = checkbox("avoidAmbiguous", t("generator.avoidAmbiguous"));

  const words = rangeWithNumber("words", LIMITS.words);
  const separator = el("input", { type: "text", maxLength: LIMITS.separatorMaxLength, className: "gen-separator", spellcheck: false });
  const capitalize = checkbox("capitalize", t("generator.capitalize"));
  const includeNumber = checkbox("includeNumber", t("generator.includeNumber"));

  const charsOptions = el("div", { className: "gen-options" }, [
    el("label", { className: "gen-field" }, [el("span", { textContent: t("generator.length") }), length.range, length.number]),
    el("div", { className: "gen-checks" }, [lower.row, upper.row, digits.row, symbols.row]),
    avoidAmbiguous.row,
  ]);
  const wordsOptions = el("div", { className: "gen-options" }, [
    el("label", { className: "gen-field" }, [el("span", { textContent: t("generator.wordCount") }), words.range, words.number]),
    el("label", { className: "gen-field" }, [el("span", { textContent: t("generator.separator") }), separator]),
    capitalize.row,
    includeNumber.row,
  ]);

  const panel = el("div", { className: "generator" }, [
    el("div", { className: "gen-output-row" }, [output, regenerateBtn, copyBtn]),
    el("div", { className: "gen-strength" }, [el("span", { className: "gen-meter" }, [meterFill]), strengthText]),
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
    output.value = password;
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
    copyBtn.textContent = t("common.copied");
    setTimeout(() => (copyBtn.textContent = t("common.copy")), 1200);
  });

  syncControls();
  await regenerate();
  return { regenerate };
}
