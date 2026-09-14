---
name: browser-verify
description: Verify twobullets features in Chrome via claude-in-chrome despite hidden/throttled automation tabs — manual frame stepping harness, fake pointer lock, screenshots. Use before declaring a phase done or when checking a visual/gameplay change.
---

# Browser verification

1. **Dev server:** `curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/`. If it's down, run `pnpm dev` in the background.
2. **Load Chrome tools in ONE ToolSearch call**: tabs_context_mcp, tabs_create_mcp, tabs_close_mcp, navigate, computer, javascript_tool, read_console_messages, find, browser_batch. Then call `tabs_context_mcp({createIfEmpty:true})`.
3. **Navigate and wait:** assets take about 10–25 s, Map v1 longer in hidden tabs. Check `read_console_messages` for `rror|fail|shader`. `window.__twobullets` appears when the game is ready.
4. **Automation tabs are `hidden`:** requestAnimationFrame is paused, pointer lock is refused, and FPS is meaningless. Install the harness below and step frames manually.

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
6. **Good viewpoints on Map v1:**
   - town (-30,-30, yaw 35)
   - meadow (-150,150, yaw 135)
   - forest cabins (-340,-95, yaw 180)
   - quarry rim (-132,-268, yaw 135, pitch 0.24)
   - training yard (330,0)
7. **Performance:** don't measure it here. Ask the user to open `http://localhost:5173/?bench=v1` in a visible tab (about 8–10 min), click "Copy results" and paste the report.
8. **Close** every tab you created. Report what was verified and what wasn't (e.g. audio can't be heard; the user must listen).
