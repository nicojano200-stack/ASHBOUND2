import { EffectsSystem } from './EffectsSystem'
import { DamageText, SparkParticle, TrainingDummy } from './CombatEntity'
import { PlayerController, rectsIntersect, type PlayerEvent } from './PlayerController'
import type { SpriteAnimationSystem } from './SpriteAnimationSystem'
import { DEFAULT_FOOT_ROW, footOffsetForRow } from './spriteMetrics'

/** A decoded image plus its intrinsic size, needed for 9-argument drawImage. */
export interface LoadedImage {
  image: CanvasImageSource
  width: number
  height: number
}

/**
 * 2D Game World managing world bounds, logical resolution, arena scenery,
 * training combat targets, and particle systems.
 * Mirrors GameWorld.kt.
 */
export class GameWorld {
  static readonly LOGICAL_WIDTH = 640
  static readonly LOGICAL_HEIGHT = 360

  /**
   * Native pixel size of the arena backdrop (img_arena_bg_hd.png, synced to
   * bg/arena_bg.png). The backdrop is drawn with a single uniform scale, so any
   * source row maps to logical Y via: row * LOGICAL_HEIGHT / this.
   */
  static readonly BACKGROUND_WIDTH = 1536
  static readonly BACKGROUND_HEIGHT = 864

  /** Uniform scale the backdrop is drawn at. 360 / 864 is exactly 5/12. */
  static readonly BACKGROUND_SCALE = GameWorld.LOGICAL_HEIGHT / GameWorld.BACKGROUND_HEIGHT

  /**
   * Logical size of the backdrop once scaled.
   *
   * 1536 x 5/12 is exactly 640 and 864 x 5/12 is exactly 360: the artwork is a
   * single frame that covers the viewport precisely. It is one finite environment,
   * not a texture, so it is drawn once, never repeated and never mirrored.
   */
  static readonly BACKGROUND_LOGICAL_WIDTH = GameWorld.BACKGROUND_WIDTH * GameWorld.BACKGROUND_SCALE
  static readonly BACKGROUND_LOGICAL_HEIGHT = GameWorld.BACKGROUND_HEIGHT * GameWorld.BACKGROUND_SCALE

  /**
   * Width of the playable world, in logical pixels.
   *
   * The world is exactly the backdrop: the player can walk the full width of the
   * painted arena, and the arena edge is the world edge. Because the backdrop is
   * one frame, the camera has no room to scroll, and there is nothing beyond the
   * edges that could be filled with a flipped or repeated copy.
   */
  static readonly WORLD_WIDTH = GameWorld.BACKGROUND_LOGICAL_WIDTH

  /**
   * Centre of the playable arena, in world units.
   *
   * Derived from the world, not from the screen, so the spawn scales with the
   * arena rather than drifting with the viewport.
   */
  static readonly ARENA_CENTER_X = GameWorld.WORLD_WIDTH / 2

  /**
   * Initial world X for the player: the arena centre, which leaves the full
   * half-width of arena on both sides to walk into.
   */
  static readonly SPAWN_X = GameWorld.ARENA_CENTER_X

  /**
   * World X of the first training dummy. Placed to the right of the spawn so the
   * match opens as player-versus-target, and left untouched thereafter: a fixed
   * world position, not a screen or player-relative one.
   */
  static readonly DUMMY_X = GameWorld.ARENA_CENTER_X + 130

  /** World distance between the two training dummies. */
  static readonly DUMMY_SPACING = 120

  /**
   * Row of the visible stone floor surface, measured from the backdrop artwork.
   *
   * Row statistics across the image width show a hard horizon: row 532 is still
   * dark wall (mean 21.6, 18.5% lit, 43.9% of sampled columns agreeing), while row
   * 533 is the first lit floor row (mean 31.5, 51.2% lit, 68.9% coherent). The
   * edge is horizontal, so one world-space plane is exact across the arena. The
   * bright seam further down at row 620 is a flagstone joint *inside* the floor,
   * not its top edge, and using it left the knight standing in front of the wall.
   */
  static readonly BACKGROUND_FLOOR_ROW = 533

  /**
   * World-space ground / collision plane, in logical pixels.
   *
   * The player's visible feet rest exactly on this Y at all times, and it is the Y
   * the jump impulse starts from and gravity returns to. Derived from the backdrop
   * rather than guessed, so the knight stands on the drawn stone floor instead of
   * an arbitrary line near the bottom of the screen.
   */
  static readonly FLOOR_Y = (GameWorld.BACKGROUND_FLOOR_ROW * GameWorld.LOGICAL_HEIGHT) / GameWorld.BACKGROUND_HEIGHT

  /** Logical size a 128px sprite cell is drawn at (aspect preserved). */
  static readonly SPRITE_DISPLAY_SIZE = 100

  /**
   * Rest-pose foot offset, i.e. the padding below the opaque pixels of the idle
   * sheet's frames. Kept for diagnostics and tests; the renderer uses the
   * per-frame value from the animation system instead, since the walk cycle's
   * contact row is not constant.
   */
  static readonly SPRITE_FOOT_OFFSET = footOffsetForRow(DEFAULT_FOOT_ROW, GameWorld.SPRITE_DISPLAY_SIZE)

  readonly player: PlayerController
  readonly dummies: TrainingDummy[]
  readonly damageTexts: DamageText[] = []
  readonly particles: SparkParticle[] = []
  readonly effects = new EffectsSystem()

  private background: LoadedImage | null = null

  /**
   * Camera view offset, in world units. Everything in the arena (backdrop, player,
   * dummies, hitboxes) lives in world space and is drawn through this single
   * transform, so a world-fixed object stays locked to the dungeon as the player
   * walks.
   */
  cameraX = 0

  constructor(
    readonly animationSystem: SpriteAnimationSystem,
    background: LoadedImage | null = null,
  ) {
    this.player = new PlayerController(animationSystem, GameWorld.SPAWN_X, GameWorld.FLOOR_Y)
    // Dummies are world fixtures at fixed world X. They are never derived from the
    // player, and their groundY is the same FLOOR_Y the player stands on.
    this.dummies = [
      new TrainingDummy(GameWorld.DUMMY_X, GameWorld.FLOOR_Y),
      new TrainingDummy(GameWorld.DUMMY_X + GameWorld.DUMMY_SPACING, GameWorld.FLOOR_Y),
    ]
    this.background = background
    // Start with the player already centred, instead of easing in from the left
    // edge on the first frames of the match.
    this.cameraX = this.cameraXForPlayerX(this.player.x)
  }

  /** Camera offset that puts a given world X at the centre of the viewport. */
  cameraXForPlayerX(worldX: number): number {
    return Math.min(Math.max(worldX - GameWorld.LOGICAL_WIDTH / 2, 0), GameWorld.WORLD_WIDTH - GameWorld.LOGICAL_WIDTH)
  }

  setBackground(background: LoadedImage | null): void {
    this.background = background
  }

  update(dt: number): void {
    const clampedDt = Math.min(0.05, Math.max(0.001, dt))

    // Effects run on real time; hit-stop freezes only the simulation below.
    this.effects.update(clampedDt)
    if (this.effects.drainHitStop(clampedDt)) return

    // Update player
    this.player.update(clampedDt, 0, GameWorld.WORLD_WIDTH, GameWorld.FLOOR_Y)
    this.spawnPlayerEffects(clampedDt)

    // Camera smoothly follows player within world bounds
    const targetCamX = Math.min(
      Math.max(this.player.x - GameWorld.LOGICAL_WIDTH / 2, 0),
      GameWorld.WORLD_WIDTH - GameWorld.LOGICAL_WIDTH,
    )
    this.cameraX += (targetCamX - this.cameraX) * 0.15

    // Check attack collisions
    if (this.player.shouldCheckAttackHit()) {
      this.effects.swing(this.anchor(), false)
      this.performAttackHitCheck(18, false)
    }
    if (this.player.shouldCheckHeavyAttackHit()) {
      this.effects.swing(this.anchor(), true)
      this.performAttackHitCheck(45, true)
    }

    for (const dummy of this.dummies) {
      dummy.update(clampedDt)
    }

    for (let i = this.damageTexts.length - 1; i >= 0; i--) {
      if (!this.damageTexts[i].update(clampedDt)) this.damageTexts.splice(i, 1)
    }

    for (let i = this.particles.length - 1; i >= 0; i--) {
      if (!this.particles[i].update(clampedDt)) this.particles.splice(i, 1)
    }
  }

  private anchor() {
    return {
      x: this.player.x,
      groundY: this.player.groundY,
      height: this.player.height,
      facing: (this.player.isFacingRight ? 1 : -1) as 1 | -1,
    }
  }

  /** Turns the player's discrete events (and dash trail) into visual effects. */
  private spawnPlayerEffects(dt: number): void {
    const a = this.anchor()
    const events: PlayerEvent[] = this.player.events.splice(0)
    for (const e of events) {
      switch (e.type) {
        case 'jump':
          this.effects.jump(a)
          break
        case 'land':
          this.effects.land(a, e.impact)
          break
        case 'dash':
          this.effects.dash(a)
          break
        case 'attack':
          this.effects.attackStart(a)
          break
        case 'heavy':
          this.effects.heavyStart(a)
          break
        case 'blockDeflect':
          this.effects.blockDeflect(a)
          break
      }
    }

    if (this.player.isDashing) {
      const size = this.animationSystem.displaySizeForCurrentSheet(GameWorld.SPRITE_DISPLAY_SIZE)
      this.effects.dashTrail(dt, {
        action: this.animationSystem.currentAction,
        frame: this.animationSystem.currentFrameIndex,
        x: this.player.x,
        bottomY: this.player.groundY + this.animationSystem.footOffsetForCurrentFrame(GameWorld.SPRITE_DISPLAY_SIZE),
        size,
        facingRight: this.player.isFacingRight,
      })
    }
  }

  private performAttackHitCheck(damage: number, isHeavy: boolean): void {
    const atkBox = this.player.attackHitbox
    for (const dummy of this.dummies) {
      if (!rectsIntersect(atkBox, dummy.hitbox)) continue

      dummy.takeDamage(damage)
      this.effects.hit(dummy.x, dummy.groundY - dummy.height / 2, this.player.isFacingRight ? 1 : -1, isHeavy)

      // Spawn floating damage text
      const dColor = isHeavy ? 'rgb(255, 180, 50)' : 'rgb(240, 240, 255)'
      const dText = isHeavy ? `CRIT ${damage}!` : `${damage}`
      this.damageTexts.push(new DamageText(dummy.x, dummy.groundY - dummy.height - 15, dText, dColor))

      // Spawn sparks
      const sparkCount = isHeavy ? 18 : 10
      for (let i = 0; i < sparkCount; i++) {
        const angle = Math.random() * Math.PI * 2
        const speed = Math.random() * 120 + 50
        this.particles.push(
          new SparkParticle(
            dummy.x + (Math.random() - 0.5) * 16,
            dummy.groundY - dummy.height / 2 + (Math.random() - 0.5) * 20,
            Math.cos(angle) * speed,
            Math.sin(angle) * speed - 60,
            isHeavy ? 'rgb(255, 200, 80)' : 'rgb(220, 240, 255)',
            isHeavy ? 4 : 3,
          ),
        )
      }
    }
  }

  /**
   * Draws the backdrop once, in world space, at its natural size.
   *
   * The artwork is a single finite environment that already covers the viewport
   * exactly, so it is neither mirrored, repeated, nor flipped. It is anchored to
   * world (0, 0) and the camera is clamped to the world, so the plate can never
   * be drawn twice or leave a gap at either edge.
   */
  private drawBackdrop(ctx: CanvasRenderingContext2D): void {
    const bg = this.background
    if (!bg) {
      // Fallback dark castle gradient
      ctx.fillStyle = 'rgb(18, 20, 28)'
      ctx.fillRect(0, 0, GameWorld.WORLD_WIDTH, GameWorld.LOGICAL_HEIGHT)
      return
    }

    ctx.drawImage(
      bg.image,
      0,
      0,
      bg.width,
      bg.height,
      0,
      0,
      bg.width * GameWorld.BACKGROUND_SCALE,
      bg.height * GameWorld.BACKGROUND_SCALE,
    )
  }

  /**
   * Draws the character sprite and nothing else, in the caller's (already camera
   * translated) coordinate space.
   *
   * Split out of {@link render} so headless verification can run the real drawing
   * path onto a transparent surface and read the foot line straight off the alpha
   * channel, instead of inferring it from a difference against the backdrop.
   */
  renderCharacter(ctx: CanvasRenderingContext2D): void {
    // A cell is drawn square, and the sheet's own display scale is applied so a
    // grid-packed sheet (attack) still matches the strip sheets on screen. The
    // cell's transparent lower edge is corrected per frame so the visible feet —
    // and therefore the collision bottom — land exactly on FLOOR_Y.
    const spriteDisplaySize = this.animationSystem.displaySizeForCurrentSheet(GameWorld.SPRITE_DISPLAY_SIZE)
    this.animationSystem.render(
      ctx,
      this.player.x,
      this.player.groundY + this.animationSystem.footOffsetForCurrentFrame(GameWorld.SPRITE_DISPLAY_SIZE),
      spriteDisplaySize,
      spriteDisplaySize,
      this.player.isFacingRight,
    )
  }

  /** Renders the game world. The ctx is already in logical coordinates. */
  render(ctx: CanvasRenderingContext2D): void {
    ctx.save()
    // Screen shake, with a tiny overscan so the backdrop edge never shows a gap.
    const fx = this.effects
    if (fx.shakeX !== 0 || fx.shakeY !== 0) {
      const w = GameWorld.LOGICAL_WIDTH
      const h = GameWorld.LOGICAL_HEIGHT
      const k = 1 + (Math.abs(fx.shakeX) + Math.abs(fx.shakeY)) * 2 / w
      ctx.translate(w / 2 + fx.shakeX, h / 2 + fx.shakeY)
      ctx.scale(k, k)
      ctx.translate(-w / 2, -h / 2)
    }
    // Single world -> screen transform. The backdrop, the player, the dummies and
    // every hitbox all live in the same world space, so a world-fixed object stays
    // locked to the dungeon while the player walks.
    ctx.translate(-this.cameraX, 0)

    // 1. Backdrop, drawn once in world space at a single uniform scale.
    //
    // The artwork already covers the viewport exactly and the world is exactly as
    // wide as the artwork, so there is nothing to repeat, mirror or fill in: the
    // plate is drawn at world (0, 0) and the camera never leaves [0, 0].
    this.drawBackdrop(ctx)

    // 2. Arena boundary stone pillars, in world space at the arena edges.
    //
    // No ground slab or flagstone grid is drawn here on purpose: the backdrop
    // already renders a detailed stone floor starting at FLOOR_Y, and painting an
    // opaque rectangle over that area is what previously hid the very surface the
    // player has to stand on.
    ctx.fillStyle = 'rgb(50, 55, 70)'
    ctx.fillRect(0, 0, 24, GameWorld.FLOOR_Y)
    ctx.fillRect(GameWorld.WORLD_WIDTH - 24, 0, GameWorld.WORLD_WIDTH, GameWorld.FLOOR_Y)

    // 3. Render Training Dummies. Their x and groundY are world values, so these
    // draw at world position and the camera transform handles the rest.
    for (const dummy of this.dummies) {
      dummy.render(ctx)
    }

    // 4. Character contact shadow, seated on the floor line.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.32)'
    ctx.beginPath()
    ctx.ellipse(this.player.x, GameWorld.FLOOR_Y + 1, 18, 3, 0, 0, Math.PI * 2)
    ctx.fill()

    // 4b. Floor-level effects (dust rings, shockwaves) sit under the knight.
    this.effects.renderBehind(ctx)

    // 4c. Dash afterimages, tinted and fading, behind the live sprite.
    this.effects.forEachGhost((g, alpha) => {
      ctx.save()
      ctx.globalAlpha = alpha
      this.animationSystem.renderFrame(ctx, g.action, g.frame, g.x, g.bottomY, g.size, g.facingRight, 'rgba(110,210,255,0.85)')
      ctx.restore()
    })

    // 5. Render Character Sprite
    this.renderCharacter(ctx)

    // 5c. Impact bursts, dust and debris over the knight.
    this.effects.renderFront(ctx)

    // 6. Render Particles
    for (const p of this.particles) {
      ctx.fillStyle = p.color
      ctx.fillRect(p.x, p.y, p.size, p.size)
    }

    // 7. Render Floating Damage Numbers
    for (const dt of this.damageTexts) {
      ctx.save()
      ctx.globalAlpha = dt.alpha
      ctx.fillStyle = dt.color
      ctx.font = 'bold 14px monospace'
      ctx.textBaseline = 'alphabetic'
      ctx.fillText(dt.text, dt.x - 16, dt.y)
      ctx.restore()
    }

    ctx.restore()

    // Screen-space flash on big hits, in logical coordinates over the whole view.
    this.effects.renderFlash(ctx, GameWorld.LOGICAL_WIDTH, GameWorld.LOGICAL_HEIGHT)
  }
}
