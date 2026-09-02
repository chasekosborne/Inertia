/**
 * Left-hand object browser: filesystem-style tree:
 *   objects (files), nested constraints, aggregate folders, rope aggregates.
 * Drag a connected body/constraint onto another body (or folder) to form an aggregate.
 */

import {
  buildObjectBrowserTree,
  tryAggregateDrop,
  renameUiAggregate,
} from '../scene/aggregates.js';
import { renameRope } from '../physics/rope.js';
import { measurementVectorParent, measurementDisplayLabel } from './measure-eval.js';
import { formatMathLabelHtml } from '../math-text.js';

function _escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const ICONS = {
  folder: '<svg class="ob-ico" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M1.5 3h4l1 1.5H14.5v8.5h-13V3zm1 2v6.5h11V5.5H6.2L5.2 4H2.5V5z"/></svg>',
  object: '<svg class="ob-ico" viewBox="0 0 200 200" aria-hidden="true"><g transform="translate(-418.24718,-518.52157)"><circle fill="#0044aa" cx="469.8299" cy="589.68774" r="44.667393"/><rect fill="#aaccff" x="522.34882" y="549.71918" width="88.267006" height="88.267006"/><path fill="#2a7fff" d="m 462.53338,664.51333 -17.00418,-46.38031 48.66862,8.4641 z" transform="matrix(1.4262127,1.7307682,-1.7307682,1.4262127,941.27312,-1047.3563)"/></g></svg>',
  file: '<svg class="ob-ico" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M4 1.5h5.5L13 5v9.5H4V1.5zm5.5 1v3H12L9.5 2.5z"/></svg>',
  link: '<svg class="ob-ico" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.4" d="M6.5 9.5l3-3M5 8.5l-1.2 1.2a2.1 2.1 0 0 0 3 3L8 11.5M11 7.5l1.2-1.2a2.1 2.1 0 0 0-3-3L8 4.5"/></svg>',
  parameter: '<span class="ob-parameter-icon" aria-hidden="true">x</span>',
  tag: '<svg class="ob-ico" viewBox="0 0 200 200" aria-hidden="true"><g transform="translate(-418.24718,-518.52157)"><path fill="currentColor" d="m 486.05068,693.84268 c -6.6014,-5.8255 -44.588,-44.1036 -46.4373,-46.7937 -0.9955,-1.4482 -1.3662,-2.9287 -1.3662,-5.4565 0,-3.1189 0.2649,-3.8042 2.6256,-6.7907 3.9076,-4.9435 69.2351,-69.923 70.9548,-70.5769 1.6747,-0.6366 20.3568,-0.7715 23.3712,-0.1687 1.967,0.3934 1.9689,0.398 1.9726,4.568 0,2.2958 0.276,5.8371 0.6088,7.8695 0.4883,2.9813 0.4166,4.06 -0.371,5.583 -0.537,1.0383 -0.9878,3.3448 -1.0021,5.1257 -0.061,7.6251 5.2698,13.1477 12.7933,13.2542 5.0159,0.071 9.0624,-2.455 11.4373,-7.1396 2.6472,-5.2215 2.0583,-9.9333 -1.8055,-14.4473 -1.5862,-1.8531 -2.2299,-3.3751 -2.7294,-6.4534 -1.1707,-7.2151 -1.2327,-7.0774 2.9598,-6.573 5.9187,0.712 9.0015,1.6768 9.9129,3.1024 1.5199,2.377 3.7751,22.7005 4.5175,40.7108 0.6699,16.2505 3.829,11.339 -28.0115,43.5514 -15.1419,15.3188 -31.7365,31.7756 -36.8767,36.5706 l -9.3459,8.7183 -3.9671,0 -3.9671,0 -5.274,-4.6541 z m 94.248,-81.3215 c -0.8506,-0.8506 -1.5465,-1.9873 -1.5465,-2.526 0,-0.5388 1.2966,-4.0151 2.8813,-7.7254 1.5847,-3.7102 3.755,-10.0161 4.823,-14.0132 1.7366,-6.4999 1.948,-8.2655 2.0016,-16.7183 0.054,-8.4014 -0.09,-9.7745 -1.2865,-12.3635 -3.2838,-7.1018 -9.4167,-11.2477 -16.6556,-11.2579 -6.0982,-0.01 -9.7139,1.4608 -13.8193,5.6178 -5.8628,5.9362 -6.6501,10.153 -4.4203,23.6742 2.021,12.2544 1.546,14.8065 -2.7559,14.8065 -4.0893,0 -4.6966,-1.1813 -6.7149,-13.0618 -2.9206,-17.192 -0.037,-27.3186 9.9401,-34.9106 5.6982,-4.3359 10.6291,-5.7823 18.694,-5.4838 5.7554,0.2131 6.8908,0.4602 10.6754,2.3234 7.3623,3.6245 13.0202,10.762 15.3105,19.3144 1.1225,4.1916 1.0886,16.4732 -0.064,23.081 -0.5073,2.9089 -1.6573,7.8369 -2.5556,10.9511 -2.0324,7.0464 -7.2983,18.2318 -9.0158,19.151 -2.0361,1.0897 -3.8227,0.8102 -5.4918,-0.8589 z"/></g></svg>',
  meta: '<span class="ob-ico-meta">·</span>',
};

export class ObjectBrowser {
  /**
   * @param {HTMLElement} rootEl
   * @param {import('../physics/engine.js').PhysicsEngine} engine
   * @param {object} hooks
   */
  constructor(rootEl, engine, hooks = {}) {
    this.root = rootEl;
    this.engine = engine;
    this._onSelect = hooks.onSelect ?? (() => {});
    this._beforeChange = hooks.beforeChange ?? (() => {});
    this._listMeasurements = hooks.listMeasurements ?? (() => []);
    this._listLabels = hooks.listLabels ?? (() => []);
    this._onRenameBody = hooks.onRenameBody ?? null;
    this._onRenameConstraint = hooks.onRenameConstraint ?? null;
    this._onRenameAggregate = hooks.onRenameAggregate ?? null;
    this._onRenameRope = hooks.onRenameRope ?? null;
    this._onRenameLabel = hooks.onRenameLabel ?? null;
    this._onAggregateChange = hooks.onAggregateChange ?? null;
    /** @type {object|null} */
    this._selection = null;
    /** @type {Set<string>} */
    this._expanded = new Set();
    this._raf = 0;
    /** @type {object|null} */
    this._dragPayload = null;
  }

  /** @param {object|null} selection */
  setSelection(selection) {
    this._selection = selection;
    this._highlightOnly();
  }

  refresh() {
    if (!this.root) return;
    const { roots } = buildObjectBrowserTree(this.engine);
    const sel = this._selection;
    const measurements = this._listMeasurements() || [];
    const labelItems = this._listLabels() || [];
    const withMeas = this._mergeMeasurementNodes(roots, measurements);
    const allRoots = this._mergeLabelNodes(withMeas, labelItems);

    const treeHtml = allRoots.length
      ? allRoots.map(n => this._nodeHtml(n, 0, sel)).join('')
      : '<p class="ob-empty">No objects</p>';

    this.root.innerHTML = `
      <div class="ob-fs" data-drop-kind="root">
        <div class="ob-list">${treeHtml}</div>
      </div>
    `;

    this._bind();
    this._highlightOnly();
  }

  /**
   * Nest measurements coupled to v/F under their parent body, leave others
   * as standalone roots (e.g. wedge interior angles).
   * @param {object[]} roots
   * @param {object[]} measurements
   */
  _mergeMeasurementNodes(roots, measurements) {
    const labelToId = new Map();
    for (const b of this.engine.bodies) {
      if (typeof b.label === 'string' && b.label) labelToId.set(b.label, b.id);
    }

    /** @type {object[]} */
    const standalone = [];

    for (const m of measurements) {
      if (!m?.id) continue;
      const parent = measurementVectorParent(m);
      const coupleMeta = parent?.couple === 'force' ? 'F'
        : parent?.couple === 'velocity' ? 'v' : '';
      const node = {
        kind: 'measurement',
        id: m.id,
        name: measurementDisplayLabel(m),
        type: coupleMeta
          ? `${m.kind === 'angle' ? 'angle' : 'length'} · ${coupleMeta}`
          : (m.kind === 'angle' ? 'angle' : 'length'),
        icon: 'tag',
        parentBodyLabel: parent?.bodyLabel ?? null,
        couple: parent?.couple ?? null,
      };

      if (parent) {
        const bodyId = labelToId.get(parent.bodyLabel);
        const host = bodyId != null ? this._findBodyNode(roots, bodyId) : null;
        if (host) {
          if (!Array.isArray(host.children)) host.children = [];
          host.children.push(node);
          continue;
        }
      }
      standalone.push(node);
    }

    return [...standalone, ...roots];
  }

  /**
   * @param {object[]} roots
   * @param {object[]} labels
   */
  _mergeLabelNodes(roots, labels) {
    const labelToId = new Map();
    for (const b of this.engine.bodies) {
      if (typeof b.label === 'string' && b.label) labelToId.set(b.label, b.id);
    }

    /** @type {object[]} */
    const standalone = [];

    for (const l of labels) {
      if (!l?.id) continue;
      const hostLabel = l.hostBodyLabel ?? l.body ?? null;
      const node = {
        kind: 'label',
        id: l.id,
        name: typeof l.text === 'string' ? l.text : l.id,
        type: l.type ?? (l.body ? 'inline' : (l.point ? 'callout' : 'label')),
        icon: 'tag',
        parentBodyLabel: typeof hostLabel === 'string' ? hostLabel : null,
      };

      if (node.parentBodyLabel) {
        const bodyId = labelToId.get(node.parentBodyLabel);
        const host = bodyId != null ? this._findBodyNode(roots, bodyId) : null;
        if (host) {
          if (!Array.isArray(host.children)) host.children = [];
          host.children.push(node);
          continue;
        }
      }
      standalone.push(node);
    }

    return [...standalone, ...roots];
  }

  /**
   * @param {object[]} nodes
   * @param {number} bodyId
   * @returns {object|null}
   */
  _findBodyNode(nodes, bodyId) {
    for (const n of nodes) {
      if ((n.kind === 'body' || n.kind === 'weld') && n.id === bodyId) return n;
      if (Array.isArray(n.children)) {
        const hit = this._findBodyNode(n.children, bodyId);
        if (hit) return hit;
      }
    }
    return null;
  }

  _highlightOnly() {
    if (!this.root) return;
    const sel = this._selection;
    this.root.querySelectorAll('.ob-row').forEach(row => {
      row.classList.toggle('selected', this._rowMatches(row, sel));
    });
  }

  _rowMatches(row, sel) {
    if (!sel) return false;
    const kind = row.getAttribute('data-kind');
    if (sel.type === 'aggregate' && (kind === 'aggregate' || kind === 'weld')) {
      if (kind === 'aggregate') return row.getAttribute('data-agg-id') === sel.aggId
        || row.getAttribute('data-key') === sel.key;
      return parseInt(row.getAttribute('data-id'), 10) === sel.id;
    }
    if (sel.type === 'body') {
      if (kind === 'body' || kind === 'weld') {
        const id = parseInt(row.getAttribute('data-id'), 10);
        if (id !== sel.id) return false;
        return sel.partIndex == null || sel.partIndex === undefined;
      }
      if (kind === 'weld-part') {
        const id = parseInt(row.getAttribute('data-id'), 10);
        const pi = parseInt(row.getAttribute('data-part-index'), 10);
        return id === sel.id && pi === (sel.partIndex ?? -1);
      }
    }
    if (sel.type === 'parameter' && kind === 'parameter') {
      return parseInt(row.getAttribute('data-id'), 10) === sel.bodyId
        && row.getAttribute('data-parameter-name') === sel.parameterName;
    }
    if (sel.type === 'constraint' && kind === 'constraint') {
      return parseInt(row.getAttribute('data-id'), 10) === sel.id;
    }
    if (sel.type === 'rope' && kind === 'rope') {
      return row.getAttribute('data-rope-id') === sel.ropeId;
    }
    if (sel.type === 'measurement' && kind === 'measurement') {
      return row.getAttribute('data-id') === sel.id;
    }
    if (sel.type === 'label' && kind === 'label') {
      return row.getAttribute('data-id') === sel.id;
    }
    return false;
  }

  _nodeHtml(node, depth, sel) {
    const key = node.key
      || (node.kind === 'body' ? `body:${node.id}`
        : node.kind === 'constraint' ? `con:${node.id}`
          : node.kind === 'weld-part' ? `part:${node.id}:${node.partIndex}`
            : node.kind === 'parameter' ? `parameter:${node.id}:${node.parameterName}`
              : node.kind === 'measurement' ? `meas:${node.id}`
              : node.kind === 'label' ? `label:${node.id}`
              : `${node.kind}:${node.id ?? node.name}`);
    const hasKids = Array.isArray(node.children) && node.children.length > 0;
    const open = !hasKids || this._expanded.has(key) || this._selectionTouches(node, sel);
    if (hasKids && open) this._expanded.add(key);

    const icon = ICONS[node.icon] || ICONS.file;
    const renameKind = this._renameKind(node);
    const draggable = node.kind === 'body' || node.kind === 'aggregate' || node.kind === 'constraint'
      || node.kind === 'weld';
    const droppable = node.kind === 'body' || node.kind === 'aggregate' || node.kind === 'weld';

    const renameAttrs = renameKind === 'label'
      ? `data-rename="label" data-label-id="${_escapeHtml(String(node.id ?? ''))}" data-raw-name="${_escapeHtml(node.name ?? '')}"`
      : renameKind
        ? `data-rename="${renameKind}" data-id="${node.id ?? ''}" data-agg-id="${node.aggId ?? ''}" data-rope-id="${_escapeHtml(node.ropeId ?? '')}"`
        : '';
    const nameHtml = node.kind === 'label' || node.kind === 'parameter'
      ? formatMathLabelHtml(node.name)
      : _escapeHtml(node.name);

    const attrs = this._dataAttrs(node, key);
    const kids = hasKids
      ? `<div class="ob-children" ${open ? '' : 'hidden'}>${
        node.children.map(ch => this._nodeHtml(ch, depth + 1, sel)).join('')
      }</div>`
      : '';

    const twist = hasKids
      ? `<button type="button" class="ob-twist" data-twist="${_escapeHtml(key)}" aria-label="Expand">${open ? '▾' : '▸'}</button>`
      : `<span class="ob-twist-spacer"></span>`;

    return `
      <div class="ob-node" data-depth="${depth}">
        <div class="ob-row ${droppable ? 'ob-drop' : ''}" data-kind="${node.kind}" ${attrs}
             draggable="${draggable ? 'true' : 'false'}">
          ${twist}
          <span class="ob-icon" aria-hidden="true">${icon}</span>
          <button type="button" class="ob-row-main">
            <span class="ob-name" ${renameAttrs}>${nameHtml}</span>
            <span class="ob-meta">${_escapeHtml(node.type ?? '')}</span>
          </button>
        </div>
        ${kids}
      </div>`;
  }

  _renameKind(node) {
    if (node.kind === 'body' || node.kind === 'weld') return 'body';
    if (node.kind === 'constraint') return 'constraint';
    if (node.kind === 'aggregate') return 'aggregate';
    if (node.kind === 'rope') return 'rope';
    if (node.kind === 'label') return 'label';
    return '';
  }

  _dataAttrs(node, key) {
    const parts = [`data-key="${_escapeHtml(key)}"`];
    if (node.id != null) parts.push(`data-id="${_escapeHtml(String(node.id))}"`);
    if (node.aggId) parts.push(`data-agg-id="${_escapeHtml(node.aggId)}"`);
    if (node.memberIds) parts.push(`data-member-ids="${node.memberIds.join(',')}"`);
    if (node.partIndex != null) parts.push(`data-part-index="${node.partIndex}"`);
    if (node.ropeId) parts.push(`data-rope-id="${_escapeHtml(node.ropeId)}"`);
    if (node.kind === 'parameter') {
      parts.push(`data-parameter-name="${_escapeHtml(node.parameterName ?? '')}"`);
    }
    return parts.join(' ');
  }

  _selectionTouches(node, sel) {
    if (!sel) return false;
    if (sel.type === 'aggregate') {
      if (node.kind === 'aggregate' && (node.aggId === sel.aggId || node.key === sel.key)) return true;
      if (node.memberIds && sel.memberIds?.some(id => node.memberIds.includes(id))) return true;
    }
    if (sel.type === 'body') {
      if ((node.kind === 'body' || node.kind === 'weld') && node.id === sel.id) return true;
      if (node.memberIds?.includes(sel.id)) return true;
    }
    if (sel.type === 'parameter') {
      if (node.kind === 'parameter' && node.id === sel.bodyId
        && node.parameterName === sel.parameterName) return true;
      if ((node.kind === 'body' || node.kind === 'weld') && node.id === sel.bodyId) return true;
    }
    if (sel.type === 'constraint' && node.kind === 'constraint' && node.id === sel.id) return true;
    if (sel.type === 'rope' && node.kind === 'rope' && node.ropeId === sel.ropeId) return true;
    if (sel.type === 'measurement') {
      if (node.kind === 'measurement' && node.id === sel.id) return true;
      if ((node.kind === 'body' || node.kind === 'weld')
        && node.children?.some(c => c.kind === 'measurement' && c.id === sel.id)) {
        return true;
      }
    }
    if (sel.type === 'label') {
      if (node.kind === 'label' && node.id === sel.id) return true;
      if ((node.kind === 'body' || node.kind === 'weld')
        && node.children?.some(c => c.kind === 'label' && c.id === sel.id)) {
        return true;
      }
    }
    return false;
  }

  _bind() {
    this.root.querySelectorAll('[data-twist]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const key = btn.getAttribute('data-twist');
        if (!key) return;
        if (this._expanded.has(key)) this._expanded.delete(key);
        else this._expanded.add(key);
        this.refresh();
      });
    });

    this.root.querySelectorAll('.ob-row').forEach(row => {
      const main = row.querySelector('.ob-row-main');
      main?.addEventListener('click', e => {
        if (e.detail === 2) return;
        this._selectFromRow(row);
      });
      main?.addEventListener('dblclick', e => {
        const nameEl = e.target.closest('[data-rename]');
        if (nameEl && nameEl.getAttribute('data-rename')) {
          e.preventDefault();
          e.stopPropagation();
          this._beginRename(nameEl);
        }
      });

      if (row.getAttribute('draggable') === 'true') {
        row.addEventListener('dragstart', e => {
          this._dragPayload = this._payloadFromRow(row);
          row.classList.add('ob-dragging');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', JSON.stringify(this._dragPayload));
        });
        row.addEventListener('dragend', () => {
          row.classList.remove('ob-dragging');
          this._dragPayload = null;
          this.root.querySelectorAll('.ob-drop-over').forEach(el => el.classList.remove('ob-drop-over'));
        });
      }

      if (row.classList.contains('ob-drop')) {
        row.addEventListener('dragover', e => {
          if (!this._dragPayload) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          row.classList.add('ob-drop-over');
        });
        row.addEventListener('dragleave', () => row.classList.remove('ob-drop-over'));
        row.addEventListener('drop', e => {
          e.preventDefault();
          row.classList.remove('ob-drop-over');
          const drag = this._dragPayload ?? (() => {
            try { return JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return null; }
          })();
          const drop = this._payloadFromRow(row);
          if (!drag || !drop) return;
          this._beforeChange();
          const result = tryAggregateDrop(this.engine, drag, drop);
          if (!result.ok) {
            this.root.classList.add('ob-drop-reject');
            setTimeout(() => this.root.classList.remove('ob-drop-reject'), 400);
            return;
          }
          if (result.aggregate) {
            this._expanded.add(`ui:${result.aggregate.id}`);
            this._onSelect({
              type: 'aggregate',
              key: `ui:${result.aggregate.id}`,
              aggId: result.aggregate.id,
              memberIds: [...result.aggregate.memberIds],
            });
          }
          this._onAggregateChange?.();
          this.refresh();
        });
      }
    });

    // Drop on empty root area → ungroup
    const fs = this.root.querySelector('.ob-fs');
    fs?.addEventListener('dragover', e => {
      if (!this._dragPayload) return;
      if (e.target.closest('.ob-row')) return;
      e.preventDefault();
      fs.classList.add('ob-drop-over');
    });
    fs?.addEventListener('dragleave', () => fs.classList.remove('ob-drop-over'));
    fs?.addEventListener('drop', e => {
      if (e.target.closest('.ob-row')) return;
      e.preventDefault();
      fs.classList.remove('ob-drop-over');
      const drag = this._dragPayload;
      if (!drag) return;
      this._beforeChange();
      tryAggregateDrop(this.engine, drag, { kind: 'root' });
      this._onAggregateChange?.();
      this.refresh();
    });
  }

  _payloadFromRow(row) {
    const kind = row.getAttribute('data-kind');
    if (kind === 'body' || kind === 'weld') {
      return { kind: 'body', id: parseInt(row.getAttribute('data-id'), 10) };
    }
    if (kind === 'aggregate') {
      return {
        kind: 'aggregate',
        aggId: row.getAttribute('data-agg-id'),
        memberIds: (row.getAttribute('data-member-ids') || '').split(',').map(Number).filter(Number.isFinite),
      };
    }
    if (kind === 'constraint') {
      return { kind: 'constraint', id: parseInt(row.getAttribute('data-id'), 10) };
    }
    return { kind };
  }

  _selectFromRow(row) {
    if (!row) return;
    const kind = row.getAttribute('data-kind');
    if (kind === 'weld' || kind === 'body') {
      const id = parseInt(row.getAttribute('data-id'), 10);
      this._onSelect({ type: 'body', id, partIndex: null });
      return;
    }
    if (kind === 'weld-part') {
      const id = parseInt(row.getAttribute('data-id'), 10);
      const partIndex = parseInt(row.getAttribute('data-part-index'), 10);
      this._onSelect({ type: 'body', id, partIndex });
      return;
    }
    if (kind === 'parameter') {
      const bodyId = parseInt(row.getAttribute('data-id'), 10);
      const parameterName = row.getAttribute('data-parameter-name');
      if (Number.isFinite(bodyId) && parameterName) {
        this._onSelect({ type: 'parameter', id: bodyId, bodyId, parameterName });
      }
      return;
    }
    if (kind === 'aggregate') {
      const key = row.getAttribute('data-key');
      const aggId = row.getAttribute('data-agg-id');
      const memberIds = (row.getAttribute('data-member-ids') || '')
        .split(',')
        .map(s => parseInt(s, 10))
        .filter(n => Number.isFinite(n));
      this._onSelect({ type: 'aggregate', key, aggId, memberIds });
      return;
    }
    if (kind === 'constraint') {
      const id = parseInt(row.getAttribute('data-id'), 10);
      this._onSelect({ type: 'constraint', id });
      return;
    }
    if (kind === 'rope') {
      const ropeId = row.getAttribute('data-rope-id');
      const memberIds = (row.getAttribute('data-member-ids') || '')
        .split(',')
        .map(s => parseInt(s, 10))
        .filter(n => Number.isFinite(n));
      this._onSelect({ type: 'rope', ropeId, memberIds, id: memberIds[0], key: `rope:${ropeId}` });
      return;
    }
    if (kind === 'measurement') {
      const id = row.getAttribute('data-id');
      if (id) this._onSelect({ type: 'measurement', id });
      return;
    }
    if (kind === 'label') {
      const id = row.getAttribute('data-id');
      if (id) this._onSelect({ type: 'label', id });
    }
  }

  _beginRename(nameEl) {
    const kind = nameEl.getAttribute('data-rename');
    if (!kind) return;

    if (kind === 'label') {
      const labelId = nameEl.getAttribute('data-label-id');
      if (!labelId) return;
      const prev = nameEl.getAttribute('data-raw-name') ?? nameEl.textContent ?? '';
      const input = document.createElement('input');
      input.className = 'ob-rename';
      input.value = prev;
      input.placeholder = 'e.g. theta_0, \\theta_{0}, $x$';
      input.title = 'LaTeX-style: theta_0, \\omega, Greek names, $...$ wrappers';
      nameEl.replaceWith(input);
      input.focus();
      input.select();
      let done = false;
      const commit = () => {
        if (done) return;
        done = true;
        const next = input.value.trim() || prev;
        this._beforeChange();
        this._onRenameLabel?.(labelId, next);
        this.refresh();
      };
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') {
          e.preventDefault();
          done = true;
          this.refresh();
        }
      });
      input.addEventListener('blur', commit);
      return;
    }

    const id = parseInt(nameEl.getAttribute('data-id'), 10);
    const aggId = nameEl.getAttribute('data-agg-id');
    const ropeId = nameEl.getAttribute('data-rope-id');
    if (kind === 'rope' && !ropeId) return;
    if (kind === 'aggregate' && !aggId) return;
    if (kind !== 'aggregate' && kind !== 'rope' && !Number.isFinite(id)) return;

    const prev = nameEl.textContent ?? '';
    const input = document.createElement('input');
    input.className = 'ob-rename';
    input.value = prev;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const next = input.value.trim() || prev;
      this._beforeChange();
      if (kind === 'body') this._onRenameBody?.(id, next);
      if (kind === 'constraint') this._onRenameConstraint?.(id, next);
      if (kind === 'aggregate') {
        renameUiAggregate(this.engine, aggId, next);
        this._onRenameAggregate?.(aggId, next);
      }
      if (kind === 'rope') {
        renameRope(this.engine, ropeId, next);
        this._onRenameRope?.(ropeId, next);
      }
      this.refresh();
    };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') {
        e.preventDefault();
        done = true;
        this.refresh();
      }
    });
    input.addEventListener('blur', commit);
  }

  scheduleRefresh() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.refresh();
    });
  }
}
