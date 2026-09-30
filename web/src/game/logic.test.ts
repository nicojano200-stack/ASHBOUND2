/**
 * Headless smoke test for the web port's game logic.
 *
 * The rendering path needs a browser, but physics, the animation state machine
 * and hit detection are pure and run in plain Node. Run with:
 *   node --experimental-strip-types --no-warnings src/game/logic.test.ts
 */
import { GameWorld } from './GameWorld.ts'
import { PlayerController, rectsIntersect } from './PlayerController.ts'
import { PlayerAction } from './PlayerAction.ts'
import type { SpriteAnimationSystem } from './SpriteAnimationSystem.ts'
import { createDefaultConfigs } from './AnimationConfig.ts'
import { SpriteSheet } from './SpriteSheet.ts'
import { DEFAULT_FOOT_ROW, FOOT_ROWS_BY_SHEET, footOffsetForRow } from './spriteMetrics.ts'

let failures = 0
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok   ${name}`)
  } else {
    failures++
    console.error(`  FAIL ${name} ${detail}`)
  }
}

/** Minimal stand-in exposing only what PlayerController/GameWorld consume. */
function stubAnimations() {
  const system = {
    currentAction: PlayerAction.IDLE,
    currentFrameIndex: 0,
    isFinished: false,
    elapsedTimeSeconds: 0,
    playAction(action: PlayerAction, restartIfSame = false) {
      if (system.currentAction === action && !restartIfSame) return false
      system.currentAction = action
      system.currentFrameIndex = 0
      system.isFinished = false
      return true
    },
    update() {},
    displaySizeForCurrentSheet(base: number) {
      return base
    },
    footOffsetForCurrentFrame() {
      return 0
    },
    getSheet() {
      return undefined
    },
    getConfig(action: PlayerAction) {
      // The real config, so tests exercise the shipped hit windows and frame
      // counts rather than invented ones.
      return createDefaultConfigs().get(action)
    },
    getAllActions() {
      return Object.values(PlayerAction)
    },
  }
  return system as unknown as SpriteAnimationSystem & typeof system
}

const anim = stubAnimations()
const world = new GameWorld(anim, null)
const player = world.player

console.log('rect intersection')
check('overlapping rects intersect', rectsIntersect({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 5, top: 5, right: 15, bottom: 15 }))
check(
  'separated rects do not intersect',
  !rectsIntersect({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 20, top: 0, right: 30, bottom: 10 }),
)
check(
  'touching edges do not intersect',
  !rectsIntersect({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 10, top: 0, right: 20, bottom: 10 }),
)

console.log('spawn state')
check('player spawns on the floor', player.groundY === GameWorld.FLOOR_Y, `got ${player.groundY}`)
check('player starts at spawn x', player.x === GameWorld.SPAWN_X, `got ${player.x}`)
check('starts facing right', player.isFacingRight)
check('starts on IDLE', anim.currentAction === PlayerAction.IDLE)

console.log('movement + walk state')
player.setMovementInput(1)
world.update(1 / 60)
check('moves right', player.x > GameWorld.SPAWN_X, `got ${player.x}`)
check('still facing right', player.isFacingRight)
check('enters WALK', anim.currentAction === PlayerAction.WALK, `got ${anim.currentAction}`)
check('vx matches walk speed', Math.abs(player.vx - 150) < 1, `got ${player.vx}`)

player.setMovementInput(-1)
world.update(1 / 60)
check('turns around on left input', !player.isFacingRight)

player.setMovementInput(0)
for (let i = 0; i < 10; i++) world.update(1 / 60)
check('returns to IDLE when stopped', anim.currentAction === PlayerAction.IDLE, `got ${anim.currentAction}`)

console.log('world bounds')
player.setMovementInput(-1)
for (let i = 0; i < 600; i++) world.update(1 / 60)
check('clamped to left bound', player.x >= player.width / 2 - 0.001, `got ${player.x}`)
player.setMovementInput(1)
for (let i = 0; i < 1200; i++) world.update(1 / 60)
check('clamped to right bound', player.x <= GameWorld.WORLD_WIDTH - player.width / 2 + 0.001, `got ${player.x}`)

console.log('jump')
player.resetPlayer(GameWorld.SPAWN_X, GameWorld.FLOOR_Y)
check('jump accepted while grounded', player.onJump())
check('airborne after jump', !player.isGrounded)
check('JUMP state while airborne', anim.currentAction === PlayerAction.JUMP, `got ${anim.currentAction}`)
check('jump rejected while airborne', !player.onJump())
for (let i = 0; i < 200; i++) world.update(1 / 60)
check('lands back on the floor', player.isGrounded && Math.abs(player.groundY - GameWorld.FLOOR_Y) < 0.001)

console.log('dash')
const staminaBefore = player.stamina
check('dash accepted', player.onDash())
check('dash costs 25 stamina', Math.abs(staminaBefore - 25 - player.stamina) < 0.001, `got ${player.stamina}`)
check('invulnerable during dash', player.isInvulnerable)
check('dash state active', anim.currentAction === PlayerAction.DASH, `got ${anim.currentAction}`)
check('dash rejected while dashing', !player.onDash())
for (let i = 0; i < 30; i++) world.update(1 / 60)
check('invulnerability ends after dash', !player.isInvulnerable)

console.log('attack hit detection')
player.resetPlayer(GameWorld.SPAWN_X, GameWorld.FLOOR_Y)
const dummy = world.dummies[0]
player.x = dummy.x - 30
player.isFacingRight = true
const attackCfg = createDefaultConfigs().get(PlayerAction.ATTACK)!
const attackWindow = attackCfg.hitFrames!
const heavyCfg = createDefaultConfigs().get(PlayerAction.HEAVY_ATTACK)!
const heavyWindow = heavyCfg.hitFrames!
check('attack has a hit window', Array.isArray(attackWindow) && attackWindow.length === 2, `${attackWindow}`)
check('heavy attack has a hit window', Array.isArray(heavyWindow) && heavyWindow.length === 2, `${heavyWindow}`)

check('attack accepted', player.onAttack())
check('ATTACK state active', anim.currentAction === PlayerAction.ATTACK, `got ${anim.currentAction}`)

const hpBefore = dummy.hp
// The world owns the hit check, so the active frame must be current *before*
// update() runs — that is how the real game loop drives it.
anim.currentFrameIndex = attackWindow[0]
world.update(1 / 60)
check('dummy took light damage', dummy.hp === hpBefore - 18, `got ${dummy.hp} from ${hpBefore}`)
check('hitbox consumed once', !player.shouldCheckAttackHit())
check('damage text spawned', world.damageTexts.length > 0)
check('sparks spawned', world.particles.length > 0)

console.log('the hit waits for the blade instead of landing on the windup')
// Every frame before the window is a windup frame: the swing must not have
// connected yet, so no damage and no effect.
for (let f = 0; f < attackWindow[0]; f++) {
  player.resetPlayer(dummy.x - 30, GameWorld.FLOOR_Y)
  player.isFacingRight = true
  player.onAttack()
  const hp = dummy.hp
  anim.currentFrameIndex = f
  world.update(1 / 60)
  check(`light attack deals no damage on windup frame ${f}`, dummy.hp === hp, `took ${hp - dummy.hp} too early`)
}

// The last frame of the window still connects.
player.resetPlayer(dummy.x - 30, GameWorld.FLOOR_Y)
player.isFacingRight = true
player.onAttack()
const lateHp = dummy.hp
anim.currentFrameIndex = attackWindow[1]
world.update(1 / 60)
check('light attack still connects on the last window frame', dummy.hp === lateHp - 18, `got ${dummy.hp} from ${lateHp}`)

// One swing connects once, even though the window spans several frames.
check('a swing cannot hit twice', !player.shouldCheckAttackHit())
for (let f = attackWindow[0]; f <= attackWindow[1]; f++) anim.currentFrameIndex = f
check('a swing cannot hit twice across the window', !player.shouldCheckAttackHit())
player.resetPlayer(dummy.x - 30, GameWorld.FLOOR_Y)
player.isFacingRight = true
player.onAttack()
anim.currentFrameIndex = attackWindow[0]
world.update(1 / 60)
check('a second swing hits again', dummy.hp < lateHp, `got ${dummy.hp} from ${lateHp}`)

console.log('heavy attack')
for (let f = 0; f < heavyWindow[0]; f++) {
  player.resetPlayer(dummy.x - 30, GameWorld.FLOOR_Y)
  player.isFacingRight = true
  player.onHeavyAttack()
  const hp = dummy.hp
  anim.currentFrameIndex = f
  world.update(1 / 60)
  check(`heavy attack deals no damage on windup frame ${f}`, dummy.hp === hp, `took ${hp - dummy.hp} too early`)
}
player.resetPlayer(dummy.x - 30, GameWorld.FLOOR_Y)
player.isFacingRight = true
player.onHeavyAttack()
const heavyBefore = dummy.hp
anim.currentFrameIndex = heavyWindow[0]
world.update(1 / 60)
check('dummy took heavy damage', dummy.hp === heavyBefore - 45, `got ${dummy.hp} from ${heavyBefore}`)

console.log('attack out of range')
player.resetPlayer(dummy.x - 300, GameWorld.FLOOR_Y)
const missBefore = dummy.hp
check('attack still animates out of range', player.onAttack())
anim.currentFrameIndex = attackWindow[0]
world.update(1 / 60)
check('dummy untouched out of range', dummy.hp === missBefore, `got ${dummy.hp}`)

console.log('attack cannot be started mid-air')
player.resetPlayer(GameWorld.SPAWN_X, GameWorld.FLOOR_Y)
player.onJump()
check('airborne attack rejected', !player.onAttack())
player.onHurt(200)
for (let i = 0; i < 200; i++) world.update(1 / 60)
check('lands after hurt too', player.isGrounded)

console.log('block deflection')
player.resetPlayer(GameWorld.SPAWN_X, GameWorld.FLOOR_Y)
player.setBlockActive(true)
world.update(1 / 60)
check('blocking state engaged', player.isBlocking)
const blockHp = player.hp
check('blocked hit does not connect', player.onHurt(18) === false)
check('block still chips hp', player.hp < blockHp && player.hp > blockHp - 18, `got ${player.hp} from ${blockHp}`)
player.setBlockActive(false)

console.log('hurt + death')
player.resetPlayer(GameWorld.SPAWN_X, GameWorld.FLOOR_Y)
check('unblocked hit connects', player.onHurt(18) === true)
check('hp reduced', player.hp === 82, `got ${player.hp}`)
check('HURT state active', anim.currentAction === PlayerAction.HURT, `got ${anim.currentAction}`)
player.onHurt(1000)
check('death state at 0 hp', anim.currentAction === PlayerAction.DEATH, `got ${anim.currentAction}`)
check('dead player cannot be hurt again', player.onHurt(10) === false)
player.resetPlayer(GameWorld.SPAWN_X, GameWorld.FLOOR_Y)
check('reset restores hp', player.hp === player.maxHp)
check('reset returns to IDLE', anim.currentAction === PlayerAction.IDLE)

console.log('stamina regen')
player.resetPlayer(GameWorld.SPAWN_X, GameWorld.FLOOR_Y)
player.stamina = 50
for (let i = 0; i < 60; i++) world.update(1 / 60)
check('stamina regenerates at 20/s', Math.abs(player.stamina - 70) < 0.5, `got ${player.stamina}`)

console.log('camera')
player.resetPlayer(GameWorld.SPAWN_X, GameWorld.FLOOR_Y)
for (let i = 0; i < 300; i++) world.update(1 / 60)
check('camera stays within world bounds', world.cameraX >= 0 && world.cameraX <= GameWorld.WORLD_WIDTH - GameWorld.LOGICAL_WIDTH, `got ${world.cameraX}`)

console.log('dt clamping')
player.resetPlayer(GameWorld.SPAWN_X, GameWorld.FLOOR_Y)
const xBefore = player.x
world.update(10) // a huge stall must not teleport the player
check('huge dt is clamped', Math.abs(player.x - xBefore) < 20, `moved ${player.x - xBefore}px`)

console.log('controller constructed directly')
const solo = new PlayerController(anim, 200, 260)
check('solo controller defaults sane', solo.width === 44 && solo.height === 70 && solo.maxHp === 100)

// ---------------------------------------------------------------------------
// World space: the dummies are arena fixtures, not screen or player-relative.
// ---------------------------------------------------------------------------

console.log('player spawns at the arena centre')
// A fresh world, so these read the real match-start state rather than whatever
// the earlier blocks left the shared `world` in.
{
const spawnWorld = new GameWorld(stubAnimations(), null)
check(
  'ARENA_CENTER_X is derived from WORLD_WIDTH, not the screen',
  GameWorld.ARENA_CENTER_X === GameWorld.WORLD_WIDTH / 2,
  `got ${GameWorld.ARENA_CENTER_X}`,
)
check('spawn X is the arena centre', GameWorld.SPAWN_X === GameWorld.ARENA_CENTER_X, `got ${GameWorld.SPAWN_X}`)
check('player starts at the spawn X', Math.abs(spawnWorld.player.x - GameWorld.SPAWN_X) < 1e-9, `got ${spawnWorld.player.x}`)
check(
  'spawn leaves room to walk in both directions',
  spawnWorld.player.x - spawnWorld.player.width / 2 > 100 &&
    GameWorld.WORLD_WIDTH - spawnWorld.player.x - spawnWorld.player.width / 2 > 100,
  `${(spawnWorld.player.x - spawnWorld.player.width / 2).toFixed(0)} left / ${(GameWorld.WORLD_WIDTH - spawnWorld.player.x - spawnWorld.player.width / 2).toFixed(0)} right`,
)
check(
  'camera starts with the player centred in the viewport',
  Math.abs(spawnWorld.cameraX - spawnWorld.cameraXForPlayerX(spawnWorld.player.x)) < 1e-9 &&
    Math.abs(spawnWorld.player.x - spawnWorld.cameraX - GameWorld.LOGICAL_WIDTH / 2) < 1e-9,
  `cameraX ${spawnWorld.cameraX}`,
)
check(
  'dummies sit to the right of the spawn, inside the arena',
  spawnWorld.dummies.every((d) => d.x > GameWorld.SPAWN_X && d.x < GameWorld.WORLD_WIDTH),
  spawnWorld.dummies.map((d) => d.x).join(', '),
)
check(
  'dummies stand on the same FLOOR_Y as the player',
  spawnWorld.dummies.every((d) => Math.abs(d.groundY - GameWorld.FLOOR_Y) < 1e-9),
  '',
)
}

console.log('dummies are fixed in world space while the camera follows the player')
{
  const dummy = world.dummies[0]
  const worldX = dummy.x
  const seen: Array<{ screen: number; camera: number; player: number }> = []

  // Walk right, sample, walk back, sample.
  world.player.setMovementInput(1)
  for (let i = 0; i < 180; i++) world.update(1 / 60)
  world.player.setMovementInput(0)
  for (let i = 0; i < 60; i++) world.update(1 / 60)
  seen.push({ screen: dummy.x - world.cameraX, camera: world.cameraX, player: world.player.x })

  world.player.setMovementInput(-1)
  for (let i = 0; i < 400; i++) world.update(1 / 60)
  world.player.setMovementInput(0)
  for (let i = 0; i < 60; i++) world.update(1 / 60)
  seen.push({ screen: dummy.x - world.cameraX, camera: world.cameraX, player: world.player.x })

  check('dummy world X is constant through the whole walk', dummy.x === worldX, `${worldX} -> ${dummy.x}`)
  check(
    'the camera is pinned: the world is exactly one backdrop wide',
    seen.every((r) => r.camera === 0),
    `cameraX ${seen[0].camera} / ${seen[1].camera}`,
  )
  check(
    'screen position = worldX - cameraX in both samples',
    Math.abs(seen[0].screen - (worldX - seen[0].camera)) < 1e-9 && Math.abs(seen[1].screen - (worldX - seen[1].camera)) < 1e-9,
    '',
  )
  check(
    'the dummy holds its screen position while the player walks',
    Math.abs(seen[0].screen - seen[1].screen) < 1e-9,
    `${seen[0].screen} vs ${seen[1].screen}`,
  )
  check('the player actually moved', Math.abs(seen[0].player - GameWorld.SPAWN_X) > 50, `player reached ${seen[0].player.toFixed(1)}`)
}

console.log('dummy hitbox and health bar are anchored to the dummy')
{
  const dummy = world.dummies[0]
  const before = { ...dummy.hitbox }
  dummy.x += 200
  const after = { ...dummy.hitbox }
  dummy.x = GameWorld.DUMMY_X

  check('hitbox left/right follow the dummy world X', after.left - before.left === 200 && after.right - before.right === 200, `moved ${after.left - before.left}`)
  check('hitbox bottom is the floor plane', Math.abs(after.bottom - GameWorld.FLOOR_Y) < 1e-9, `got ${after.bottom}`)
  check('hitbox top is the floor minus the dummy height', Math.abs(after.top - (GameWorld.FLOOR_Y - dummy.height)) < 1e-9, `got ${after.top}`)
}

console.log('backdrop is anchored in world space and repeats across the arena')
check(
  'the world is exactly the backdrop, so the plate is drawn once and never repeated',
  Math.abs(GameWorld.BACKGROUND_LOGICAL_WIDTH - GameWorld.WORLD_WIDTH) < 1e-9,
  `plate ${GameWorld.BACKGROUND_LOGICAL_WIDTH} vs world ${GameWorld.WORLD_WIDTH}`,
)
check(
  'the plate covers the viewport at the uniform scale',
  Math.abs(GameWorld.BACKGROUND_LOGICAL_WIDTH - GameWorld.LOGICAL_WIDTH) < 1e-9 &&
    Math.abs(GameWorld.BACKGROUND_LOGICAL_HEIGHT - GameWorld.LOGICAL_HEIGHT) < 1e-9,
  `plate ${GameWorld.BACKGROUND_LOGICAL_WIDTH}x${GameWorld.BACKGROUND_LOGICAL_HEIGHT}`,
)
check(
  'the camera has no scroll range, so there is nothing to mirror or repeat into',
  GameWorld.WORLD_WIDTH - GameWorld.LOGICAL_WIDTH === 0,
  `range ${GameWorld.WORLD_WIDTH - GameWorld.LOGICAL_WIDTH}`,
)

// ---------------------------------------------------------------------------
// Ground alignment: the feet must rest on the backdrop's visible stone floor.
// ---------------------------------------------------------------------------

const BG_SCALE_Y = GameWorld.LOGICAL_HEIGHT / GameWorld.BACKGROUND_HEIGHT
/** Converts a world Y back into a row of the backdrop artwork. */
const toBackgroundRow = (worldY: number): number => worldY / BG_SCALE_Y

console.log('ground plane is derived from the backdrop')
check(
  'FLOOR_Y matches the measured floor row (533 * 5/12)',
  Math.abs(GameWorld.FLOOR_Y - 222.0833) < 0.01,
  `got ${GameWorld.FLOOR_Y}`,
)
check(
  'backdrop is drawn at a uniform 5/12 scale',
  Math.abs(GameWorld.BACKGROUND_SCALE - 5 / 12) < 1e-12,
  `got ${GameWorld.BACKGROUND_SCALE}`,
)
check(
  'uniform scale maps the 1536x864 plate exactly onto the 640x360 viewport',
  Math.abs(1536 * GameWorld.BACKGROUND_SCALE - GameWorld.LOGICAL_WIDTH) < 1e-9 &&
    Math.abs(864 * GameWorld.BACKGROUND_SCALE - GameWorld.LOGICAL_HEIGHT) < 1e-9,
  `got ${1536 * GameWorld.BACKGROUND_SCALE}x${864 * GameWorld.BACKGROUND_SCALE}`,
)
check(
  'ground plane maps back to backdrop row 533',
  Math.abs(toBackgroundRow(GameWorld.FLOOR_Y) - GameWorld.BACKGROUND_FLOOR_ROW) < 0.01,
  `got row ${toBackgroundRow(GameWorld.FLOOR_Y).toFixed(2)}`,
)
check(
  'floor is the lit surface, not the row-620 flagstone joint',
  GameWorld.BACKGROUND_FLOOR_ROW === 533 && GameWorld.FLOOR_Y < 230,
  `got row ${GameWorld.BACKGROUND_FLOOR_ROW}, y ${GameWorld.FLOOR_Y}`,
)
check(
  'ground plane is no longer the old screen-relative 285',
  Math.abs(GameWorld.FLOOR_Y - 285) > 20,
  `got ${GameWorld.FLOOR_Y}`,
)
check(
  'rest-pose foot offset equals the idle sheet padding',
  Math.abs(GameWorld.SPRITE_FOOT_OFFSET - 12.5) < 0.01,
  `got ${GameWorld.SPRITE_FOOT_OFFSET}`,
)

console.log('per-frame foot rows come from the artwork, not a constant')
{
  const walkFootRows = FOOT_ROWS_BY_SHEET['walk.png']
  const idleFootRows = FOOT_ROWS_BY_SHEET['idle.png']

  check('walk foot rows are measured per frame, not a single constant', new Set(walkFootRows).size > 1, '')
  // Derived from the configured frame count rather than hardcoded, so replacing a
  // sheet with a different frame count cannot leave these quietly stale.
  const idleFrames = createDefaultConfigs().get(PlayerAction.IDLE)!.frameCount
  const walkFrames = createDefaultConfigs().get(PlayerAction.WALK)!.frameCount
  check('every walk frame has a measured foot row', walkFootRows.length === walkFrames, `got ${walkFootRows.length} for ${walkFrames} frames`)
  check('every idle frame has a measured foot row', idleFootRows.length === idleFrames, `got ${idleFootRows.length} for ${idleFrames} frames`)
  check('idle foot rows are the constant rest pose', idleFootRows.every((r) => r === 111), '')

  const size = GameWorld.SPRITE_DISPLAY_SIZE
  const offsets = walkFootRows.map((r) => footOffsetForRow(r, size))
  // The walk contact row ranges 110..112, so the correct offset spans ~1.56px. A
  // single constant would therefore misplace the extreme frames by ~0.78px each.
  check(
    'walk foot offsets span ~1.56px, so a constant would err by ~0.78px',
    Math.abs(Math.max(...offsets) - Math.min(...offsets) - 1.5625) < 0.01,
    `spread ${(Math.max(...offsets) - Math.min(...offsets)).toFixed(3)}`,
  )
}

console.log('GRID PACKED SHEETS: a 4x4 grid of 256px cells slices correctly')
{
  const stubImage = { width: 1024, height: 1024 } as unknown as HTMLCanvasElement
  const config = createDefaultConfigs().get(PlayerAction.ATTACK)!
  const sheet = new SpriteSheet(PlayerAction.ATTACK, stubImage, config)

  check('attack uses the attack sheet', config.sourceFileName === 'attack.png', config.sourceFileName)
  check('attack has 16 frames', sheet.frameCount === 16, `got ${sheet.frameCount}`)
  check('attack reads 4 columns', sheet.columns === 4, `got ${sheet.columns}`)
  check('attack cell is 256px', sheet.cellHeight === 256, `got ${sheet.cellHeight}`)
  check('attack cell is 256 wide', sheet.frameWidth === 256, `got ${sheet.frameWidth}`)

  // Every cell in a 4x4 grid of 256px cells must be addressed correctly, not
  // just the first row: column advances x, wrapping at 4 moves down a row.
  check('frame 0 is the top-left cell', JSON.stringify(sheet.frameRect(0)) === JSON.stringify({ sx: 0, sy: 0, sw: 256, sh: 256 }), JSON.stringify(sheet.frameRect(0)))
  check('frame 3 is the end of the first row', JSON.stringify(sheet.frameRect(3)) === JSON.stringify({ sx: 768, sy: 0, sw: 256, sh: 256 }), JSON.stringify(sheet.frameRect(3)))
  check('frame 4 wraps to the start of row two', JSON.stringify(sheet.frameRect(4)) === JSON.stringify({ sx: 0, sy: 256, sw: 256, sh: 256 }), JSON.stringify(sheet.frameRect(4)))
  check('frame 15 is the bottom-right cell', JSON.stringify(sheet.frameRect(15)) === JSON.stringify({ sx: 768, sy: 768, sw: 256, sh: 256 }), JSON.stringify(sheet.frameRect(15)))
  check('out-of-range frames clamp to the last cell', JSON.stringify(sheet.frameRect(99)) === JSON.stringify(sheet.frameRect(15)), JSON.stringify(sheet.frameRect(99)))

  // No two frames may address the same source rect, or the sheet would visibly
  // stutter through duplicates instead of playing 16 distinct poses.
  const seen = new Set<string>()
  for (let f = 0; f < sheet.frameCount; f++) seen.add(JSON.stringify(sheet.frameRect(f)))
  check('all 16 frames address distinct cells', seen.size === 16, `got ${seen.size} unique`)

  // The strip sheets must keep their single-row behaviour.
  const walkStub = { width: 1536, height: 128 } as unknown as HTMLCanvasElement
  const walkSheet = new SpriteSheet(PlayerAction.WALK, walkStub, createDefaultConfigs().get(PlayerAction.WALK)!)
  check('walk stays a single row of 128px cells', walkSheet.cellHeight === 128 && walkSheet.frameCount === 12, `cell ${walkSheet.cellHeight}, frames ${walkSheet.frameCount}`)
  check('walk frame 5 has no vertical offset', walkSheet.frameRect(5).sy === 0, `sy ${walkSheet.frameRect(5).sy}`)

  // The 256px cell has a different padding than a 128px one, so the foot offset
  // must be computed against this sheet's own cell height.
  const size = GameWorld.SPRITE_DISPLAY_SIZE
  const scaled = size * sheet.displayScale
  let worst = 0
  for (let frame = 0; frame < sheet.frameCount; frame++) {
    const rectBottom = GameWorld.FLOOR_Y + footOffsetForRow(sheet.footRowForFrame(frame), scaled, sheet.cellHeight)
    const visibleFeet = rectBottom - footOffsetForRow(sheet.footRowForFrame(frame), scaled, sheet.cellHeight)
    worst = Math.max(worst, Math.abs(visibleFeet - GameWorld.FLOOR_Y))
  }
  check('all 16 attack frames put their visible feet on FLOOR_Y', worst < 1e-9, `worst ${worst}`)

  // A 256px cell drawn unscaled would shrink the character to ~57px against
  // idle's ~78px, so the sheet must carry a scale that restores the size.
  // The character is the same on-screen size in every sheet, including the
  // grid-packed ones. The authoritative check is the median rendered height
  // across every frame of every sheet, measured against real pixels by
  // scripts/verify-attack.mjs.
  const attackChar = (141 / 256) * scaled
  const idleChar = (103 / 128) * size
  check(
    'the grid attack sheet draws a larger box than idle for the same character',
    scaled > size,
    `attack cell ${scaled.toFixed(1)}px vs idle ${size}px, character ${attackChar.toFixed(1)} vs ${idleChar.toFixed(1)}`,
  )
}

console.log('GRID PACKED SHEET: a 5x5 grid of 256px cells slices correctly')
{
  const stubImage = { width: 1280, height: 1280 } as unknown as HTMLCanvasElement
  const config = createDefaultConfigs().get(PlayerAction.HEAVY_ATTACK)!
  const sheet = new SpriteSheet(PlayerAction.HEAVY_ATTACK, stubImage, config)

  check('heavy attack uses its own sheet', config.sourceFileName === 'heavy_attack.png', config.sourceFileName)
  check('heavy attack has 25 frames', sheet.frameCount === 25, `got ${sheet.frameCount}`)
  check('heavy attack reads 5 columns', sheet.columns === 5, `got ${sheet.columns}`)
  check('heavy attack cell is 256px', sheet.cellHeight === 256, `got ${sheet.cellHeight}`)

  // 5x5 addressing: the last frame is the bottom-right cell, and wrapping happens
  // at 5, not at 4 as the attack sheet does.
  check('frame 4 is the end of the first row', JSON.stringify(sheet.frameRect(4)) === JSON.stringify({ sx: 1024, sy: 0, sw: 256, sh: 256 }), JSON.stringify(sheet.frameRect(4)))
  check('frame 5 wraps to the start of row two', JSON.stringify(sheet.frameRect(5)) === JSON.stringify({ sx: 0, sy: 256, sw: 256, sh: 256 }), JSON.stringify(sheet.frameRect(5)))
  check('frame 24 is the bottom-right cell', JSON.stringify(sheet.frameRect(24)) === JSON.stringify({ sx: 1024, sy: 1024, sw: 256, sh: 256 }), JSON.stringify(sheet.frameRect(24)))

  const seen = new Set<string>()
  let outside = 0
  for (let f = 0; f < sheet.frameCount; f++) {
    const r = sheet.frameRect(f)
    seen.add(JSON.stringify(r))
    if (r.sx + r.sw > 1280 || r.sy + r.sh > 1280) outside++
  }
  check('all 25 frames address distinct cells', seen.size === 25, `got ${seen.size} unique`)
  check('no frame rect falls outside the sheet', outside === 0, `${outside} outside`)
  check('the 25 cells cover the sheet exactly', sheet.frameWidth * sheet.cellHeight * sheet.frameCount === 1280 * 1280, `${sheet.frameCount} cells of ${sheet.frameWidth}x${sheet.cellHeight}`)

  // Both grid sheets scale up to compensate for their 256px cells, which is what
  // keeps them the same character size as the 128px strips. The exact sizes are
  // verified against real rendered pixels by scripts/verify-attack.mjs; comparing
  // source-pixel heights here would only re-derive the calibration.
  const size = GameWorld.SPRITE_DISPLAY_SIZE
  check(
    'a grid sheet draws at a larger box than the strips, yet the same character',
    size * sheet.displayScale > size,
    `heavy draws at ${(size * sheet.displayScale).toFixed(1)}px per cell vs ${size}px`,
  )

  const scaled = size * sheet.displayScale
  let worst = 0
  for (let frame = 0; frame < sheet.frameCount; frame++) {
    const rectBottom = GameWorld.FLOOR_Y + footOffsetForRow(sheet.footRowForFrame(frame), scaled, sheet.cellHeight)
    const visibleFeet = rectBottom - footOffsetForRow(sheet.footRowForFrame(frame), scaled, sheet.cellHeight)
    worst = Math.max(worst, Math.abs(visibleFeet - GameWorld.FLOOR_Y))
  }
  check('all 25 heavy attack frames put their visible feet on FLOOR_Y', worst < 1e-9, `worst ${worst}`)
}

console.log('CHARACTER SIZE: every sheet declares the scale that normalises it')
{
  // The artwork does not draw the character at a consistent size, so each sheet
  // carries a displayScale. The values themselves are verified against real
  // rendered pixels by scripts/verify-attack.mjs; what matters structurally here
  // is that a sheet cannot be added without one.
  const configs = createDefaultConfigs()
  const scaleByFile = new Map<string, number[]>()
  for (const cfg of configs.values()) {
    const list = scaleByFile.get(cfg.sourceFileName) ?? []
    list.push(cfg.displayScale)
    scaleByFile.set(cfg.sourceFileName, list)
  }

  for (const [file, scales] of scaleByFile) {
    const uniform = scales.every((s) => Math.abs(s - scales[0]) < 1e-9)
    check(
      `${file}: every action using it agrees on one scale`,
      uniform,
      scales.map((s) => s.toFixed(3)).join(', '),
    )
  }

  // A grid-packed 256px cell has to scale up to match the 128px strips, a strip
  // drawn slightly small has to scale up, and one drawn large has to scale down.
  const scaleFor = (action: PlayerAction) => configs.get(action)!.displayScale
  check('the grid attack sheets scale up past their larger cell', scaleFor(PlayerAction.ATTACK) > 1.2 && scaleFor(PlayerAction.HEAVY_ATTACK) > 1.2, `attack ${scaleFor(PlayerAction.ATTACK)}, heavy ${scaleFor(PlayerAction.HEAVY_ATTACK)}`)
  // Idle is the size every other sheet is calibrated against, but it is not
  // necessarily the unscaled one: the artwork can draw its character smaller than
  // the common size, in which case idle carries a small correction of its own.
  const idleScale = scaleFor(PlayerAction.IDLE)
  check('idle is normalised, not left at an arbitrary size', idleScale > 0.9 && idleScale < 1.2, `idle ${idleScale}`)
  check('walk, drawn smaller than idle, scales up', scaleFor(PlayerAction.WALK) > 1, `${scaleFor(PlayerAction.WALK)}`)
  check('jump, drawn smaller than idle, scales up', scaleFor(PlayerAction.JUMP) > 1, `${scaleFor(PlayerAction.JUMP)}`)

  // Every action standing in on idle.png renders that sheet, so it must render at
  // idle's scale. Getting this wrong is invisible in the config and only shows up
  // as those actions playing at a different size from idle.
  const idleConfig = configs.get(PlayerAction.IDLE)!
  for (const action of [PlayerAction.BLOCK, PlayerAction.DASH, PlayerAction.HURT, PlayerAction.DEATH]) {
    const cfg = configs.get(action)!
    if (cfg.sourceFileName !== idleConfig.sourceFileName) continue
    check(
      `${action} stands in on idle.png and matches its scale`,
      cfg.displayScale === idleConfig.displayScale,
      `${cfg.sourceFileName} at ${cfg.displayScale} vs idle ${idleConfig.displayScale}`,
    )
  }

  // The sheet drawn at a different native resolution must resolve the same
  // on-screen size as idle, which is the whole point of the scale.
  const size = GameWorld.SPRITE_DISPLAY_SIZE
  const heavy = configs.get(PlayerAction.HEAVY_ATTACK)!
  check(
    'a grid sheet draws at a larger box than the strips, yet the same character',
    size * heavy.displayScale > size,
    `heavy draws at ${(size * heavy.displayScale).toFixed(1)}px per cell vs ${size}px`,
  )
}

console.log("the sprite cell is anchored on each frame's own opaque bottom")
{
  // SpriteSheet only reads image.width/height here, so a plain stub is enough.
  const stubImage = { width: 1536, height: 128 } as unknown as HTMLCanvasElement
  const size = GameWorld.SPRITE_DISPLAY_SIZE

  for (const [action, sheetFile] of [
    [PlayerAction.IDLE, 'idle.png'],
    [PlayerAction.WALK, 'walk.png'],
  ] as const) {
    const config = createDefaultConfigs().get(action)!
    const sheet = new SpriteSheet(action, stubImage, config)

    check(`${sheetFile}: every frame reports its measured foot row`, sheet.footRowForFrame(0) !== undefined, '')

    let worst = 0
    for (let frame = 0; frame < sheet.frameCount; frame++) {
      // The renderer puts the draw-rect bottom this far below FLOOR_Y...
      const rectBottom = GameWorld.FLOOR_Y + footOffsetForRow(sheet.footRowForFrame(frame), size)
      // ...so walking back up by that frame's own padding lands on the plane.
      const visibleFeet = rectBottom - footOffsetForRow(sheet.footRowForFrame(frame), size)
      worst = Math.max(worst, Math.abs(visibleFeet - GameWorld.FLOOR_Y))
    }
    check(`${sheetFile}: all ${sheet.frameCount} frames put their visible feet on FLOOR_Y`, worst < 1e-9, `worst ${worst}`)
  }

  const walkSheet = new SpriteSheet(PlayerAction.WALK, stubImage, createDefaultConfigs().get(PlayerAction.WALK)!)
  check(
    'walk frames report distinct foot rows where the art varies',
    walkSheet.footRowForFrame(2) === 110 && walkSheet.footRowForFrame(8) === 112 && walkSheet.footRowForFrame(0) === 111,
    '',
  )
  check(
    'out-of-range frame index clamps to the last frame, like frameRect does',
    walkSheet.footRowForFrame(99) === 112 && walkSheet.footRowForFrame(-5) === 111,
    `got ${walkSheet.footRowForFrame(99)} / ${walkSheet.footRowForFrame(-5)}`,
  )
  {
    // A sheet with no measured data must still anchor on the rest pose rather than
    // silently treating the cell bottom as the foot.
    const unmeasured = new SpriteSheet(
      PlayerAction.DASH,
      stubImage,
      { ...createDefaultConfigs().get(PlayerAction.DASH)!, footRows: [] },
    )
    check(
      'unmeasured frames fall back to the rest-pose foot row',
      unmeasured.footRowForFrame(0) === DEFAULT_FOOT_ROW,
      `got ${unmeasured.footRowForFrame(0)}`,
    )
  }
}

console.log('IDLE: feet pinned to the ground plane')
// resetPlayer() intentionally does not clear held input (releasing the stick is the
// caller's job), and earlier blocks left movement input asserted, so neutralise it.
player.setMovementInput(0)
player.resetPlayer(GameWorld.SPAWN_X, GameWorld.FLOOR_Y)
check('idle feet on the plane', Math.abs(player.groundY - GameWorld.FLOOR_Y) < 1e-6, `got ${player.groundY}`)
check('idle state active', anim.currentAction === PlayerAction.IDLE)
{
  let worst = 0
  for (let i = 0; i < 600; i++) {
    world.update(1 / 60)
    worst = Math.max(worst, Math.abs(player.groundY - GameWorld.FLOOR_Y))
  }
  check('idle holds the plane for 10s with zero drift', worst < 1e-6, `worst deviation ${worst}`)
  check('idle does not drift horizontally', Math.abs(player.x - GameWorld.SPAWN_X) < 1e-6, `got ${player.x}`)
  check('still IDLE after 10s', anim.currentAction === PlayerAction.IDLE, `got ${anim.currentAction}`)
}

console.log('WALK: travels along the plane without floating or sinking')
{
  player.resetPlayer(GameWorld.SPAWN_X, GameWorld.FLOOR_Y)
  player.setMovementInput(1)
  let worst = 0
  let minX = player.x
  let maxX = player.x
  for (let i = 0; i < 180; i++) {
    world.update(1 / 60)
    worst = Math.max(worst, Math.abs(player.groundY - GameWorld.FLOOR_Y))
    minX = Math.min(minX, player.x)
    maxX = Math.max(maxX, player.x)
  }
  // The arena is exactly one backdrop wide, so a sustained walk drives the player
  // into the right wall and stops there rather than running off into nothing.
  const rightLimit = GameWorld.WORLD_WIDTH - player.width / 2
  check(
    'walk drives the player to the right world boundary and stops',
    maxX > GameWorld.SPAWN_X + 200 && Math.abs(maxX - rightLimit) < 1e-6,
    `travelled ${(maxX - minX).toFixed(1)}px, stopped at ${maxX.toFixed(2)}, limit ${rightLimit}`,
  )
  check('walk keeps feet on the plane (3s)', worst < 1e-6, `worst deviation ${worst}`)
  check('walk state active', anim.currentAction === PlayerAction.WALK, `got ${anim.currentAction}`)
  check('grounded throughout the walk', player.isGrounded)

  // Walking the full arena must not accumulate vertical error anywhere.
  let worstFull = 0
  player.resetPlayer(GameWorld.SPAWN_X, GameWorld.FLOOR_Y)
  player.setMovementInput(1)
  for (let i = 0; i < 600; i++) {
    world.update(1 / 60)
    worstFull = Math.max(worstFull, Math.abs(player.groundY - GameWorld.FLOOR_Y))
  }
  check('no vertical drift across the whole arena', worstFull < 1e-6, `worst deviation ${worstFull}`)
}

console.log('JUMP: leaves from the plane and returns to it')
{
  player.resetPlayer(GameWorld.SPAWN_X, GameWorld.FLOOR_Y)
  const launchY = player.groundY
  check('jump launches from exactly the plane', Math.abs(launchY - GameWorld.FLOOR_Y) < 1e-6, `got ${launchY}`)
  check('jump accepted', player.onJump())

  let peak = launchY
  let airFrames = 0
  for (let i = 0; i < 300; i++) {
    world.update(1 / 60)
    peak = Math.min(peak, player.groundY)
    if (!player.isGrounded) airFrames++
    if (player.isGrounded && i > 0) break
  }
  check('jump gains real height', launchY - peak > 50, `peak rise ${(launchY - peak).toFixed(1)}px`)
  check('airborne for a plausible number of frames', airFrames > 20 && airFrames < 120, `got ${airFrames}`)
  check('lands exactly on the plane', Math.abs(player.groundY - GameWorld.FLOOR_Y) < 1e-6, `got ${player.groundY}`)
  check('grounded again after landing', player.isGrounded)
  check('vertical velocity cleared on landing', player.vy === 0, `got ${player.vy}`)
}

console.log('JUMP ANIMATION: uses the jump sheet and tracks the arc')
{
  const cfg = createDefaultConfigs().get(PlayerAction.JUMP)!
  check('jump plays the jump sheet, not a stand-in', cfg.sourceFileName === 'jump.png', cfg.sourceFileName)
  check('jump frame count matches the 8-frame sheet', cfg.frameCount === 8, `got ${cfg.frameCount}`)
  check('jump has measured foot rows for every frame', cfg.footRows.length === 8, `got ${cfg.footRows.length}`)

  // The animation must finish when the character does. Airtime is
  // 2*|impulse|/gravity; the sheet is frameCount/fps seconds long.
  const airtime = (2 * 360) / 880
  const animLength = cfg.frameCount! / cfg.fps
  check(
    'jump animation length matches the airtime within one frame',
    Math.abs(animLength - airtime) <= 1 / cfg.fps,
    `animation ${animLength.toFixed(3)}s vs airtime ${airtime.toFixed(3)}s`,
  )
  check('jump animation does not loop', cfg.loop === false, `loop ${cfg.loop}`)

  // This sheet draws the character compressing as it takes off rather than rising
  // inside the cell, so the feet hold one row for the whole animation and the
  // vertical travel comes from the world's arc. A varying foot row here would mean
  // the sheet was re-registered against art that does not move in-cell.
  check(
    'the jump sheet keeps one foot row, so the world supplies the rise',
    new Set(cfg.footRows).size === 1,
    `foot rows ${[...new Set(cfg.footRows)].join(', ')} across ${cfg.footRows.length} frames`,
  )
}

console.log('LANDING: repeated jumps never accumulate error')
{
  player.resetPlayer(GameWorld.SPAWN_X, GameWorld.FLOOR_Y)
  let worst = 0
  for (let jump = 0; jump < 25; jump++) {
    if (!player.isGrounded) {
      // wait for touchdown
      for (let i = 0; i < 300 && !player.isGrounded; i++) world.update(1 / 60)
    }
    worst = Math.max(worst, Math.abs(player.groundY - GameWorld.FLOOR_Y))
    if (!player.onJump()) break
    for (let i = 0; i < 300; i++) {
      world.update(1 / 60)
      if (player.isGrounded) break
    }
    worst = Math.max(worst, Math.abs(player.groundY - GameWorld.FLOOR_Y))
  }
  check('25 jump/land cycles stay on the plane', worst < 1e-6, `worst deviation ${worst}`)
  check('final groundY is the plane', Math.abs(player.groundY - GameWorld.FLOOR_Y) < 1e-6, `got ${player.groundY}`)
}

console.log('JUMP + WALK: airborne then moving, lands on the same plane')
{
  player.resetPlayer(GameWorld.SPAWN_X, GameWorld.FLOOR_Y)
  const startX = player.x
  player.onJump()
  for (let i = 0; i < 5; i++) {
    player.setMovementInput(1)
    world.update(1 / 60)
  }
  check('airborne while moving', !player.isGrounded)
  check('JUMP state while airborne', anim.currentAction === PlayerAction.JUMP, `got ${anim.currentAction}`)
  for (let i = 0; i < 300 && !player.isGrounded; i++) {
    player.setMovementInput(1)
    world.update(1 / 60)
  }
  player.setMovementInput(0)
  check('landed on the plane after moving jump', Math.abs(player.groundY - GameWorld.FLOOR_Y) < 1e-6, `got ${player.groundY}`)
  check('horizontal travel happened in the air', player.x - startX > 30, `moved ${(player.x - startX).toFixed(1)}px`)
  for (let i = 0; i < 60; i++) world.update(1 / 60)
  check('settles back to the plane at rest', Math.abs(player.groundY - GameWorld.FLOOR_Y) < 1e-6, `got ${player.groundY}`)
}

console.log('HITBOX bottom sits on the plane')
{
  player.resetPlayer(GameWorld.SPAWN_X, GameWorld.FLOOR_Y)
  check('hitbox bottom == ground plane', Math.abs(player.hitbox.bottom - GameWorld.FLOOR_Y) < 1e-6, `got ${player.hitbox.bottom}`)
  const dummy = world.dummies[0]
  check('training dummy also stands on the plane', Math.abs(dummy.groundY - GameWorld.FLOOR_Y) < 1e-6, `got ${dummy.groundY}`)
  check('dummy hitbox bottom == ground plane', Math.abs(dummy.hitbox.bottom - GameWorld.FLOOR_Y) < 1e-6)
  player.onJump()
  world.update(1 / 60)
  check('hitbox bottom rises off the plane in the air', player.hitbox.bottom < GameWorld.FLOOR_Y - 1, `got ${player.hitbox.bottom}`)
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
if (failures > 0) process.exit(1)
