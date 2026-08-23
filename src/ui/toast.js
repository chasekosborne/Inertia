/**
 * Brief fade-in confirmation under the top toolbar.
 *
 * One toast at a time: a second call while one is showing replaces the text
 * and restarts the timer rather than queueing.
 */

/** How long the message stays fully visible (ms). */
const VISIBLE_MS = 1600;
/** Must match the CSS opacity transition on `#toolbar-toast` (ms). */
const FADE_MS = 240;

/** @type {ReturnType<typeof setTimeout>|null} */
let timer = null;

function element() {
  return document.getElementById('toolbar-toast');
}

/** @param {string} message */
export function showToolbarToast(message) {
  const toast = element();
  if (!toast) return;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  toast.textContent = message;
  toast.classList.remove('hidden');
  // Force reflow so re-showing restarts the opacity transition.
  void toast.offsetWidth;
  toast.classList.add('visible');
  timer = setTimeout(() => {
    toast.classList.remove('visible');
    timer = setTimeout(() => {
      toast.classList.add('hidden');
      timer = null;
    }, FADE_MS);
  }, VISIBLE_MS);
}
