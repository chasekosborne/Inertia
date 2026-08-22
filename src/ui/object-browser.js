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

function _escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const ICONS = {
  folder: '<svg class="ob-ico" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M1.5 3h4l1 1.5H14.5v8.5h-13V3zm1 2v6.5h11V5.5H6.2L5.2 4H2.5V5z"/></svg>',
  file: '<svg class="ob-ico" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M4 1.5h5.5L13 5v9.5H4V1.5zm5.5 1v3H12L9.5 2.5z"/></svg>',
  link: '<svg class="ob-ico" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.4" d="M6.5 9.5l3-3M5 8.5l-1.2 1.2a2.1 2.1 0 0 0 3 3L8 11.5M11 7.5l1.2-1.2a2.1 2.1 0 0 0-3-3L8 4.5"/></svg>',
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
        icon: 'meta',
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
      const node = {
        kind: 'label',
        id: l.id,
        name: typeof l.text === 'string' ? l.text : l.id,
        type: l.body ? 'inline' : (l.point ? 'callout' : 'label'),
        icon: 'meta',
        parentBodyLabel: typeof l.body === 'string' ? l.body : null,
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
            <span class="ob-name" ${renameKind ? `data-rename="${renameKind}" data-id="${node.id ?? ''}" data-agg-id="${node.aggId ?? ''}" data-rope-id="${_escapeHtml(node.ropeId ?? '')}"` : ''}>${_escapeHtml(node.name)}</span>
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
    return '';
  }

  _dataAttrs(node, key) {
    const parts = [`data-key="${_escapeHtml(key)}"`];
    if (node.id != null) parts.push(`data-id="${_escapeHtml(String(node.id))}"`);
    if (node.aggId) parts.push(`data-agg-id="${_escapeHtml(node.aggId)}"`);
    if (node.memberIds) parts.push(`data-member-ids="${node.memberIds.join(',')}"`);
    if (node.partIndex != null) parts.push(`data-part-index="${node.partIndex}"`);
    if (node.ropeId) parts.push(`data-rope-id="${_escapeHtml(node.ropeId)}"`);
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
    const id = parseInt(nameEl.getAttribute('data-id'), 10);
    const aggId = nameEl.getAttribute('data-agg-id');
    const ropeId = nameEl.getAttribute('data-rope-id');
    if (!kind) return;
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
