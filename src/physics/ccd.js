/**
 * Continuous Collision Detection (CCD) for circle bodies vs static AABB surfaces.
 *
 * Problem
 * ───────
 * Matter.js uses a Verlet integrator that encodes velocity as (pos − posPrev).
 * When a dynamic circle collides with a static surface mid-step, the impulse
 * solver sees the *average* displacement over the full step: a blend of the
 * free-fall approach phase and the post-contact phase: rather than the true
 * impact velocity.  For a collision at fractional step time t ∈ (0,1), the
 * measured impact speed is t × true_impact_speed, so the post-bounce KE is
 * t² × expected.  Only when t = 1 (collision exactly on a frame boundary) is
 * energy perfectly conserved.
 *
 * Fix
 * ───
 * Before each Engine.update(dt), find the earliest t at which any circle
 * will first contact a static body and split the step:
 *
 *   Engine.update(t × dt)      → ball arrives at the surface, resolver sees
 *                                 full impact speed → correct impulse applied.
 *   Engine.update((1−t) × dt)  → propagates post-bounce motion.
 *
 * Matter's time-correction Verlet (deltaTime/previousDeltaTime scaling)
 * correctly re-encodes the bounced velocity for the subsequent full step.
 *
 * Geometry
 * ────────
 * Uses slab-method ray vs. Minkowski-expanded AABB (rectangle grown by R).
 * This is exact for hits on flat faces and conservative at sharp corners :
 * acceptable for this simulator's ground/wall geometry.
 */

/**
 * Slab ray-AABB intersection.
 * Expands the AABB by R (Minkowski sum) so the circle-center ray is equivalent
 * to a circle vs the original AABB.
 *
 * @param {number} cx   Circle centre x
 * @param {number} cy   Circle centre y
 * @param {number} dvx  Per-step x displacement (positionPrev → position)
 * @param {number} dvy  Per-step y displacement
 * @param {number} ax1  AABB left   (bounds.min.x)
 * @param {number} ax2  AABB right  (bounds.max.x)
 * @param {number} ay1  AABB top    (bounds.min.y)
 * @param {number} ay2  AABB bottom (bounds.max.y)
 * @param {number} R    Circle radius
 * @returns {number|null}  Fractional entry time t ∈ (0, 1], or null if no hit.
 */
function slabTOI(cx, cy, dvx, dvy, ax1, ax2, ay1, ay2, R) {
  const ex1 = ax1 - R, ex2 = ax2 + R;
  const ey1 = ay1 - R, ey2 = ay2 + R;

  // Start slightly above 0 so we ignore contacts that are already touching
  // (the static contact solver handles those, we only split approaching pairs).
  let tMin = 1e-4;
  let tMax = 1.0;

  if (Math.abs(dvx) < 1e-9) {
    if (cx < ex1 || cx > ex2) return null;
  } else {
    const ta = (ex1 - cx) / dvx;
    const tb = (ex2 - cx) / dvx;
    tMin = Math.max(tMin, Math.min(ta, tb));
    tMax = Math.min(tMax, Math.max(ta, tb));
  }

  if (Math.abs(dvy) < 1e-9) {
    if (cy < ey1 || cy > ey2) return null;
  } else {
    const ta = (ey1 - cy) / dvy;
    const tb = (ey2 - cy) / dvy;
    tMin = Math.max(tMin, Math.min(ta, tb));
    tMax = Math.min(tMax, Math.max(ta, tb));
  }

  if (tMin > tMax - 1e-9) return null;
  if (tMin > 1.0) return null;

  return tMin;
}

/**
 * Exact circle-AABB separation test.
 * Returns true if the circle is fully outside the box (no contact/penetration).
 */
function isSeparated(cx, cy, R, ax1, ax2, ay1, ay2) {
  const clampX = cx < ax1 ? ax1 : cx > ax2 ? ax2 : cx;
  const clampY = cy < ay1 ? ay1 : cy > ay2 ? ay2 : cy;
  const dx = cx - clampX;
  const dy = cy - clampY;
  return dx * dx + dy * dy > R * R;
}

/**
 * Scans all dynamic circle bodies against all static bodies and returns the
 * earliest fractional step time t ∈ (0, 1] at which the first contact occurs.
 * Returns 1 if no mid-step collision is predicted (no split needed).
 *
 * @param {object[]} bodies  All Matter bodies in the world
 * @returns {number}
 */
export function ccdStepFraction(bodies) {
  // Collect static collidable surfaces (exclude sensors and the metric basis).
  const statics = [];
  for (const b of bodies) {
    if (b.isStatic && !b.isSensor && b._newtonType !== 'metric-basis') {
      statics.push(b);
    }
  }
  if (statics.length === 0) return 1;

  let earliest = 1;

  for (const b of bodies) {
    if (b.isStatic || b.isSensor) continue;
    if (b._ropeSegment) continue; // chain CCD-splits chatter on table edges
    if (b._newtonType !== 'point-mass' && b._newtonType !== 'ball') continue; // round bodies only

    const R   = b._radius ?? 10;
    const cx  = b.position.x;
    const cy  = b.position.y;
    // Per-step displacement = current velocity in Verlet terms
    const dvx = cx - b.positionPrev.x;
    const dvy = cy - b.positionPrev.y;

    if (dvx * dvx + dvy * dvy < 1e-8) continue; // stationary: skip

    for (const s of statics) {
      const bnd = s.bounds;
      const ax1 = bnd.min.x, ax2 = bnd.max.x;
      const ay1 = bnd.min.y, ay2 = bnd.max.y;

      // Cheap swept-bounds pre-filter: does the path even reach this static?
      const ex = cx + dvx, ey = cy + dvy;
      const pathX1 = (cx < ex ? cx : ex) - R;
      const pathX2 = (cx > ex ? cx : ex) + R;
      const pathY1 = (cy < ey ? cy : ey) - R;
      const pathY2 = (cy > ey ? cy : ey) + R;
      if (pathX2 < ax1 || pathX1 > ax2) continue;
      if (pathY2 < ay1 || pathY1 > ay2) continue;

      // Skip pairs that are already in contact: the position solver handles them.
      if (!isSeparated(cx, cy, R, ax1, ax2, ay1, ay2)) continue;

      const t = slabTOI(cx, cy, dvx, dvy, ax1, ax2, ay1, ay2, R);
      if (t !== null && t < earliest) earliest = t;
    }
  }

  return earliest;
}
