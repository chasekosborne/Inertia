/**
 * Small safe expression compiler for drive functions.
 *
 * Dialect (Desmos-adjacent ASCII):
 *   t, pi, e
 *   + - * / ^  and parentheses
 *   sin cos tan asin acos atan abs sqrt exp ln log floor ceil min max
 *   Implicit multiplication: 2t, 2pi, )(, pi t
 */

const FN_ARITY = {
  sin: 1, cos: 1, tan: 1,
  asin: 1, acos: 1, atan: 1,
  abs: 1, sqrt: 1, exp: 1, ln: 1, log: 1,
  floor: 1, ceil: 1,
  min: 2, max: 2,
};

const FN_IMPL = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  abs: Math.abs,
  sqrt: Math.sqrt,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log10 ?? ((x) => Math.log(x) / Math.LN10),
  floor: Math.floor,
  ceil: Math.ceil,
  min: Math.min,
  max: Math.max,
};

/**
 * Insert explicit * for common implicit products, then tokenize.
 * @param {string} src
 * @returns {{ ok: true, tokens: object[] }|{ ok: false, error: string }}
 */
function tokenize(src) {
  let s = String(src ?? '').trim();
  if (!s) return { ok: false, error: 'Empty expression' };

  // Unicode / latex leftovers → ASCII
  s = s
    .replace(/π/g, 'pi')
    .replace(/·|×/g, '*')
    .replace(/−/g, '-')
    .replace(/\u2212/g, '-');

  // Implicit multiplication (order matters)
  s = s
    .replace(/(\d(?:\.\d*)?|\.\d+)\s*(pi|e|t|[a-zA-Z])/gi, '$1*$2')
    .replace(/(pi|e|t)\s*(\d)/gi, '$1*$2')
    .replace(/(pi|e|t)\s*(pi|e|t)/gi, '$1*$2')
    .replace(/\)\s*(\d|pi|e|t|\()/gi, ')*$1')
    .replace(/(pi|e|t|\d)\s*\(/gi, '$1*(')
    .replace(/\)\s*([a-zA-Z])/g, ')*$1');

  /** @type {object[]} */
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if ('+-*/^(),'.includes(c)) {
      tokens.push({ type: c });
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i + 1;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      const num = Number(s.slice(i, j));
      if (!isFinite(num)) return { ok: false, error: `Bad number near "${s.slice(i, j)}"` };
      tokens.push({ type: 'num', value: num });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i + 1;
      while (j < s.length && /[a-zA-Z_0-9]/.test(s[j])) j++;
      const name = s.slice(i, j).toLowerCase();
      tokens.push({ type: 'id', name });
      i = j;
      continue;
    }
    return { ok: false, error: `Unexpected character "${c}"` };
  }
  return { ok: true, tokens };
}

/**
 * Recursive-descent parser → AST.
 * @param {object[]} tokens
 */
function parse(tokens) {
  let i = 0;
  const peek = () => tokens[i];
  const take = () => tokens[i++];

  function parseExpr() {
    return parseAdd();
  }

  function parseAdd() {
    let left = parseMul();
    while (peek()?.type === '+' || peek()?.type === '-') {
      const op = take().type;
      const right = parseMul();
      left = { type: 'bin', op, left, right };
    }
    return left;
  }

  function parseMul() {
    let left = parsePow();
    while (peek()?.type === '*' || peek()?.type === '/') {
      const op = take().type;
      const right = parsePow();
      left = { type: 'bin', op, left, right };
    }
    return left;
  }

  function parsePow() {
    let left = parseUnary();
    if (peek()?.type === '^') {
      take();
      const right = parsePow(); // right-associative
      left = { type: 'bin', op: '^', left, right };
    }
    return left;
  }

  function parseUnary() {
    if (peek()?.type === '+' || peek()?.type === '-') {
      const op = take().type;
      return { type: 'unary', op, arg: parseUnary() };
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const t = peek();
    if (!t) throw new Error('Unexpected end of expression');
    if (t.type === 'num') {
      take();
      return { type: 'num', value: t.value };
    }
    if (t.type === '(') {
      take();
      const inner = parseExpr();
      if (peek()?.type !== ')') throw new Error('Missing ")"');
      take();
      return inner;
    }
    if (t.type === 'id') {
      take();
      const name = t.name;
      if (peek()?.type === '(') {
        take();
        const args = [];
        if (peek()?.type !== ')') {
          args.push(parseExpr());
          while (peek()?.type === ',') {
            take();
            args.push(parseExpr());
          }
        }
        if (peek()?.type !== ')') throw new Error(`Missing ")" after ${name}`);
        take();
        const arity = FN_ARITY[name];
        if (arity == null) throw new Error(`Unknown function "${name}"`);
        if (args.length !== arity) {
          throw new Error(`${name}() expects ${arity} argument${arity === 1 ? '' : 's'}`);
        }
        return { type: 'call', name, args };
      }
      if (name === 't' || name === 'pi' || name === 'e') {
        return { type: 'id', name };
      }
      throw new Error(`Unknown identifier "${name}"`);
    }
    throw new Error(`Unexpected token "${t.type}"`);
  }

  const ast = parseExpr();
  if (i < tokens.length) throw new Error('Unexpected trailing input');
  return ast;
}

/**
 * @param {object} ast
 * @param {{ t: number }} env
 */
function evalAst(ast, env) {
  switch (ast.type) {
    case 'num': return ast.value;
    case 'id':
      if (ast.name === 't') return env.t;
      if (ast.name === 'pi') return Math.PI;
      if (ast.name === 'e') return Math.E;
      return NaN;
    case 'unary': {
      const v = evalAst(ast.arg, env);
      return ast.op === '-' ? -v : v;
    }
    case 'bin': {
      const a = evalAst(ast.left, env);
      const b = evalAst(ast.right, env);
      switch (ast.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return a / b;
        case '^': return a ** b;
        default: return NaN;
      }
    }
    case 'call': {
      const fn = FN_IMPL[ast.name];
      const args = ast.args.map(x => evalAst(x, env));
      return fn(...args);
    }
    default: return NaN;
  }
}

/**
 * Compile an expression string.
 * @param {string} src
 * @returns {{ ok: true, source: string, eval: (env: {t:number}) => number }
 *   |{ ok: false, error: string }}
 */
export function compileExpr(src) {
  const tok = tokenize(src);
  if (!tok.ok) return tok;
  try {
    const ast = parse(tok.tokens);
    const source = String(src).trim();
    return {
      ok: true,
      source,
      eval(env) {
        const t = Number(env?.t);
        if (!isFinite(t)) return NaN;
        const v = evalAst(ast, { t });
        return isFinite(v) ? v : NaN;
      },
    };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/**
 * Convert common MathLive / TeX input into the ASCII dialect.
 * @param {string} latex
 * @returns {string}
 */
export function latexToExpr(latex) {
  let s = String(latex ?? '').trim();
  if (!s) return '';

  // \frac{a}{b}
  while (/\\frac\s*\{/.test(s)) {
    s = s.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '(($1)/($2))');
  }
  // \sqrt{x} / \sqrt x
  s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, 'sqrt($1)');
  s = s.replace(/\\sqrt\s*([a-zA-Z0-9.]+)/g, 'sqrt($1)');

  const fns = ['arcsin', 'arccos', 'arctan', 'asin', 'acos', 'atan',
    'sinh', 'cosh', 'tanh', 'sin', 'cos', 'tan', 'abs', 'exp', 'ln', 'log',
    'floor', 'ceil', 'min', 'max', 'operatorname'];
  for (const fn of fns) {
    if (fn === 'operatorname') {
      s = s.replace(/\\operatorname\s*\{([a-zA-Z]+)\}/g, '$1');
      continue;
    }
    const re = new RegExp(`\\\\${fn}(?![a-zA-Z])`, 'g');
    s = s.replace(re, fn);
  }

  s = s
    .replace(/\\pi(?![a-zA-Z])/g, 'pi')
    .replace(/\\cdot|\\times|\\ast/g, '*')
    .replace(/\\left|\\right/g, '')
    .replace(/\\mathrm\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\text\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\[,;:!~ ]/g, '')
    .replace(/[{}]/g, '')
    .replace(/\^/g, '^')
    .replace(/\\\\/g, '')
    .replace(/\\/g, '');

  // Map long inverse names
  s = s
    .replace(/\barcsin\b/g, 'asin')
    .replace(/\barccos\b/g, 'acos')
    .replace(/\barctan\b/g, 'atan');

  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Evaluate once. Returns null on error / non-finite.
 * @param {string} src
 * @param {number} t
 */
export function evalExpr(src, t) {
  const compiled = compileExpr(src);
  if (!compiled.ok) return null;
  const v = compiled.eval({ t });
  return isFinite(v) ? v : null;
}

/**
 * Convert our ASCII dialect to TeX for MathLive display.
 * @param {string} expr
 * @returns {string}
 */
export function exprToLatex(expr) {
  let s = String(expr ?? '').trim();
  if (!s) return '';

  const fns = ['asin', 'acos', 'atan', 'sin', 'cos', 'tan', 'sqrt', 'exp', 'abs',
    'floor', 'ceil', 'min', 'max', 'ln', 'log'];
  const held = [];
  for (const fn of fns) {
    const re = new RegExp(`\\b${fn}\\b`, 'g');
    s = s.replace(re, () => {
      const i = held.length;
      held.push(fn);
      return `\uE000${i}\uE001`;
    });
  }

  s = s
    .replace(/\bpi\b/g, '\\pi')
    .replace(/\*/g, '\\cdot ')
    .replace(/\^([a-zA-Z_]\w*|\([^)]+\))/g, (_, p) => `^{${p}}`)
    .replace(/\^(\d+)/g, '^{$1}');

  s = s.replace(/\uE000(\d+)\uE001/g, (_, i) => `\\${held[Number(i)]}`);
  return s;
}
