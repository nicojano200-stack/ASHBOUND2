import type { AnimationConfig } from './AnimationConfig'
import { createDefaultConfigs } from './AnimationConfig'
import { PlayerAction, PLAYER_ACTIONS } from './PlayerAction'
import { type ImageFactory, SpriteSheet, defaultImageFactory, loadSpriteSheet } from './SpriteSheet'
import { footOffsetForRow } from './spriteMetrics'

/**
 * Reusable 2D Sprite Animation System.
 * Mirrors SpriteAnimationSystem.kt.
 *
 * Responsibilities:
 * - Manages sprite sheets for all player actions.
 * - Manages playback time and computes current frame index.
 * - Prevents restarting animations on every game frame.
 * - Handles priority and state transitions.
 * - Renders frames with nearest-neighbor filtering and horizontal flipping.
 */
export class SpriteAnimationSystem {
  private readonly sheets = new Map<PlayerAction, SpriteSheet>()
  private readonly activeConfigs: Map<PlayerAction, AnimationConfig>
  private readonly basePath: string
  private readonly factory: ImageFactory

  currentAction: PlayerAction = PlayerAction.IDLE
  currentFrameIndex = 0
  elapsedTimeSeconds = 0
  isFinished = false

  constructor(
    basePath: string,
    configs: Map<PlayerAction, AnimationConfig> = createDefaultConfigs(),
    factory: ImageFactory = defaultImageFactory,
  ) {
    this.basePath = basePath
    this.activeConfigs = new Map(configs)
    this.factory = factory
  }

  /**
   * The sheets that actually loaded, keyed by action. Actions whose art is
   * missing simply have no entry, which is how callers tell a real sheet from a
   * configured-but-absent one.
   */
  get loadedSheets(): ReadonlyMap<PlayerAction, SpriteSheet> {
    return this.sheets
  }

  /**
   * Loads or reloads all sprite sheets according to activeConfigs.
   * Must be awaited before the first update() call.
   */
  async reloadAll(): Promise<void> {
    this.sheets.clear()
    const loaded = await Promise.all(
      [...this.activeConfigs.values()].map((config) => loadSpriteSheet(this.basePath, this.factory, config)),
    )
    loaded.forEach((sheet) => {
      if (sheet) this.sheets.set(sheet.action, sheet)
    })
    console.info(
      `[SpriteAnimationSystem] loaded ${this.sheets.size}/${this.activeConfigs.size} sheets ` +
        `(${[...this.sheets.values()].map((s) => `${s.action}:${s.frameCount}f`).join(', ')})`,
    )
  }

  getConfig(action: PlayerAction): AnimationConfig | undefined {
    return this.activeConfigs.get(action)
  }

  /**
   * Updates an animation's configuration at runtime (e.g. FPS or frame count)
   * and reloads its sheet. The cached image is reused when only the frame
   * count or fps changed, so tweaking a slider does not re-download the PNG.
   */
  async updateConfig(config: AnimationConfig): Promise<void> {
    this.activeConfigs.set(config.action, config)
    const existing = this.sheets.get(config.action)
    if (existing && existing.config.sourceFileName === config.sourceFileName) {
      this.sheets.set(config.action, new SpriteSheet(config.action, existing.image, config))
      return
    }
    const sheet = await loadSpriteSheet(this.basePath, this.factory, config)
    if (sheet) this.sheets.set(config.action, sheet)
  }


  getSheet(action: PlayerAction): SpriteSheet | undefined {
    return this.sheets.get(action)
  }

  getAllActions(): PlayerAction[] {
    return PLAYER_ACTIONS
  }

  /**
   * Distance the current frame's draw-rect bottom must sit below the ground plane for
   * that frame's *visible* feet to land on it. Resolved per frame because the walk
   * cycle's contact row moves; a single constant leaves those frames off the floor.
   */
  footOffsetForCurrentFrame(displaySize: number): number {
    const sheet = this.sheets.get(this.currentAction) ?? this.sheets.get(PlayerAction.IDLE)
    if (!sheet) return 0
    return footOffsetForRow(
      sheet.footRowForFrame(this.currentFrameIndex),
      displaySize * sheet.displayScale,
      sheet.cellHeight,
    )
  }

  /**
   * On-screen size of the current sheet, in logical pixels.
   *
   * Sheets packed at a different native resolution (the attack sheet is a grid of
   * 256px cells, not a strip of 128px ones) carry a displayScale so their character
   * still occupies the same on-screen box as every other action.
   */
  displaySizeForCurrentSheet(baseDisplaySize: number): number {
    const sheet = this.sheets.get(this.currentAction) ?? this.sheets.get(PlayerAction.IDLE)
    return baseDisplaySize * (sheet?.displayScale ?? 1)
  }

  /**
   * Requests an action transition.
   *
   * Rule: does NOT restart the animation if the action is already active,
   * unless explicitly forced by restartIfSame.
   */
  playAction(newAction: PlayerAction, restartIfSame = false, force = false): boolean {
    if (this.currentAction === newAction && !restartIfSame) {
      return false // Already playing, do not restart every frame!
    }

    // Respect priority: a running action is not interrupted by a lower priority one.
    // Base locomotion states (IDLE and WALK) can freely transition.
    const isLocomotion =
      (this.currentAction === PlayerAction.IDLE || this.currentAction === PlayerAction.WALK) &&
      (newAction === PlayerAction.IDLE || newAction === PlayerAction.WALK)

    const currentConfig = this.activeConfigs.get(this.currentAction)
    const newConfig = this.activeConfigs.get(newAction)

    if (!force && !this.isFinished && !isLocomotion && currentConfig && newConfig) {
      if (newConfig.priority < currentConfig.priority) {
        return false
      }
    }

    this.currentAction = newAction
    this.elapsedTimeSeconds = 0
    this.currentFrameIndex = 0
    this.isFinished = false
    return true
  }

  /** Progresses animation time. Call once per game tick. */
  update(deltaTimeSeconds: number): void {
    const sheet = this.sheets.get(this.currentAction)
    if (!sheet) return
    const config = this.activeConfigs.get(this.currentAction) ?? sheet.config

    this.elapsedTimeSeconds += deltaTimeSeconds
    const totalFrames = sheet.frameCount
    const fps = Math.max(1, config.fps)
    const rawFrame = Math.trunc(this.elapsedTimeSeconds * fps)

    if (config.loop) {
      this.currentFrameIndex = totalFrames > 0 ? rawFrame % totalFrames : 0
      this.isFinished = false
    } else if (rawFrame >= totalFrames - 1) {
      this.currentFrameIndex = Math.max(0, totalFrames - 1)
      this.isFinished = true
    } else {
      this.currentFrameIndex = rawFrame
      this.isFinished = false
    }
  }

  /**
   * Draws the current sprite frame. The caller is expected to have already
   * translated into logical game coordinates.
   */
  render(
    ctx: CanvasRenderingContext2D,
    centerX: number,
    bottomY: number,
    displayWidth: number,
    displayHeight: number,
    isFacingRight: boolean,
  ): void {
    const sheet = this.sheets.get(this.currentAction) ?? this.sheets.get(PlayerAction.IDLE)
    if (!sheet) return
    const { sx, sy, sw, sh } = sheet.frameRect(this.currentFrameIndex)

    ctx.save()
    // Flip horizontally around the character's horizontal center if facing left.
    if (!isFacingRight) {
      ctx.translate(centerX, bottomY)
      ctx.scale(-1, 1)
      ctx.translate(-centerX, -bottomY)
    }

    const left = centerX - displayWidth / 2
    const top = bottomY - displayHeight
    ctx.drawImage(sheet.image, sx, sy, sw, sh, left, top, displayWidth, displayHeight)
    ctx.restore()
  }

  private tintCanvas: HTMLCanvasElement | null = null

  /**
   * Draws an arbitrary frame of an action (not just the current one), optionally
   * flat-tinted. Used for dash afterimages, which must show the pose the knight
   * actually had a moment ago. A no-op where no DOM canvas exists (unit tests).
   */
  renderFrame(
    ctx: CanvasRenderingContext2D,
    action: PlayerAction,
    frameIndex: number,
    centerX: number,
    bottomY: number,
    size: number,
    isFacingRight: boolean,
    tint: string | null = null,
  ): void {
    // Same fallback as render(): an action with no art of its own shows the idle pose.
    const sheet = this.sheets.get(action) ?? this.sheets.get(PlayerAction.IDLE)
    if (!sheet) return
    const { sx, sy, sw, sh } = sheet.frameRect(frameIndex)

    let source: CanvasImageSource = sheet.image
    let ssx = sx
    let ssy = sy
    if (tint) {
      if (typeof document === 'undefined') return
      const c = (this.tintCanvas ??= document.createElement('canvas'))
      if (c.width !== sw || c.height !== sh) {
        c.width = sw
        c.height = sh
      }
      const t = c.getContext('2d')
      if (!t) return
      t.clearRect(0, 0, sw, sh)
      t.globalCompositeOperation = 'source-over'
      t.drawImage(sheet.image, sx, sy, sw, sh, 0, 0, sw, sh)
      t.globalCompositeOperation = 'source-atop'
      t.fillStyle = tint
      t.fillRect(0, 0, sw, sh)
      source = c
      ssx = 0
      ssy = 0
    }

    ctx.save()
    if (!isFacingRight) {
      ctx.translate(centerX, bottomY)
      ctx.scale(-1, 1)
      ctx.translate(-centerX, -bottomY)
    }
    ctx.drawImage(source, ssx, ssy, sw, sh, centerX - size / 2, bottomY - size, size, size)
    ctx.restore()
  }
}
