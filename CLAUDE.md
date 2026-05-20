# Battle Isle — Claude Code Bot

## PARAMETERS (tweak these to change bot behaviour)
IMPROVEMENT_FOCUS: "balanced"        # options: gameplay / weapons / visuals / performance / balanced
RISK_LEVEL: "medium"                 # low (safe edits) / medium (new features) / high (big changes)
COMMIT_STYLE: "descriptive"          # descriptive / short

## BRANCH RULES — NON-NEGOTIABLE
- NEVER commit to `main` directly
- At the start of every session, create a new feature branch from `main`:
  git checkout main
  git pull origin main
  git checkout -b feature/[short-description]
  Example: feature/sniper-rifle, feature/zombie-pathfinding, feature/kill-feed
- Do ALL work on the feature branch
- Push the feature branch to origin when done
- If you are ever on `main`, do not touch any files — branch off immediately

## WHAT THIS GAME IS
Battle Isle is a multiplayer browser-based battle royale game.
- Players skydive onto an island, loot weapons, fight zombies and each other
- A storm shrinks the play area over time forcing players together
- Up to 20 players per match
- Host starts the match, late joiners sync to the same storm clock via worldSeed
- Zero external npm dependencies — server uses only built-in Node.js modules
- Frontend is vanilla JS + HTML5 Canvas/WebGL, no frameworks

## FILE MAP
- server.js         — HTTP static file server + WebSocket lobby. DO NOT TOUCH
- index.html        — Main game page
- js/main.js        — Game loop entry point
- js/player.js      — Player state, movement, health
- js/multiplayer.js — WebSocket client, sync logic
- js/world.js       — Map/terrain generation using worldSeed
- js/storm.js       — Storm shrink logic, clock sync
- js/weapons.js     — Weapon definitions and stats
- js/entities.js    — Game entity base class
- js/zombie.js      — Zombie AI and behaviour
- js/enemy.js       — Enemy logic
- js/projectile.js  — Bullet/projectile physics
- js/inventory.js   — Player inventory system
- js/pickups.js     — Loot and pickup logic
- js/supplyDrops.js — Supply drop events
- js/building.js    — Building/structure logic
- js/skydive.js     — Skydive/parachute opening sequence
- js/camera.js      — Camera follow and zoom
- js/ui.js          — HUD, health bar, inventory UI
- js/audio.js       — Sound effect triggers
- js/ammo.js        — Ammo types and counts
- js/effects.js     — Visual effects
- js/particles.js   — Particle system
- js/spectator.js   — Spectator mode after death
- css/style.css     — All styles

## GOOD IMPROVEMENTS (pick based on IMPROVEMENT_FOCUS above)
### gameplay
- Better zombie AI (pathfinding, group behaviour, aggro range)
- Supply drop timing and visual indicator improvements
- Storm pacing adjustments
- Better loot balance
- New game mechanics (revive system, armour plates)

### weapons
- New weapon types (sniper, crossbow, grenade launcher, flamethrower)
- Weapon balance tweaks (damage, fire rate, reload time)
- New ammo types
- Weapon attachments (scope, silencer)

### visuals
- Better particle effects for explosions, gunshots, impacts
- Improved storm visual (colour, edge glow)
- Better skydive sequence
- Damage numbers floating above enemies
- Kill feed in top right corner

### performance
- Object pooling for particles and projectiles
- Reduce unnecessary redraws
- Optimise zombie pathfinding loops

### balanced
- Pick one from any category above that hasn't been done recently

## DO NOT TOUCH — EVER
- server.js
- package.json
- sounds/ folder
- textures/ folder
- .gitignore
- The worldSeed sync logic in multiplayer.js (it is delicate)
- Port 3000 in server.js
- MAX_PLAYERS in server.js

## COMMIT FORMAT
Use clear messages like:
  "feature: added sniper rifle with scope zoom"
  "improve: zombie pathfinding now avoids buildings"
  "fix: storm damage not applying to late joiners"
  "enhance: kill feed added to top-right HUD"

## IF SOMETHING BREAKS OR FEELS RISKY
1. Stop immediately
2. Create NOTES.md explaining what you tried and why you stopped
3. Commit only NOTES.md to the feature branch with message "note: stopped — see NOTES.md"
4. Push the feature branch
5. Do not attempt to fix it — leave it for human review

## START OF EVERY SESSION CHECKLIST
1. Checkout main and pull latest:
   git checkout main
   git pull origin main
2. Run `git log --oneline -10` — see what was recently merged, never repeat it
3. Pick ONE improvement matching IMPROVEMENT_FOCUS
4. Create a feature branch:
   git checkout -b feature/[short-description]
5. Read all relevant files before touching anything
6. Touch as many files as needed to implement it completely
7. No half-finished code — the feature must work end to end
8. Check for syntax errors before committing
9. Commit with descriptive message
10. Push: git push origin feature/[short-description]
