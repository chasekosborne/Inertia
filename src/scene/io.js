import { validateSceneDocument } from './validate.js';

/**
 * @param {import('./schema.js').SceneDocument} doc
 * @param {string} [filename]
 */
export function downloadSceneJSON(doc, filename = 'scene.json') {
  const json = JSON.stringify(doc, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * @param {File} file
 * @returns {Promise<{ ok: true, doc: import('./schema.js').SceneDocument } | { ok: false, error: string }>}
 */
export async function parseSceneFile(file) {
  try {
    const text = await file.text();
    const raw = JSON.parse(text);
    return validateSceneDocument(raw);
  } catch (e) {
    const msg = e instanceof SyntaxError
      ? 'Invalid JSON file.'
      : (e?.message ?? 'Could not read scene file.');
    return { ok: false, error: msg };
  }
}

/**
 * @param {string} url  e.g. `/demo/pull-at-angle.json`
 * @returns {Promise<{ ok: true, doc: import('./schema.js').SceneDocument } | { ok: false, error: string }>}
 */
export async function fetchSceneJSON(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return { ok: false, error: `Could not load scene (${res.status}): ${url}` };
    }
    const raw = await res.json();
    return validateSceneDocument(raw);
  } catch (e) {
    const msg = e instanceof SyntaxError
      ? 'Invalid JSON scene file.'
      : (e?.message ?? 'Could not load scene file.');
    return { ok: false, error: msg };
  }
}

/**
 * @returns {Promise<{ ok: true, doc: import('./schema.js').SceneDocument } | { ok: false, error: string }>}
 */
export function pickAndLoadSceneFile() {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve({ ok: false, error: 'No file selected.' });
        return;
      }
      resolve(await parseSceneFile(file));
    });
    input.click();
  });
}
