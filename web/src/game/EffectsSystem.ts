import type { PlayerAction } from './PlayerAction'

/** Colour as an "r,g,b" triple so alpha can be applied per frame. */
type Rgb = string

const DUST: Rgb = '190,178,160'
const STEEL: Rgb = '205,230,255'
const FIRE: Rgb = '255,170,60'
const EMBER: Rgb = '255,120,40'
const DASH_CYAN: Rgb = '110,210,255'
const SPARK_BLUE: Rgb = '120,180,255'
const WHITE: Rgb = '255,255,255'

const rgba = (c: Rgb, a: number): string => `rgba(${c},${Math.max(0, Math.min(1, a)).toFixed(3)})`
const rand = (min: number, max: number): number => min + Math.random() * (max - min)

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  maxLife: number
  size: number
  color: Rgb
  gravity: number
  drag: number
  /** A streak drawn along its velocity instead of a square. */
  streak: boolean
}

interface Ring {
  x: number
  y: number
  radius: number
  maxRadius: number
  /** Vertical squash: 1 is a circle, ~0.25 is a ring lying on the floor. */
  squash: number
  life: number
  maxLife: number
  width: number
  color: Rgb
}

export interface Ghost {
  action: PlayerAction
  frame: number
  x: number
  bottomY: number
  size: number
  facingRight: boolean
  life: number
  maxLife: number
}

/** Geometry the effects need about the player, so this file has no dependency on PlayerController. */
export interface Anchor {
  x: number
  groundY: number
  height: number
  facing: 1 | -1
}

const easeOut = (t: number): number => 1 - (1 - t) * (1 - t)

/**
 * Visual-only combat and movement effects: dust, shockwaves, dash
 * afterimages, block sparks, hit sparks, screen shake, hit-stop and screen flash.
 *
 * Nothing here changes gameplay state except `hitStop`, which the world reads to
 * briefly freeze the simulation on impact.
 */
export class EffectsSystem {
  readonly particles: Particle[] = []
  readonly rings: Ring[] = []
  readonly ghosts: Ghost[] = []

  /** Seconds of simulation freeze still owed; drained by the world. */
  hitStop = 0

  /** Current screen-shake offset in logical px, refreshed by update(). */
  shakeX = 0
  shakeY = 0
  private shakeTime = 0
  private shakeDuration = 0.001
  private shakeMag = 0

  private flashTime = 0
  private flashDuration = 0.001
  private flashPeak = 0
  private flashColor: Rgb = WHITE

  private ghostTimer = 0

  // ---------------------------------------------------------------- spawning

  private dust(x: number, y: number, count: number, spread: number, dirX = 0, speed = 40): void {
    for (let i = 0; i < count; i++) {
      const side = dirX !== 0 ? dirX : Math.random() < 0.5 ? -1 : 1
      const life = rand(0.25, 0.45)
      this.particles.push({
        x: x + rand(-spread, spread) * 0.4,
        y: y - rand(0, 2),
        vx: side * rand(speed * 0.4, speed) * (dirX !== 0 ? 1 : Math.random()),
        vy: -rand(8, 34),
        life,
        maxLife: life,
        size: rand(2, 4.5),
        color: DUST,
        gravity: 20,
        drag: 2.5,
        streak: false,
      })
    }
  }

  private ring(x: number, y: number, maxRadius: number, squash: number, life: number, width: number, color: Rgb): void {
    this.rings.push({ x, y, radius: maxRadius * 0.15, maxRadius, squash, life, maxLife: life, width, color })
  }

  private shake(mag: number, duration: number): void {
    // Never let a weak shake cut a stronger one short.
    if (mag * duration < this.shakeMag * this.shakeTime) return
    this.shakeMag = mag
    this.shakeTime = duration
    this.shakeDuration = duration
  }

  private flash(peak: number, duration: number, color: Rgb = WHITE): void {
    if (peak < this.flashPeak * (this.flashTime / this.flashDuration)) return
    this.flashPeak = peak
    this.flashTime = duration
    this.flashDuration = duration
    this.flashColor = color
  }

  private stop(seconds: number): void {
    this.hitStop = Math.max(this.hitStop, seconds)
  }

  // ----------------------------------------------------------------- triggers

  jump(a: Anchor): void {
    this.dust(a.x, a.groundY, 8, 22)
    this.ring(a.x, a.groundY, 20, 0.22, 0.28, 1.5, DUST)
  }

  /** `impact` is the downward speed at touchdown (px/s). */
  land(a: Anchor, impact: number): void {
    const t = Math.min(1, Math.max(0, (impact - 120) / 420))
    this.dust(a.x, a.groundY, 6 + Math.round(t * 8), 26, 0, 55 + t * 60)
    this.ring(a.x, a.groundY, 16 + t * 26, 0.22, 0.3, 1.5 + t, DUST)
    if (t > 0.55) this.shake(1.2 + t * 1.3, 0.14)
  }

  dash(a: Anchor): void {
    this.dust(a.x, a.groundY, 9, 10, -a.facing, 90)
    // Speed streaks trailing behind the knight at body height.
    for (let i = 0; i < 7; i++) {
      const life = rand(0.15, 0.28)
      this.particles.push({
        x: a.x - a.facing * rand(4, 20),
        y: a.groundY - rand(6, a.height * 0.9),
        vx: -a.facing * rand(120, 240),
        vy: 0,
        life,
        maxLife: life,
        size: rand(8, 18),
        color: DASH_CYAN,
        gravity: 0,
        drag: 5,
        streak: true,
      })
    }
    this.ring(a.x, a.groundY - a.height * 0.45, 26, 1, 0.16, 1.5, DASH_CYAN)
  }

  /** Called every frame while dashing; emits afterimages at a fixed cadence. */
  dashTrail(dt: number, ghost: Omit<Ghost, 'life' | 'maxLife'>): void {
    this.ghostTimer -= dt
    if (this.ghostTimer > 0) return
    this.ghostTimer = 0.03
    this.ghosts.push({ ...ghost, life: 0.26, maxLife: 0.26 })
  }

  /** Light attack start: a little floor scuff from the forward lunge. */
  attackStart(a: Anchor): void {
    this.dust(a.x - a.facing * 6, a.groundY, 4, 8, -a.facing, 45)
  }

  /** Heavy attack wind-up: sparks pulled in toward the blade side. */
  heavyStart(a: Anchor): void {
    for (let i = 0; i < 12; i++) {
      const ang = rand(0, Math.PI * 2)
      const dist = rand(26, 44)
      const cx = a.x + a.facing * 12
      const cy = a.groundY - a.height * 0.6
      const life = rand(0.16, 0.26)
      this.particles.push({
        x: cx + Math.cos(ang) * dist,
        y: cy + Math.sin(ang) * dist,
        vx: (-Math.cos(ang) * dist) / life,
        vy: (-Math.sin(ang) * dist) / life,
        life,
        maxLife: life,
        size: rand(2, 3.5),
        color: FIRE,
        gravity: 0,
        drag: 0,
        streak: false,
      })
    }
    this.dust(a.x, a.groundY, 6, 16)
  }

  /** The blade is live. No arc is drawn; a heavy swing still slams the floor (shockwave, dust, debris, shake). */
  swing(a: Anchor, heavy: boolean): void {
    if (!heavy) return
    const front = a.x + a.facing * 34
    this.ring(front, a.groundY, 58, 0.2, 0.34, 2.5, FIRE)
    this.ring(front, a.groundY, 36, 0.2, 0.26, 1.5, WHITE)
    this.dust(front, a.groundY, 12, 24, a.facing, 110)
    // Debris chips kicked up by the slam.
    for (let i = 0; i < 8; i++) {
      const life = rand(0.3, 0.5)
      this.particles.push({
        x: front + rand(-14, 14),
        y: a.groundY - 1,
        vx: a.facing * rand(20, 110) + rand(-30, 30),
        vy: -rand(90, 190),
        life,
        maxLife: life,
        size: rand(2, 3.5),
        color: EMBER,
        gravity: 520,
        drag: 0.4,
        streak: false,
      })
    }
    this.shake(3, 0.2)
  }

  /** Sword connected with a target. */
  hit(x: number, y: number, facing: 1 | -1, heavy: boolean): void {
    const color = heavy ? FIRE : STEEL
    // Impact starburst: fast streaks radiating out, biased in the swing direction.
    const streaks = heavy ? 14 : 8
    for (let i = 0; i < streaks; i++) {
      const ang = rand(-1.1, 1.1) + (facing === 1 ? 0 : Math.PI)
      const spd = rand(140, heavy ? 340 : 240)
      const life = rand(0.12, 0.24)
      this.particles.push({
        x,
        y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd - 20,
        life,
        maxLife: life,
        size: rand(7, heavy ? 16 : 11),
        color: i % 3 === 0 ? WHITE : color,
        gravity: 60,
        drag: 4,
        streak: true,
      })
    }
    this.ring(x, y, heavy ? 34 : 22, 1, heavy ? 0.22 : 0.16, heavy ? 3 : 2, WHITE)
    if (heavy) {
      for (let i = 0; i < 10; i++) {
        const life = rand(0.5, 0.9)
        this.particles.push({
          x: x + rand(-8, 8),
          y: y + rand(-14, 10),
          vx: rand(-60, 60) + facing * 30,
          vy: -rand(40, 130),
          life,
          maxLife: life,
          size: rand(1.5, 3),
          color: EMBER,
          gravity: 90,
          drag: 0.6,
          streak: false,
        })
      }
      this.flash(0.28, 0.14)
      this.shake(3.6, 0.22)
      this.stop(0.09)
    } else {
      this.shake(1.2, 0.09)
      this.stop(0.04)
    }
  }

  /** An incoming hit landed on the raised sword: sparks, a ring, a small shake and a brief freeze. */
  blockDeflect(a: Anchor): void {
    const x = a.x + a.facing * 36
    const y = a.groundY - a.height * 0.5
    for (let i = 0; i < 12; i++) {
      const ang = rand(-1.3, 1.3) + (a.facing === 1 ? 0 : Math.PI)
      const spd = rand(90, 240)
      const life = rand(0.14, 0.3)
      this.particles.push({
        x,
        y: y + rand(-14, 14),
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        life,
        maxLife: life,
        size: rand(6, 12),
        color: i % 2 ? WHITE : SPARK_BLUE,
        gravity: 100,
        drag: 3,
        streak: true,
      })
    }
    this.ring(x, y, 26, 1, 0.2, 2.5, WHITE)
    this.shake(1.6, 0.12)
    this.stop(0.05)
    this.flash(0.12, 0.1, SPARK_BLUE)
  }

  // ------------------------------------------------------------------- update

  update(dt: number): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]
      p.life -= dt
      if (p.life <= 0) {
        this.particles.splice(i, 1)
        continue
      }
      const damp = Math.max(0, 1 - p.drag * dt)
      p.vx *= damp
      p.vy = p.vy * damp + p.gravity * dt
      p.x += p.vx * dt
      p.y += p.vy * dt
    }

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i]
      r.life -= dt
      if (r.life <= 0) {
        this.rings.splice(i, 1)
        continue
      }
      const t = 1 - r.life / r.maxLife
      r.radius = r.maxRadius * (0.15 + 0.85 * easeOut(t))
    }

    for (let i = this.ghosts.length - 1; i >= 0; i--) {
      this.ghosts[i].life -= dt
      if (this.ghosts[i].life <= 0) this.ghosts.splice(i, 1)
    }

    if (this.flashTime > 0) this.flashTime = Math.max(0, this.flashTime - dt)

    if (this.shakeTime > 0) {
      this.shakeTime = Math.max(0, this.shakeTime - dt)
      const k = this.shakeTime / this.shakeDuration
      this.shakeX = rand(-1, 1) * this.shakeMag * k
      this.shakeY = rand(-1, 1) * this.shakeMag * k
      if (this.shakeTime === 0) this.shakeMag = 0
    } else {
      this.shakeX = 0
      this.shakeY = 0
    }
  }

  /** Consumes freeze time; returns true while the simulation should stay frozen. */
  drainHitStop(dt: number): boolean {
    if (this.hitStop <= 0) return false
    this.hitStop = Math.max(0, this.hitStop - dt)
    return true
  }

  // ------------------------------------------------------------------- render

  /** Everything that sits behind the knight (ground rings, afterimages) is drawn by the caller; this covers rings + particles on top. */
  renderBehind(ctx: CanvasRenderingContext2D): void {
    for (const r of this.rings) {
      if (r.squash >= 0.5) continue // floor rings only
      this.strokeRing(ctx, r)
    }
  }

  renderFront(ctx: CanvasRenderingContext2D): void {
    for (const r of this.rings) {
      if (r.squash < 0.5) continue
      this.strokeRing(ctx, r)
    }

    for (const p of this.particles) {
      const a = p.life / p.maxLife
      if (p.streak) {
        const len = p.size * a
        const speed = Math.hypot(p.vx, p.vy) || 1
        ctx.strokeStyle = rgba(p.color, a)
        ctx.lineWidth = 1.5
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.moveTo(p.x, p.y)
        ctx.lineTo(p.x - (p.vx / speed) * len, p.y - (p.vy / speed) * len)
        ctx.stroke()
      } else {
        const size = p.size * (0.5 + 0.5 * a)
        ctx.fillStyle = rgba(p.color, p.color === DUST ? a * 0.6 : a)
        ctx.fillRect(Math.round(p.x - size / 2), Math.round(p.y - size / 2), Math.max(1, Math.round(size)), Math.max(1, Math.round(size)))
      }
    }
  }

  private strokeRing(ctx: CanvasRenderingContext2D, r: Ring): void {
    const a = r.life / r.maxLife
    ctx.strokeStyle = rgba(r.color, a * 0.9)
    ctx.lineWidth = Math.max(0.5, r.width * a)
    ctx.beginPath()
    ctx.ellipse(r.x, r.y, r.radius, r.radius * r.squash, 0, 0, Math.PI * 2)
    ctx.stroke()
  }

  /** Afterimages, drawn by the caller through the sprite system so they use real frames. */
  forEachGhost(fn: (g: Ghost, alpha: number) => void): void {
    for (const g of this.ghosts) fn(g, (g.life / g.maxLife) * 0.55)
  }

  /** Full-screen colour flash, drawn in logical (screen) space after the world. */
  renderFlash(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    if (this.flashTime <= 0) return
    const a = this.flashPeak * (this.flashTime / this.flashDuration)
    ctx.fillStyle = rgba(this.flashColor, a)
    ctx.fillRect(0, 0, w, h)
  }
}
