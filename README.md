# Mooshika & the Endless Modak

A 3D open-world collection game (this is the root project of `mushak-dash`; the earlier Babylon.js runner is archived untouched in `_legacy/`). Ride with Ganesha on Mooshika across an
infinite, procedurally generated world; reach a glowing modak, answer a
question about Ganesha, collect it, and it respawns somewhere new. Score goes
to a leaderboard. No death, no damage, no fail state — only "try the question
again".

```
npm install
npm run dev        # http://localhost:3003
npm run build      # dist/
```

## Controls

| Action        | Keyboard / mouse         | Gamepad            | Touch                       |
| ------------- | ------------------------ | ------------------ | --------------------------- |
| Move          | WASD / arrows            | Left stick         | Left-half virtual joystick  |
| Look          | Mouse (click to lock)    | Right stick        | Drag on right half          |
| Walk / run    | default run; Ctrl/C walk | stick deflection   | joystick deflection         |
| Sprint        | Shift                    | LS click / RT / X  | RUN button                  |
| Leap          | Space                    | A                  | LEAP button                 |
| Mount / off   | E                        | Y                  | RIDE / GET OFF button       |
| Pause         | Esc                      | Start              | II button                   |
| Answer        | 1–4, Enter to continue   | A to continue      | tap                         |
| Mute music    | M                        |                    |                             |
| Debug overlay | F3 (or `?debug`)         |                    |                             |

URL flags: `?seed=anything` (custom world), `?quality=low|medium|high|ultra`,
`?debug`, `?renderer=webgpu` (experimental).

## Architecture

```
src/
  core/      Engine (fixed 60 Hz step + interpolated render), Input, Settings,
             DeviceTier, ScoreSystem, MathUtils (allocation-free helpers)
  world/     Noise (seeded simplex + worley), TerrainField (analytic height/
             climate/biome/scatter), terrain.worker (off-thread chunk build +
             ground-layer weights), TerrainTextures + textures.worker (bakes
             tileable PBR grass/soil/rock/sand at load), TerrainMaterial
             (layered triplanar shader on MeshStandardMaterial), ChunkManager
             (streaming, LOD, colliders), PropLibrary (procedural LOD meshes,
             leaf-card canopies), Sky (sun/CSM/IBL/day-night/clouds), Water
  player/    CharacterController (kinematic capsule + analytic ground snap),
             MooshikaRig (procedural rig with physically based fur/skin/gold/
             silk, distance-driven gait blendspace), CharacterTextures (fur,
             elephant-skin and brushed-gold maps), CameraRig (spring arm)
  modak/     ModakSystem (12 pooled modaks, ring spawn, frustum-aware respawn)
  questions/ questions.json (160 questions, 5 categories, 3 tiers),
             QuestionSystem (score-scaled difficulty, no repeats)
  leaderboard/ validate.js (shared client/server rules), Leaderboard
             (Local or Supabase adapter)
  fx/        PostFX (GTAO → bloom → god rays → grade → ACES → SMAA),
             Particles (pooled), ProceduralTextures
  audio/     AudioEngine (fully synthesised: ambience, footsteps, bell, tabla,
             raga drone)
  ui/        HUD, QuestionCard, Menus, i18n (en, hi, mr, te, ta), styles
supabase/    schema.sql + submit-score Edge Function (server-side validation)
```

### How the world stays deterministic and infinite

Everything — height, biome, prop placement — is a pure function of
`(seed, x, z)` (`TerrainField.js`). Nothing is stored. The same seed produces
the same world on any machine; the daily leaderboard uses a shared seed
derived from the UTC date. Chunks (128×128 u, 5×5 active grid) are built in a
Web Worker pool and uploaded at most one per frame; the main thread never
computes terrain geometry.

Prop scatter is grid-priority dart throwing: one hashed candidate per cell,
kept only if no higher-priority neighbour lies within the disc radius. It has
Poisson-disc spacing, is seamless across chunk borders, and acceptance is
scaled by biome weight so populations fade across borders instead of cutting.

### Why movement feels smooth

* The controller is kinematic. Ground height is an exact analytic query, so
  there is no rigid body to stutter on slopes. Prop collisions are circle
  push-outs.
* Simulation runs at a fixed 60 Hz; rendering interpolates between the last two
  states, so 120 Hz displays get 120 distinct frames and a hitch never changes
  the simulated path.
* Speed integrates toward a target with separate accel (25) / decel (35);
  heading is damped (0.055 s) and rate-capped (8 rad/s); velocity is always
  along heading, giving natural arcs.
* The gait phase advances by *distance travelled / stride*, so foot contacts
  are glued to the ground at any speed. Gait parameters are interpolated across
  speed keys and every parameter is damped with a 0.15 s crossfade.
* Ganesha is a child of Mooshika's saddle node — one transform, no drift.
* Camera: pivot damped 0.12 s, rotation 0.08 s, FOV 65→78° with speed, spring
  arm shortens against terrain and tall props, auto-follows heading after 1.4 s
  without look input. No shake.

### Performance

Measured on an Apple-silicon Mac in headless Chrome, 1280×720:

| Preset | Draw calls | Notes                                                        |
| ------ | ---------- | ------------------------------------------------------------ |
| Low    | ~100       | no shadows / AO / SMAA, 35 % vegetation, 512² ground layers  |
| Medium | ~170       | 2 cascades @1024, 512² ground layers                         |
| High   | ~370       | 4 cascades @2048, GTAO, god rays, SMAA, 1K ground layers     |
| Ultra  | ~450–550   | as High, native pixel ratio (up to 4×), 4096² cascades, 16× AF |

Ultra renders at the display's native resolution — on a 4K/5K/8K monitor that
is the output size; there is no fixed "8K" target below that.

The base scene is ~70–90 draw calls; the rest is shadow cascades and the AO
normal pre-pass. Shadow maps are rendered exactly once per frame
(`shadowMap.autoUpdate = false`) and only the 3×3 chunks around the player
self-shadow. Props use one `InstancedMesh` per type per chunk; LOD is chosen by
screen-space height and applied by swapping the instanced mesh's geometry, so
the draw-call count never changes. The per-frame update path allocates
nothing: scratch vectors, typed arrays, numeric chunk keys, pooled particles,
pooled modaks, pooled HUD indicators.

### Rendering realism pass

* Ground is four tileable PBR layers (grass, soil, rock, sand — albedo,
  normal, roughness) generated in a worker and stored as 2D texture arrays.
  Weights per vertex come from biome, slope, shoreline and patch noise; the
  shader samples grass/soil/sand planar at two scales (kills tiling) and rock
  triplanar (no smearing on cliffs), then blends the normals in world space.
* A micro-relief octave gives the ground small undulations.
* Trees and shrubs use alpha-tested leaf cards around a dark core.
* Mooshika uses `MeshPhysicalMaterial`: fur with sheen and strand normals,
  wet clearcoated eyes and nose. The procedural Ganesha (fallback) uses skin
  with wrinkle normals, brushed clearcoated gold, silk with gold sheen, ivory
  and ruby; the shipped Ganesha is the textured GLB described below.

### Mount and dismount

* **E** (gamepad **Y**, touch **GET OFF / RIDE**) toggles riding. Off the
  mount, Ganesha glides on a lotus pedestal at calmer speeds with a narrower
  collider; Mooshika stays where he was left and idles.
* **Houses and huts are on foot only.** Doorways carry a blocker that only
  applies while mounted (`queryDoorBlockers`), so Mooshika cannot enter; caves
  are open to both. Mounting is refused indoors ("Mooshika waits outside").
* Press **E** away from Mooshika to whistle: he runs to you (`MountAI`),
  pushing around props like the player and stopping at any doorway, and
  Ganesha hops on when he arrives outdoors.
* Hidden modaks inside buildings therefore always require dismounting.

### Modak Hunt (competitive mode) and puzzles

* **Two modes** from the main menu: *Free Journey* (no clock) and **Modak
  Hunt** — a 5-minute timed run on the day's shared seed. The HUD shows the
  clock; at zero the run ends and the score is submitted tagged `mode: hunt`.
  The leaderboard has a "Hunt only" toggle (default on) and ranks within the
  mode; the daily board is the competition.
* **Hidden modaks**: a share of the twelve (25 % free, 42 % hunt) spawn *inside*
  houses, huts and caves. They have no beam; their edge indicator shows "?"
  and a distance rounded to 25 m, and the compass tick is hollow. You walk in
  through the door to find them.
* **Puzzles**: hidden modaks pose an arrange-in-order puzzle (`puzzles.json`,
  20 sequences: mantras, shlokas, story order, Ashtavinayak yatra, the eight
  avatars, puja steps…). Tap chips into order (number keys work), submit;
  wrong order shows the correct sequence and the explanation with the same
  5 s cooldown. Open modaks still pose questions. Scoring is identical
  (+100, streaks), so the server validation is unchanged.
* **Enterable buildings**: houses and huts are hollow with a real doorway and
  an open door leaf; caves are dome shells with a mouth. Walls are rasterised
  into small circle colliders (`PROP_COLLIDERS` with `walls` / `ring`), the
  doorway is a gap, and the camera's spring arm treats walls as blockers so it
  follows you indoors. Interiors have an oil lamp.

### Ganesha's world: villages, dens, Kailash

* **Mount Kailash** is a fixed landmark every seed shares (`KAILASH` in
  `WorldConfig.js`): a highland plateau rising to a terraced 165 u peak, ~1 km
  north-west of spawn. Above `SNOW_LINE` a fifth ground layer (snow) blends in
  by elevation with a noisy snow line and thins on steep faces. A coarse mesh
  of the same height field (`Landmark.js`) is drawn with ~4× thinner fog so
  the mountain reads from kilometres away and hands off to streamed chunks.
  The compass shows a white peak marker with distance.
* **Kailash Snowfields biome** (6th biome): deodar cedars, prayer flags,
  caves, lamps and shrines on snow.
* **Villages**: houses (plaster walls, terracotta pitched roofs, blue window
  frames with warm-lit glass, marigold toran, doorstep diya and rangoli) and
  round thatched huts, plus wells and garlanded lampposts. They are placed by
  a cluster field (`cluster` on a scatter rule) so they form hamlets, aligned
  to a shared orientation grid, on flat ground only. Windows and diyas are
  emissive, so villages glow at night.
* **Dens**: mouse burrows (mound, dark entrance, worn apron, a mouse peeking
  out) in groves and meadows; rock caves with a lamp by the mouth in the hills
  and around Kailash.

### Ganesha model

`public/models/ganesha.glb` (16 MB, 120k triangles, PBR textures) was
generated with Meshy image-to-3D from a rendered reference. It ships with no
skeleton; `src/player/GaneshaRig.js` auto-rigs it at load by *spatial region*:
vertices in the head volume (crown, ears, trunk — excluding the raised hands
by depth and height) bind to a head bone at the neck, the four hands and
their implements bind to wrist bones, the rest stays on the root, with weight
bands so nothing tears. Blinking is two skin-toned upper-lid shells placed by
raycasting for the eye surface and rotated shut. He turns his head, looks
into turns, glances around, blinks irregularly and moves all four hands — on
a mesh that was never rigged. Delete the GLB and the procedural figure returns.

### Leaderboard, unique names, and load

Default is a per-browser local board. To enable the global board:

1. Create a Supabase project, run `supabase/schema.sql`.
2. Deploy both Edge Functions: `supabase functions deploy claim-name` and
   `supabase functions deploy submit-score`.
3. Copy `.env.example` to `.env` and fill in the URL and anon key.

**Unique names.** On first play a name is *claimed*: the device generates a
random secret, the server stores only its SHA-256 hash in `players` with a
unique index on the lower-cased name, so "Ganesh" and "ganesh" are the same
name and a concurrent double-claim can't both succeed. Submissions must carry
the claiming device's secret; the score's name is taken from `players`, not
from the client. If a name is taken the menu offers alternatives. Without a
server, names are unique per browser (the menu says so).

**Under load.** Gameplay is entirely client-side — players never affect each
other's frame rate. The only shared path is the leaderboard, which is built so
a crowd can't hurt it:

* reads hit best-per-player views (`leaderboard_daily/weekly/alltime`) with
  `limit 100`, backed by composite indexes; a player's exact rank comes from
  one `player_rank` RPC instead of pulling the board;
* the client caches boards for 60 s, coalesces concurrent requests, backs
  off exponentially on failure and serves stale data rather than hammer;
* `submit-score` rate-limits to one submission per player per 20 s and
  validates everything server-side;
* a failed submission (offline, 429, 5xx) is queued in localStorage and
  retried from the menu with backoff — the game loop never awaits the
  network, so a dead server can neither lag nor crash a session.

## Deviations from the brief (deliberate, stated)

* **No physics library.** The brief forbids rigid-body terrain following and
  wants capsule + raycast ground snap; with an analytic terrain, the remaining
  job (circle push-outs against props) doesn't justify cannon-es/Rapier. The
  controller is deterministic and lives in one file.
* **TAA → SMAA.** three.js's WebGL pipeline has no motion-vector TAA (its
  `TAARenderPass` accumulates static frames and ghosts in motion). SMAA is used.
* **SSR on water → env reflection + fresnel.** `SSRPass` costs a full extra
  scene pass; the water shader uses per-vertex depth (computed in the worker)
  for colour, shoreline foam and edge fade instead of a depth-buffer readback.
* **Occlusion culling** is frustum + screen-size culling (props below ~5 px are
  skipped). There is no GPU occlusion-query pass.
* **Assets.** Everything is procedural — no GLB/KTX2 files ship. Dropping real
  Draco/KTX2 assets in is a loader change, not an architecture change.
* **WebGPU** is an experimental toggle. `WebGPURenderer` ignores GLSL
  `onBeforeCompile` patches, `ShaderMaterial`, the `Sky` shader and the
  `EffectComposer` chain, so that path runs with plain materials, a single
  shadowed sun and no post effects. WebGL 2 is the shipping renderer.
* **Question text is English**; the UI is localised in five languages. The
  bank schema leaves room for `q_hi` / `o_hi` / `why_hi` style fields.
