# The physics

Notes on how the simulation works, mostly so I can remember why the code looks
the way it does.

## State

Each ball stores a 2D position and velocity, because it only ever moves on the
cloth, plus a full 3D angular velocity:

```
p   position on the table (2D)
v   velocity (2D)
w   angular velocity (3D)
q   orientation quaternion (visual only)
```

`w` has to be 3D. Top and back spin are rotation about a horizontal axis, side
spin is rotation about the vertical one, and they behave completely differently.
A 2D engine would give you one scalar `w` and you would lose draw and follow
entirely.

## The slip vector

The single most useful quantity in the whole simulation is the velocity of the
point of the ball touching the cloth:

```
u = v + w × r     with r = (0, 0, -R)
```

which works out to

```
u = (v.x - w.y * R,  v.y + w.x * R)
```

`u = 0` means the ball is **rolling**. `u ≠ 0` means it is **sliding**, and
kinetic friction acts on it in the direction `-u`.

## Sliding

While sliding, friction is `F = -mu_s * m * g * u_hat`, so the linear
acceleration is just `-mu_s * g` in that direction, and the torque is
`r × F`, which only touches `w.x` and `w.y` (the cloth cannot exert a torque
about the vertical axis through a point contact).

Differentiating `u` gives a surprisingly clean result:

```
du/dt = 3.5 * F/m
```

so the slip decays at a constant rate of `3.5 * mu_s * g`. That means the time
until the ball starts rolling is

```
t_roll = |u| / (3.5 * mu_s * g)
```

exactly, with no iteration. With `mu_s = 0.2` that is `6.87 m/s²` of slip decay.

During sliding, position is `p + v t + ½ a t²`. Both `v` and `u` have constant
direction until the transition, so the motion really is a parabola.

## Rolling

Once rolling, `u = 0`, so `v` and `w` are locked together:

```
w.x = -v.y / R
w.y =  v.x / R
```

The ball then decelerates at a constant `mu_roll * g` until it stops. Side spin
is not coupled to the roll in this model, so it just decays with a time constant.

## Event stepping

The simulator does not tick. Each iteration it works out the earliest thing that
is going to happen and jumps straight there:

- a ball reaching a cushion plane
- a ball reaching a jaw
- the sliding → rolling transition
- a ball getting within two radii of another ball
- a ball running out of speed

The contact times are computed from the current linear motion and are therefore
conservative: deceleration can only make a ball arrive later, never earlier. So
stepping to that time can never skip a collision. Nothing can tunnel.

The step is also capped at 1/240 s so the recorded playback has enough frames to
look smooth. That cap only ever shortens a step, so the guarantee still holds.

## Collisions

Impulse based, with an effective mass:

```
k  = 1/ma + 1/mb + (ra · ra)/I + (rb · rb)/I
jn = -(1 + e) * (u_rel · n) / k
```

where `u_rel` is the relative velocity **of the contact points**, not of the
centres. That distinction is the whole thing: it lets the spin contribute.

For two balls, `n` runs through both centres and `r` is parallel to `n`, so the
cross products vanish and the normal impulse cannot change spin at all. All of
the interesting behaviour is in the tangential impulse:

```
t  = u_rel - n (u_rel · n)
jt = -|t| / kt,   clamped to  |jt| <= mu * |jn|
```

That clamped friction is what produces:

- **throw** — the object ball leaves 1–3° off the line of centres
- **spin transfer** — the object ball picks up a little of the cue ball's spin
- **english off a rail** — the cushion rebound angle changes with side spin

For the cushion, the contact point is not at the ball's equator. The nose of a
cushion sits at about 63.5% of the ball diameter, so the contact is roughly
`0.27 R` *above* the centre. That offset is why topspin and backspin change the
angle a ball leaves a rail.

## The cue strike

One impulse at an offset point gives both the velocity and the spin. The player
controls the offset, not the spin:

```
c = contact point on the back of the ball, offset by (a, b) * R
J = m * speed, along the cue direction
v = J / m
w = (c × J) / I
```

Hitting above centre leaves the ball with more spin than rolling needs, and it
then runs forward. Hitting below centre gives it spin the wrong way and it comes
back. Neither is special cased; both fall out of the impulse.

The offset is clamped to half a radius, which is about where a real tip would
miscue.

## Squirt

Squirt is empirically 2–3° at maximum side english, in the opposite direction to
the tip offset. It is not derivable from the impulse model above, so it is a
plain deflection of the launch direction:

```
angle = -a * 0.10        # a in units of R, so 0.05 rad at max
```

This one is a fudge, and it is the only one. It is worth keeping because without
it, side spin is free, and the game loses the trade-off that makes english
interesting.

## Constants

Straight off a 9ft table with 2¼" balls.

| | | |
|---|---|---|
| ball radius | 28.575 mm | 2.25 in |
| ball mass | 170 g | 6 oz |
| sliding friction | 0.20 | |
| rolling resistance | 0.04 | ~0.39 m/s² of decel |
| ball–ball restitution | 0.95 | |
| cushion restitution | 0.82 | |
| ball–ball friction | 0.06 | drives throw |
| cushion friction | 0.20 | drives english |
| max cue speed | 8 m/s | firm break |

## Known gaps

- **No masse.** A ball spinning about the vertical axis should curve as it
  travels. In the point-contact idealisation there is no slip from side spin, so
  it does not. Real tables get that curve from the contact patch, which needs a
  different model.
- **Pockets are a plane test.** A ball is pocketed when its centre leaves the
  playing rectangle. Because cushions block everywhere except the gaps, that one
  test covers all six pockets, but there is no actual pocket geometry.
- **Jaws are circles** at the cushion ends, not the angled cuts of a real table.
  They do rattle balls out, which is the behaviour that matters.
- **No jump shots.** Needs cue elevation in the input model and a vertical
  dimension in the simulation.
