// Chrome renders window.confirm()/alert()/prompt() clipped to the popup's
// own small window frame instead of as a proper centered modal - text and
// buttons get cut off against the popup's edges (this is what happens when
// a page that's only ~320px wide tries to show an OS dialog sized for a
// full window). Never use those inside popup.js - arm a button instead:
// first click swaps its label to a "click again to confirm" warning for a
// few seconds, second click (while armed) runs the action. Safe to use from
// a full tab too (e.g. onboarding.js), just unnecessary there.
//
// `warningLabel` can be a function, for a warning that depends on state at
// click time.
export function armConfirm(btn, warningLabel, armedMs = 4000) {
  const originalLabel = btn.textContent;
  let armed = false;
  let timer = null;
  return function checkArmed() {
    if (armed) {
      armed = false;
      clearTimeout(timer);
      btn.textContent = originalLabel;
      return true;
    }
    armed = true;
    btn.textContent = typeof warningLabel === "function" ? warningLabel() : warningLabel;
    timer = setTimeout(() => {
      armed = false;
      btn.textContent = originalLabel;
    }, armedMs);
    return false;
  };
}
