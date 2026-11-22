// Measured values for a 9ft table with 2 1/4" balls.
// Sources: Dr. Dave's billiard physics, Leckie & Greenspan (2006).
// These are real-world numbers, not tuned for "feel".

export const BALL_R = 0.028575; // 2.25 in
export const BALL_M = 0.170; // 6 oz
export const BALL_I = 0.4 * BALL_M * BALL_R * BALL_R; // solid sphere, 2/5 m r^2

export const G = 9.81;

/** Kinetic friction while the contact point is slipping. */
export const MU_SLIDE = 0.2;
/** Rolling resistance once the ball is in pure rolling. ~0.20 m/s^2 of decel. */
export const MU_ROLL = 0.02;
/** Tangential friction between two balls. Drives throw and spin transfer. */
export const MU_BALL = 0.06;
/** Tangential friction on the cushion. Drives english off the rails. */
export const MU_RAIL = 0.2;

export const E_BALL = 0.95; // ball to ball restitution
export const E_RAIL = 0.82; // cushion restitution

// 9ft playing surface.
export const TABLE_L = 2.54;
export const TABLE_W = 1.27;
export const HALF_L = TABLE_L / 2;
export const HALF_W = TABLE_W / 2;

/**
 * Cushion nose sits at ~63.5% of the ball diameter, so the contact point is
 * above the ball's centre. That offset is what makes topspin and backspin
 * change the angle a ball leaves a rail.
 */
export const RAIL_H = 0.27 * BALL_R;

/**
 * Cushion stops this far from a corner pocket, measured along each rail. The
 * mouth across the corner is CORNER_GAP * sqrt(2) = 116mm, close to the 115mm
 * of a real 9ft table.
 */
export const CORNER_GAP = 0.082;
/** Half the side pocket mouth: 128mm across, against 127mm on a real table. */
export const SIDE_GAP = 0.064;
/** Radius of the rounded jaw at the end of each cushion. Sharp, like a cut. */
export const JAW_R = 0.004;

/** Top of the power bar on a regular shot. */
export const MAX_CUE_SPEED = 3.6;
/** A firm opening break can use more cue speed. */
export const MAX_BREAK_SPEED = 8;

/** Sidespin makes the cue ball leave the tip at an angle. Radians per R of offset. */
export const SQUIRT_PER_R = 0.10; // ~0.05 rad / 2.9 deg at maximum offset

/** Miscue limit, as a fraction of the ball radius. */
export const MAX_OFFSET = 0.5;

/** Below this the ball is considered at rest. */
export const REST_V = 1.5e-3;
export const REST_W = 0.1;
/** Slip speed below which we call it rolling. */
export const SLIP_EPS = 1e-3;

/** Cloth spin down: sidespin decays with this time constant. */
export const SPIN_DECAY_TAU = 0.9;

export const SIM_MAX_STEPS = 8000;
export const SIM_MAX_TIME = 40;
