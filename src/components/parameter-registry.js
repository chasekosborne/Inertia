/**
 * Thin adapter over applied-force parameter definitions.
 */

const BUILTIN_IDENTIFIERS = new Set(['t', 'pi', 'e']);

/**
 * @param {string} exprSource
 * @returns {string[]}
 */
export function discoverIdentifiers(exprSource) {
  if (typeof exprSource !== 'string' || !exprSource.trim()) return [];
  const names = new Set();
  const re = /\b([a-zA-Z][a-zA-Z0-9_]*)\b/g;
  let m;
  while ((m = re.exec(exprSource)) !== null) {
    const name = m[1].toLowerCase();
    if (!BUILTIN_IDENTIFIERS.has(name)) names.add(name);
  }
  return [...names];
}

/**
 * @param {Record<string, { expression: string }>} parameters
 * @param {string} exprSource
 * @returns {string[]}  Names in exprSource not defined in parameters
 */
export function unknownParameterNames(parameters, exprSource) {
  const known = new Set(Object.keys(parameters ?? {}).map(k => k.toLowerCase()));
  return discoverIdentifiers(exprSource).filter(n => !known.has(n));
}
