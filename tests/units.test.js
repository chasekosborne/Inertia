import { describe, it, expect } from 'vitest';
import {
  PX_PER_M,
  BASE_DELTA_MS,
  SIM_HZ,
  mToPx,
  pxToM,
  matterVelToDisplayMS,
  displayMSToMatterVel,
  setForceArrowScale,
  getForceArrowScale,
} from '../src/units.js';

describe('units', () => {
  it('converts metres and pixels consistently', () => {
    expect(pxToM(mToPx(3.5))).toBeCloseTo(3.5, 12);
    expect(mToPx(pxToM(420))).toBeCloseTo(420, 6);
    expect(PX_PER_M).toBe(100);
  });

  it('round-trips display velocity through Matter convention', () => {
    const vxMs = 4.2;
    const vyMs = -1.8;
    const { vx, vy } = displayMSToMatterVel(vxMs, vyMs);
    const back = matterVelToDisplayMS(vx, vy);
    expect(back.vxMs).toBeCloseTo(vxMs, 10);
    expect(back.vyMs).toBeCloseTo(vyMs, 10);
  });

  it('uses a fixed simulation timestep', () => {
    expect(SIM_HZ).toBe(960);
    expect(BASE_DELTA_MS).toBeCloseTo(1000 / 960, 12);
  });

  it('clamps force arrow scale to a safe range', () => {
    setForceArrowScale(99);
    expect(getForceArrowScale()).toBe(4);
    setForceArrowScale(0.01);
    expect(getForceArrowScale()).toBe(0.25);
    setForceArrowScale(1);
    expect(getForceArrowScale()).toBe(1);
  });
});
