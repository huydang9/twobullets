---
name: browser-verify
description: Verify twobullets features in Chrome via claude-in-chrome despite hidden/throttled automation tabs — manual frame stepping harness, fake pointer lock, screenshots. Use before declaring a phase done or when checking a visual/gameplay change.
---

# Browser verification

1. **Dev server:** `curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/`. If it's down, run `pnpm dev` in the background.
   - **While agents are editing files**, their saves trigger Vite HMR reloads mid-test. Use a no-HMR Vite on another port instead. Write a config in the session scratchpad and start it in the background:

     ```js
     // <scratchpad>/vite.nohmr.mjs
     export default {
       root: "/Users/huydang/Documents/02_Huy/twobullets/apps/client",
       server: { port: 5174, hmr: false, watch: { ignored: ["**/*"] } },
       optimizeDeps: { exclude: ["@babylonjs/havok"] }, // same as apps/client/vite.config.ts
     };
     ```

     `apps/client/node_modules/.bin/vite --config <scratchpad>/vite.nohmr.mjs`, then test on `http://localhost:5174/`. It never sees new code on its own: restart it (and reload the tab) to pick up agents' changes.
2. **Load Chrome tools in ONE ToolSearch call**: tabs_context_mcp, tabs_create_mcp, tabs_close_mcp, navigate, computer, javascript_tool, read_console_messages, find, browser_batch. Then call `tabs_context_mcp({createIfEmpty:true})`.
3. **Navigate and wait:** assets take about 10–25 s, Map v1 longer in hidden tabs. Check `read_console_messages` for `rror|fail|shader`. `window.__twobullets` appears when the game is ready.
4. **Automation tabs are `hidden`:** requestAnimationFrame is paused, pointer lock is refused, and FPS is meaningless. Install the harness below and step frames manually.
   - `await new Promise(requestAnimationFrame)` never resolves in a hidden tab, so a `javascript_tool` call that awaits it hangs. Step synchronously instead.
   - Don't yield with a `MessageChannel` busy loop (post → onmessage → post…): it starves CDP, and later `javascript_tool` evaluations never run.

```js
const g = window.__twobullets, P = g.player, C = g.combat;
Object.defineProperty(g.input, 'isLocked', { get: () => true, configurable: true });
g.hud.setLocked(true);
window.__step = (n) => { for (let i = 0; i < n; i++) { g.player.update(1/60); g.combat.update(1/60); g.equipment?.update?.(); g.presentation.update(1/60); g.scene.render(); g.hud.update({ fps: 60, player: P.getDebugState() }); g.input.endFrame(); } };
window.__place = (x, y, z, yaw, pitch = 0) => { P.body.teleport({x, y, z}); P.yaw = yaw; P.pitch = pitch; P.state = { ...P.state, velocity: {x:0,y:0,z:0} }; P.body.getFeetToRef(P.currentFeet); P.previousFeet.copyFrom(P.currentFeet); };
window.__view = (x, z, yawDeg, pitch = 0.05) => { const t = g.world?.terrain; const y = t ? t.sampleHeight(x, z) : 0; __place(x, y + 0.3, z, yawDeg * Math.PI / 180, pitch); __step(45); };
window.__aimAt = (tx, ty, tz) => { const e = P.getEyeToRef(P.camera.position.clone()); const dx = tx - e.x, dy = ty - e.y, dz = tz - e.z; P.yaw = Math.atan2(dx, dz); P.pitch = -Math.atan2(dy, Math.sqrt(dx*dx + dz*dz)); };
window.__mouse = (type, button = 0) => document.dispatchEvent(new MouseEvent(type, { button, bubbles: true }));
window.__key = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
```

5. **Test by state, then look:**
   - Fire (`__mouse('mousedown',0); __step(n); __mouse('mouseup',0)`) and listen to `C.onDamage` / `onImpact`.
   - Soldiers: `C.targets.dummies[i].soldier.root.getAbsolutePosition()`, `.currentHealth`.
   - Take the screenshot right after stepping (it shows the last rendered frame). Use `zoom` on a region for detail; full screenshots are context-expensive.
   - **Bot match (`?bots=1`):** wait for `__twobullets.match` (the nav grid builds after the map). Then:
     1. Render once *before* starting (`g.scene.render()`, or `__step(1)`). A first `scene.render()` after START froze a hidden tab.
     2. Start the match by firing the lock listeners, since pointer lock is refused: `g.input.lockListeners.forEach((l) => l(true))` (after the fake `isLocked` above). START MATCH builds `MatchSim`.
     3. Step with the match in the loop: add `g.match.match.update(1/60)` right after `g.player.update(1/60)` in `__step` (`g.match` is the DEV handle; `.match` is the `OfflineMatch`). Match state: `g.match.state`, `g.match.events(20)`, `g.match.debug(slot)`.
   - **Frozen tab:** a hung tab can't answer CDP. To bisect, write progress to `localStorage` inside the stepping code and read it from a **new tab on the same origin**, or reload with `&matchTrace=1` (breadcrumbs in `localStorage["tb.matchTrace"]`) and `&matchSkip=bodies,hud,fx,wall,equipment,sim` to turn match parts off one at a time. Close the frozen tab from another tab (`tabs_close_mcp`); don't try to evaluate in it.
6. **Good viewpoints on Map v1:**
   - town (-30,-30, yaw 35)
   - meadow (-150,150, yaw 135)
   - forest cabins (-340,-95, yaw 180)
   - quarry rim (-132,-268, yaw 135, pitch 0.24)
   - training yard (330,0)
7. **Performance:** don't measure it here. Ask the user to open `http://localhost:5173/?bench=v1` in a visible tab (about 8–10 min), click "Copy results" and paste the report.
8. **Close** every tab you created. Report what was verified and what wasn't (e.g. audio can't be heard; the user must listen).
