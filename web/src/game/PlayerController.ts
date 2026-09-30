import { PlayerAction } from '../game/PlayerAction'
import type { SpriteAnimationSystem } from '../game/SpriteAnimationSystem'

/** Axis-aligned rectangle used for hit detection. */
export interface RectF {
  left: number
  top: number
  right: number
  bottom: number
}

export function rectsIntersect(a: RectF, b: RectF): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

/** Discrete things that happened this tick, drained by the world to spawn visual effects. */
export type PlayerEvent =
  | { type: 'jump' }
  | { type: 'land'; impact: number }
  | { type: 'dash' }
  | { type: 'attack' }
  | { type: 'heavy' }
  | { type: 'blockDeflect' }

/**
 * Controller connecting player physics, state machine, and SpriteAnimationSystem.
 * Decoupled from input mechanisms (touch, joystick, keyboard).
 * Mirrors PlayerController.kt.
 */
export class PlayerController {
  constructor(
    readonly animationSystem: SpriteAnimationSystem,
    public x = 200,
    public groundY = 260,
  ) {}

  // Spatial dimensions
  readonly width = 44
  readonly height = 70

  // Motion physics
  vx = 0
  vy = 0
  isGrounded = true
  isFacingRight = true

  // Combat Stats
  maxHp = 100
  hp = 100
  maxStamina = 100
  stamina = 100
  isInvulnerable = false
  isBlocking = false

  // Constants
  private readonly walkSpeed = 150
  private readonly jumpImpulse = -360
  private readonly gravity = 880
  private readonly dashSpeed = 380
  private readonly dashDuration = 0.22

  // Internal state timers
  private dashTimer = 0
  /** Attacks whose hit window has already fired, so one swing hits at most once. */
  private readonly hitWindowConsumed = new Set<PlayerAction>()

  /** Effect events since the world last drained them (capped so an undrained queue cannot grow). */
  readonly events: PlayerEvent[] = []

  private emit(e: PlayerEvent): void {
    if (this.events.length < 32) this.events.push(e)
  }

  get isDashing(): boolean {
    return this.dashTimer > 0
  }

  // Input buffer
  private inputMoveX = 0
  private isBlockInputActive = false

  /** Hitbox for damage detection. */
  get hitbox(): RectF {
    return { left: this.x - this.width / 2, top: this.groundY - this.height, right: this.x + this.width / 2, bottom: this.groundY }
  }

  /** Sword attack reach rectangle, facing in the current direction. */
  get attackHitbox(): RectF {
    const reach = 54
    return this.isFacingRight
      ? { left: this.x, top: this.groundY - this.height * 0.85, right: this.x + reach, bottom: this.groundY - this.height * 0.1 }
      : { left: this.x - reach, top: this.groundY - this.height * 0.85, right: this.x, bottom: this.groundY - this.height * 0.1 }
  }

  setMovementInput(horizontal: number): void {
    this.inputMoveX = Math.min(1, Math.max(-1, horizontal))
    if (Math.abs(this.inputMoveX) > 0.08 && this.canTurn()) {
      this.isFacingRight = this.inputMoveX > 0
    }
  }

  setBlockActive(active: boolean): void {
    this.isBlockInputActive = active
  }

  onJump(): boolean {
    if (!this.isGrounded || this.isAttacking() || this.dashTimer > 0) return false
    this.vy = this.jumpImpulse
    this.isGrounded = false
    this.animationSystem.playAction(PlayerAction.JUMP)
    this.emit({ type: 'jump' })
    return true
  }

  onDash(): boolean {
    if (this.dashTimer > 0 || this.stamina < 25 || this.isAttacking()) return false
    this.stamina -= 25
    this.dashTimer = this.dashDuration
    this.isInvulnerable = true
    this.animationSystem.playAction(PlayerAction.DASH, true)
    this.emit({ type: 'dash' })
    return true
  }

  onAttack(): boolean {
    if (this.dashTimer > 0 || !this.isGrounded) return false
    this.hitWindowConsumed.delete(PlayerAction.ATTACK)
    const switched = this.animationSystem.playAction(PlayerAction.ATTACK, true)
    if (switched) {
      this.vx = this.isFacingRight ? 40 : -40 // slight forward lunge
      this.emit({ type: 'attack' })
    }
    return switched
  }

  onHeavyAttack(): boolean {
    if (this.dashTimer > 0 || !this.isGrounded || this.stamina < 20) return false
    this.stamina -= 20
    this.hitWindowConsumed.delete(PlayerAction.HEAVY_ATTACK)
    const switched = this.animationSystem.playAction(PlayerAction.HEAVY_ATTACK, true)
    if (switched) {
      this.vx = 0
      this.emit({ type: 'heavy' })
    }
    return switched
  }

  onHurt(damage: number): boolean {
    if (this.isInvulnerable || this.hp <= 0) return false
    if (this.isBlocking && this.stamina >= 10) {
      // Block deflecting
      this.stamina -= 15
      this.hp -= Math.trunc(damage * 0.2)
      this.emit({ type: 'blockDeflect' })
      return false // Deflected!
    }
    this.hp = Math.max(0, this.hp - damage)
    if (this.hp <= 0) {
      this.animationSystem.playAction(PlayerAction.DEATH)
    } else {
      this.animationSystem.playAction(PlayerAction.HURT, true)
    }
    return true
  }

  resetPlayer(spawnX: number, spawnGroundY: number): void {
    this.x = spawnX
    this.groundY = spawnGroundY
    this.vx = 0
    this.vy = 0
    this.hp = this.maxHp
    this.stamina = this.maxStamina
    this.isGrounded = true
    this.isFacingRight = true
    this.dashTimer = 0
    this.isInvulnerable = false
    this.isBlocking = false
    this.events.length = 0 // a reset must not replay effects from before it
    this.animationSystem.playAction(PlayerAction.IDLE, true)
  }

  update(dt: number, worldMinX: number, worldMaxX: number, floorY: number): void {
    // Regenerate stamina
    if (!this.isBlocking) {
      this.stamina = Math.min(this.maxStamina, this.stamina + 20 * dt)
    }

    // Handle dash state
    if (this.dashTimer > 0) {
      this.dashTimer -= dt
      this.vx = this.isFacingRight ? this.dashSpeed : -this.dashSpeed
      if (this.dashTimer <= 0) {
        this.isInvulnerable = false
      }
    } else if (this.isAttacking()) {
      // Decelerate during attack animations
      this.vx *= 0.8
    } else if (this.isBlockInputActive && this.isGrounded) {
      this.isBlocking = true
      this.vx = 0
    } else {
      this.isBlocking = false
      // Normal horizontal movement
      this.vx = Math.abs(this.inputMoveX) > 0.08 ? this.inputMoveX * this.walkSpeed : 0
    }

    // Apply horizontal motion
    this.x += this.vx * dt
    this.x = Math.min(Math.max(this.x, worldMinX + this.width / 2), worldMaxX - this.width / 2)

    // Apply gravity & vertical motion
    if (!this.isGrounded) {
      this.vy += this.gravity * dt
      this.groundY += this.vy * dt
      if (this.groundY >= floorY) {
        this.groundY = floorY
        this.emit({ type: 'land', impact: this.vy })
        this.vy = 0
        this.isGrounded = true
      }
    }

    // Advance animation system clock, then resolve the animation state machine.
    this.animationSystem.update(dt)
    this.updateAnimationState()
  }

  /**
   * Determines which animation should be active based on physics and action states.
   * Crucially: avoids restarting animation every frame when remaining in the same state.
   */
  private updateAnimationState(): void {
    if (this.hp <= 0) {
      this.animationSystem.playAction(PlayerAction.DEATH)
      return
    }

    // If currently playing a non-looping action, let it finish uninterrupted.
    const current = this.animationSystem.currentAction
    if (
      current === PlayerAction.ATTACK ||
      current === PlayerAction.HEAVY_ATTACK ||
      current === PlayerAction.DASH ||
      current === PlayerAction.HURT
    ) {
      if (!this.animationSystem.isFinished) {
        return
      }
    }

    if (this.isBlocking) {
      this.animationSystem.playAction(PlayerAction.BLOCK)
      return
    }

    if (!this.isGrounded) {
      this.animationSystem.playAction(PlayerAction.JUMP)
      return
    }

    if (Math.abs(this.vx) > 10 || Math.abs(this.inputMoveX) > 0.08) {
      this.animationSystem.playAction(PlayerAction.WALK)
      return
    }

    // Stopped: smoothly return to IDLE
    this.animationSystem.playAction(PlayerAction.IDLE)
  }

  isAttacking(): boolean {
    const a = this.animationSystem.currentAction
    return (a === PlayerAction.ATTACK || a === PlayerAction.HEAVY_ATTACK) && !this.animationSystem.isFinished
  }

  private canTurn(): boolean {
    return !this.isAttacking() && this.dashTimer <= 0
  }

  /** True exactly once, when the attack reaches its active damage frame. */
  shouldCheckAttackHit(): boolean {
    return this.consumeHitWindow(PlayerAction.ATTACK)
  }

  shouldCheckHeavyAttackHit(): boolean {
    return this.consumeHitWindow(PlayerAction.HEAVY_ATTACK)
  }

  /**
   * Reports whether the given attack's blade is live on the current frame.
   *
   * The window comes from the sheet's config rather than being hardcoded here, so
   * it stays correct when the artwork changes: it is the frame range over which
   * the sword is actually extended, measured from the sheet. The window is
   * consumed on the first frame it covers, so one swing can only ever hit once
   * even though the window spans several frames.
   */
  private consumeHitWindow(action: PlayerAction): boolean {
    if (this.animationSystem.currentAction !== action) return false
    if (this.hitWindowConsumed.has(action)) return false

    const window = this.animationSystem.getConfig(action)?.hitFrames
    if (!window) return false

    const frame = this.animationSystem.currentFrameIndex
    if (frame < window[0] || frame > window[1]) return false

    this.hitWindowConsumed.add(action)
    return true
  }
}
