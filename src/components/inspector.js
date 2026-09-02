import { fieldId } from './metadata.js';
import { listAttachableProperties } from './optional-properties.js';
import { getComponent } from './registry.js';

/**
 * @param {string} s
 */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Trusted HTML labels (e.g. from MATH.*) are inserted verbatim. */
function renderInspectorLabel(label) {
  const s = String(label ?? '');
  if (s.includes('<')) return s;
  return escapeHtml(s);
}

/**
 * @param {import('./metadata.js').InspectorField} field
 * @param {import('./metadata.js').InspectorContext} ctx
 */
function formatValue(field, ctx) {
  if (field.format) return field.format(ctx);
  const raw = field.get?.(ctx);
  if (typeof raw === 'number') {
    const decimals = field.decimals ?? (field.step != null && field.step < 1 ? 3 : 2);
    return raw.toFixed(decimals);
  }
  return raw ?? '';
}

/**
 * @param {import('./metadata.js').InspectorField} field
 * @param {import('./metadata.js').InspectorContext} ctx
 */
function renderFieldHtml(field, ctx) {
  if (field.visible && !field.visible(ctx)) return '';

  if (field.type === 'section-title') {
    const margin = field.group === 'Position' ? 'margin-top:8px' : 'margin-top:8px';
    const removeBtn = field.propertyId && ctx.extras?.canDetach?.(field.propertyId)
      ? `<button type="button" class="prop-optional-remove" data-detach="${escapeHtml(field.propertyId)}">Remove</button>`
      : '';
    return `<div class="prop-section-title prop-optional-header" style="${margin}">
      <span>${renderInspectorLabel(field.label ?? '')}</span>${removeBtn}
    </div>`;
  }

  if (field.type === 'hint') {
    return `<p class="hint prop-optional-hint" style="font-size:10px;margin:0 0 6px">${renderInspectorLabel(field.label ?? '')}</p>`;
  }

  if (field.type === 'custom') {
    const slotHtml = ctx.extras?.customSlots?.[field.slot ?? field.key];
    return slotHtml ?? '';
  }

  const id = fieldId(field);
  const label = field.label ?? field.key;
  const unitSuffix = field.unit ? ` (${escapeHtml(field.unit)})` : '';
  const editable = field.editable ? field.editable(ctx) : field.type !== 'read-only';

  if (field.type === 'toggle') {
    const checked = field.get?.(ctx) ? 'checked' : '';
    return `
      <div class="prop-row">
        <span class="prop-label">${renderInspectorLabel(label)}</span>
        <label class="toggle-label">
          <input type="checkbox" id="${id}" ${checked} ${editable ? '' : 'disabled'}/>
          <span class="toggle-track"><span class="toggle-thumb"></span></span>
        </label>
      </div>`;
  }

  if (field.type === 'read-only') {
    return `
      <div class="prop-row">
        <span class="prop-label">${renderInspectorLabel(label)}${unitSuffix}</span>
        <span class="prop-value" id="${id}" style="border:none">${escapeHtml(formatValue(field, ctx))}</span>
      </div>`;
  }

  if (field.type === 'number') {
    const val = formatValue(field, ctx);
    const min = field.min != null ? ` min="${field.min}"` : '';
    const max = field.max != null ? ` max="${field.max}"` : '';
    const step = field.step != null ? ` step="${field.step}"` : '';
    return `
      <div class="prop-row">
        <span class="prop-label">${renderInspectorLabel(label)}${unitSuffix}</span>
        <input class="prop-value" id="${id}" type="number"${min}${max}${step} value="${escapeHtml(val)}" ${editable ? '' : 'disabled'}/>
      </div>`;
  }

  return '';
}

/**
 * Build "+ Add property" picker HTML.
 * @param {import('./entity.js').Entity} entity
 */
export function buildPropertyPickerHtml(entity) {
  const attachable = listAttachableProperties(entity);
  if (!attachable.length) return '';
  const rows = attachable.map(def => `
    <button type="button" class="prop-optional-row" data-attach="${escapeHtml(def.id)}">
      <span class="prop-optional-name">${escapeHtml(def.label ?? def.id)}</span>
      <span class="prop-optional-meta">${escapeHtml(def.description ?? '')}</span>
    </button>`).join('');
  return `
    <div class="prop-optional-bar">
      <button type="button" class="prop-action-btn prop-optional-add" id="prop-add-property">+ Add property</button>
      <div class="prop-optional-list hidden" id="prop-property-picker">${rows}</div>
    </div>`;
}

/**
 * Add propertyId to section-title fields for remove buttons.
 * @param {import('./metadata.js').InspectorField[]} fields
 * @param {import('./entity.js').Entity} entity
 */
export function annotatePropertySections(fields, entity) {
  const groupToProp = new Map();
  for (const id of entity.listComponents()) {
    const def = getComponent(id);
    if (!def?.optional) continue;
    for (const f of def.inspectorFields ?? []) {
      if (f.type === 'section-title' && f.group) {
        groupToProp.set(f.group, id);
      }
    }
  }
  return fields.map(f => {
    if (f.type === 'section-title' && f.group && groupToProp.has(f.group)) {
      return { ...f, propertyId: groupToProp.get(f.group) };
    }
    return f;
  });
}

/**
 * @param {import('./metadata.js').InspectorField[]} fields
 * @param {import('./metadata.js').InspectorContext} ctx
 * @param {object} [opts]
 * @param {Record<string, string[]>} [opts.legacyAfterGroups]
 * @param {string[]} [opts.legacyAtEnd]
 */
function buildFieldsHtml(fields, ctx, opts = {}) {
  const parts = [];
  let lastGroup = null;
  for (const field of fields) {
    const group = field.group ?? '';
    if (group && group !== lastGroup && lastGroup != null) {
      const blocks = opts.legacyAfterGroups?.[lastGroup];
      if (blocks) parts.push(...blocks);
    }
    parts.push(renderFieldHtml(field, ctx));
    if (group) lastGroup = group;
  }
  if (lastGroup != null) {
    const blocks = opts.legacyAfterGroups?.[lastGroup];
    if (blocks) parts.push(...blocks);
  }
  if (opts.legacyAtEnd) parts.push(...opts.legacyAtEnd);
  return parts.join('\n');
}

/**
 * @param {string} title
 * @param {import('./metadata.js').InspectorField[]} fields
 * @param {import('./metadata.js').InspectorContext} ctx
 * @param {object} [opts]
 * @param {Record<string, string[]>} [opts.legacyAfterGroups]
 * @param {string[]} [opts.legacyAtEnd]
 * @param {boolean} [opts.showDelete]
 */
export function buildInspectorHtml(title, fields, ctx, opts = {}) {
  const parts = [`<div class="prop-section-title">${escapeHtml(title)}</div>`];
  if (ctx.entity) {
    parts.push(buildPropertyPickerHtml(ctx.entity));
  }
  parts.push(buildFieldsHtml(fields, ctx, opts));
  if (opts.showDelete !== false) {
    parts.push('<button class="prop-delete-btn" id="prop-delete">Delete</button>');
  }
  return parts.join('\n');
}

/**
 * Mount a metadata-driven inspector into a panel element.
 * @param {HTMLElement} panel
 * @param {string} title
 * @param {import('./metadata.js').InspectorField[]} fields
 * @param {import('./metadata.js').InspectorContext} ctx
 * @param {object} [opts]
 * @param {Record<string, string[]>} [opts.legacyAfterGroups]
 * @param {string[]} [opts.legacyAtEnd]
 * @param {() => void} [opts.onMounted]
 * @returns {{ refresh: () => void }}
 */
export function mountInspector(panel, title, fields, ctx, opts = {}) {
  panel.innerHTML = buildInspectorHtml(title, fields, ctx, opts);

  for (const field of fields) {
    if (field.visible && !field.visible(ctx)) continue;
    if (field.type === 'section-title' || field.type === 'read-only' || field.type === 'hint' || field.type === 'custom') continue;
    if (!field.set) continue;

    const el = panel.querySelector(`#${CSS.escape(fieldId(field))}`);
    if (!el) continue;

    const run = () => {
      ctx.push();
      if (field.type === 'toggle') {
        field.set(ctx, /** @type {HTMLInputElement} */ (el).checked);
      } else if (field.type === 'number') {
        field.set(ctx, parseFloat(/** @type {HTMLInputElement} */ (el).value));
      }
    };
    el.addEventListener('change', run);
  }

  panel.querySelector('#prop-delete')?.addEventListener('click', () => {
    ctx.deleteBody?.();
  });

  panel.querySelector('#prop-add-property')?.addEventListener('click', () => {
    panel.querySelector('#prop-property-picker')?.classList.toggle('hidden');
  });

  panel.querySelector('#prop-property-picker')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-attach]');
    if (!btn) return;
    e.preventDefault();
    const id = btn.getAttribute('data-attach');
    if (id) ctx.attachProperty?.(id);
  });

  panel.querySelectorAll('[data-detach]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      const id = btn.getAttribute('data-detach');
      if (id) ctx.detachProperty?.(id);
    });
  });

  opts.onMounted?.();

  return {
    refresh: () => refreshInspectorFields(panel, fields, ctx),
  };
}

/**
 * @param {HTMLElement} panel
 * @param {import('./metadata.js').InspectorField[]} fields
 * @param {import('./metadata.js').InspectorContext} ctx
 */
export function refreshInspectorFields(panel, fields, ctx) {
  for (const field of fields) {
    if (!field.liveRefresh || !field.get) continue;
    if (field.visible && !field.visible(ctx)) continue;
    const el = panel.querySelector(`#${CSS.escape(fieldId(field))}`);
    if (!el || document.activeElement === el) continue;
    const val = formatValue(field, ctx);
    if ('value' in el && el.tagName !== 'SPAN') el.value = val;
    else el.textContent = val;
  }
}
