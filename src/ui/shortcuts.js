/**
 * Declarative keyboard shortcuts.
 *
 * One guarded `keydown` listener walks an ordered binding table and runs the
 * first entry that matches. Ordering is the conflict-resolution rule: two
 * bindings on the same key resolve top-down, and only the winner gets
 * `preventDefault()`.
 *
 * A binding:
 *
 *   code   string | string[]  — `event.code`, e.g. 'KeyZ' or ['Digit0','Numpad0']
 *   ctrl   boolean            — tri-state. true requires Ctrl *or* Meta,
 *   shift  boolean              false forbids it, omitted means "don't care".
 *   alt    boolean              Omitting a modifier is how a shortcut ends up
 *                               swallowing Ctrl+Shift+<key>, so be explicit.
 *   when   () => boolean       — optional gate, e.g. only in review mode
 *   run    (event) => boolean|void
 *                              — returning false means "I did not handle this
 *                                after all"; the walk continues and no
 *                                preventDefault is issued.
 */

/** Keystrokes belong to the focused control, not the app. */
function isTypingTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
    || target.isContentEditable === true;
}

/** @param {KeyboardEvent} event */
function matches(binding, event) {
  const codes = Array.isArray(binding.code) ? binding.code : [binding.code];
  if (!codes.includes(event.code)) return false;
  // Ctrl and Meta are interchangeable so Windows and macOS share one table.
  const ctrl = event.ctrlKey || event.metaKey;
  if (binding.ctrl !== undefined && binding.ctrl !== ctrl) return false;
  if (binding.shift !== undefined && binding.shift !== event.shiftKey) return false;
  if (binding.alt !== undefined && binding.alt !== event.altKey) return false;
  return true;
}

/**
 * @param {object[]} bindings Ordered; earlier entries win.
 * @param {object} [options]
 * @param {EventTarget} [options.target=document]
 * @returns {() => void} Unbind.
 */
export function bindShortcuts(bindings, options = {}) {
  const target = options.target ?? document;

  const onKeyDown = (event) => {
    if (isTypingTarget(event.target)) return;
    for (const binding of bindings) {
      if (!matches(binding, event)) continue;
      if (binding.when && !binding.when()) continue;
      if (binding.run(event) === false) continue;
      event.preventDefault();
      return;
    }
  };

  target.addEventListener('keydown', onKeyDown);
  return () => target.removeEventListener('keydown', onKeyDown);
}
