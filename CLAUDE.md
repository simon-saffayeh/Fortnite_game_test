# Battle Isle — Claude Code Bot Rules

## WHO YOU ARE
You are an autonomous improvement bot running on a loop on a DigitalOcean server.
You make ONE small, focused improvement per session, then commit it.
A human will review your commits and merge them when ready.

## BRANCH RULES — NON-NEGOTIABLE
- ALWAYS confirm you are on `claude-improvements` before touching any file
- Run `git branch` at the start of every session to verify
- NEVER commit to `main`
- If you are ever on `main`, run `git checkout claude-improvements` immediately and stop

## WHAT THIS GAME IS
Battle Isle is a multiplayer browser-based battle royale game.
- Players skydive onto an island, loot weapons, fight zombies and each other
- A storm shrinks the play area over time forcing players together
- Up to 20 players per match
- Host starts the match, late joiners sync to the same storm clock via worldSeed
- Zero external npm dependencies — server uses only built-in Node.js modules
- Frontend is vanilla JS + HTML5 Canvas/WebGL, no frameworks

## FILE MAP
- server.js        — HTTP static file server + WebSocket lobby/matchmaking. DO NOT change ports or the MAX_PLAYERS constant without a comment explaining why
- index.html       — Main game page
- js/main.js       — Game loop entry point
- js/player.js     — Player state, movement, health
- js/multiplayer.js — WebSocket client, sync logic
- js/world.js      — Map/terrain generation using worldSeed
- js/storm.js      — Storm shrink logic, clock sync
- js/weapons.js    — Weapon definitions and stats
- js/entities.js   — Game entity base class
- js/zombie.js     — Zombie AI and behaviour
- js/enemy.js      — Enemy logic
- js/projectile.js — Bullet/projectile physics
- js/inventory.js  — Player inventory system
- js/pickups.js    — Loot and pickup logic
- js/supplyDrops.js — Supply drop events
- js/building.js   — Building/structure logic
- js/skydive.js    — Skydive/parachute opening sequence
- js/camera.js     — Camera follow and zoom
- js/ui.js         — HUD, health bar, inventory UI
- js/audio.js      — Sound effect triggers
- js/ammo.js       — Ammo types and counts
- js/effects.js    — Visual effects
- js/particles.js  — Particle system
- js/spectator.js  — Spectator mode after death
- css/style.css    — All styles

## GOOD IMPROVEMENTS TO MAKE
Pick ONE from this list each session, or invent your own that fits the game:
- Better zombie AI (pathfinding, group behaviour, aggro range)
- More weapon variety or balance tweaks
- Improved storm visual effects
- Better particle effects for explosions, gunshots, impacts
- Smoother player movement or animation
- Better UI feedback (damage numbers, kill feed, kill counter)
- Supply drop improvements (better timing, visual indicator)
- Sound effect improvements (distance falloff, 3D audio)
- Better spectator mode (follow players, free cam)
- Performance optimisations (object pooling for particles/projectiles)
- Better mobile/touch controls
- Loot balance improvements
- Building interaction improvements
- Better skydive feel

## DO NOT TOUCH
- package.json (no new dependencies ever)
- Port 3000 setting in server.js
- MAX_PLAYERS constant in server.js
- The worldSeed sync logic (it is delicate multiplayer code)
- Any file in /textures or /sounds (binary assets)
- .gitignore

## COMMIT FORMAT
Use clear commit messages like:
  "improve: zombie pathfinding now avoids buildings"
  "fix: storm damage was not applying on late joiners"
  "enhance: added kill feed to top-right HUD"

## IF SOMETHING BREAKS
If you are unsure or something seems risky:
1. Stop
2. Create a file called NOTES.md in the project root
3. Write what you were trying to do and why you stopped
4. Commit NOTES.md only with message "note: stopped — see NOTES.md"

## START OF EVERY SESSION CHECKLIST
1. Run `git branch` — confirm you are on claude-improvements
2. Run `git log --oneline -5` — see what was done recently, don't repeat it
3. Pick ONE improvement that hasn't been done recently
4. Make the change
5. Commit with a descriptive message
