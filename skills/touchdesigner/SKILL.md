---
name: touchdesigner
description: Control TouchDesigner projects via MCP — create/wire operators, write GLSL shaders, set parameters, capture visual output, and render video. Load when user asks about TouchDesigner, real-time visuals, interactive installations, or creative coding with TD.
---

# TouchDesigner MCP

Control TouchDesigner projects programmatically via the `johnsabath/touchdesigner-mcp` server. This MCP server runs inside TouchDesigner via a Web Server DAT on port 9988, giving full control over any TD project.

**Repo**: https://github.com/johnsabath/touchdesigner-mcp
**Setup**: Drag `td_mcp_server.tox` into a TD project — server starts on `http://localhost:9988/mcp`

## When to Use
- User wants to create or edit TouchDesigner operators
- User needs to build visual/audio-reactive pipelines
- User asks about GLSL shaders in TD
- User wants to capture screenshots, GIFs, or render video from TD
- User needs to wire operator networks
- User wants to build interactive installations with TD
- User asks about feedback loops, instancing, or procedural visuals

## Tools (13)

### run
Execute Python code inside TouchDesigner. Expressions return values directly, multi-line code captures stdout.

**Parameters:**
- `code` (required) — Python code to execute in TD context

**Example:**
```json
{ "code": "op('/project1/out').width" }
```

### inspect
Get detailed operator info — type, channels (with values), parameters, errors, connections.

**Parameters:**
- `path` (required) — Absolute operator path (e.g. `/project1/my_op`)

### set
Set operator parameters with validation — constant values and/or expressions.

**Parameters:**
- `path` (required) — Operator path
- `params` (optional) — Object of `{ paramName: value }` for constant values
- `exprs` (optional) — Object of `{ paramName: "expression" }` for expressions

**Example:**
```json
{ "path": "/project1/noise1", "params": { "rough": 0.5 }, "exprs": { "tx": "me.time.seconds" } }
```

### create
Create an operator with position, params, expressions, and wiring in one call. Requires `nodeX`/`nodeY`.

**Parameters:**
- `path` (required) — Parent container path
- `type` (required) — TD type constant (e.g. `glslTOP`, `noiseCHOP`)
- `name` (required) — Operator name
- `nodeX`, `nodeY` (required) — Position in network editor
- `params` (optional) — Initial parameter values
- `exprs` (optional) — Initial expressions
- `connect_from` (optional) — Path(s) to connect as input

### wire
Batch-wire operator connections and parameter expressions with auto-incrementing input indices.

**Parameters:**
- `connections` (required) — Array of `{ from, to }` connection specs

### observe
Capture a snapshot (PNG) or animated GIF of the current visual output. Always pass explicit `top` path.

**Parameters:**
- `top` (optional but recommended) — Explicit TOP path to capture
- `frames` (optional) — Number of frames for animated capture
- `format` (optional) — `png` or `gif`

### render
Render MP4 video using TD-native recording. Both `output` and `duration` are required.

**Parameters:**
- `output` (required) — Output file path
- `duration` (required) — Duration in seconds
- `fps` (optional) — Frame rate (default 30)
- `audio_chop` (optional) — CHOP path for audio capture

### read
Read a TextDAT (with optional offset/limit).

**Parameters:**
- `path` (required) — TextDAT path

### write
Overwrite a TextDAT (creates if missing).

**Parameters:**
- `path` (required) — TextDAT path
- `text` (required) — Content to write

### edit
Find/replace within a TextDAT.

**Parameters:**
- `path` (required) — TextDAT path
- `find` (required) — Text to find
- `replace` (required) — Replacement text

### list
List operators under a container, filterable by family/pattern.

**Parameters:**
- `path` (optional) — Container path (default: root)
- `family` (optional) — Filter by family (TOP, CHOP, SOP, etc.)
- `pattern` (optional) — Glob pattern

### docs
Look up params, menus, defaults, and connectors for any op type. **Always call before creating operators** — TD param names are abbreviated and non-obvious.

**Parameters:**
- `type` (required) — Type constant (e.g. `glslTOP`) or `list_types`
- `family` (optional) — Filter type listing by family
- `filter` (optional) — Filter params by name substring

### map
Render the operator network as a text map with connections, positions (`@(x,y)`), and non-default params.

**Parameters:**
- `path` (optional) — Container path (default: root)

## The Build Loop

Every TD task follows this cycle:

1. **Orient** — `map` to see what exists and where
2. **Look up** — `docs` for every operator type BEFORE creating it
3. **Build** — `create` for operators or `run` for complex multi-op scripts
4. **Observe** — `observe` with explicit `top` path to see output
5. **Refine** — `edit` for shader tweaks, `set` for param changes
6. Repeat 4-5 until it looks right

## Hard Rules

### Always call `docs` before creating operators
TD parameter names are abbreviated. Common wrong guesses:

| You'd guess | Actual name | Operator |
|---|---|---|
| `roughness` | `rough` | noiseCHOP/TOP |
| `type` (waveform) | `wavetype` | lfoCHOP |
| `saturation` | `saturationmult` | hsvadjustTOP |
| `brightness` | `brightness1` | levelTOP |
| `radius` | `size` | blurTOP |
| `multiply` | `gain` | mathCHOP |

### Parameters: `.val` vs `.eval()` vs `.expr`
- `par.x = 5` — sets constant value
- `par.x.expr = "..."` — sets expression (switches to expression mode)
- `par.x.eval()` — get current value in any mode (always safe to read)
- **WRONG:** `par.rotate = "me.time.seconds"` — string to numeric par will ERROR

### Always pass explicit `top` path to `observe`
Auto-detection only finds ops named `out`, `out1`, `render`, `comp`, `null1`.

### Feedback loop wiring order
1. Create feedback TOP early
2. Wire its OUTPUT into the processing chain first
3. Close the loop (connect INPUT) LAST

### Resolution management
Chain roots (no input) need explicit resolution: feedbackTOP, noiseTOP, constantTOP, glslTOP, renderTOP.
```python
top.par.outputresolution = 'custom'
top.par.resmult = False
top.par.resolutionw = 1920
top.par.resolutionh = 1080
```

## Common Operator Types

### TOPs (Texture Operators)
| Type | What It Does | Key Params |
|---|---|---|
| `glslTOP` | Custom shaders (auto-creates `_pixel` DAT) | `resolutionw/h`, `vec0name`, `vec0valuex/y/z/w` |
| `compositeTOP` | Blend two inputs | `operand` (screen, add, multiply, over) |
| `feedbackTOP` | Feedback loop node | `top`, `resetpulse` |
| `transformTOP` | Translate/rotate/scale | `tx/ty`, `rotate`, `sx/sy` |
| `levelTOP` | Brightness/gamma/contrast | `brightness1`, `gamma1`, `contrast` |
| `noiseTOP` | Procedural noise texture | `type`, `rough`, `period`, `amp`, `tx/ty/tz` |
| `blurTOP` | Blur filter | `size`, `type` |
| `renderTOP` | 3D render | `camera`, `geometry`, `lights`, `resolutionw/h` |

### CHOPs (Channel Operators)
| Type | What It Does | Key Params |
|---|---|---|
| `lfoCHOP` | Oscillator | `wavetype`, `frequency`, `amp` |
| `noiseCHOP` | Procedural noise | `rough`, `period`, `amp`, `channelname` |
| `mathCHOP` | Range mapping / math | `gain`, `preoff`, `postoff` |
| `constantCHOP` | Static values | `name0`, `value0` |

### 3D Pipeline
| Type | What It Does |
|---|---|
| `gridSOP`, `sphereSOP`, `boxSOP`, `torusSOP` | Primitive geometry |
| `pbrMAT`, `phongMAT`, `constantMAT` | Materials |
| `geometryCOMP` | Contains SOPs for rendering |
| `cameraCOMP` | Camera for renderTOP |
| `lightCOMP` | Light for renderTOP |

## Recipes

### GLSL Shader Pipeline
```python
root = op('/project1')
glsl = root.create(glslTOP, 'my_glsl')
glsl.par.resolutionw = 1920
glsl.par.resolutionh = 1080

out = root.create(nullTOP, 'out')
out.inputConnectors[0].connect(glsl)

# Write shader to auto-created pixel DAT
pixel_dat = root.op('my_glsl_pixel')
pixel_dat.text = """uniform vec4 uTime;
out vec4 fragColor;
void main() {
    vec2 res = uTDOutputInfo.res.zw;
    vec2 uv = gl_FragCoord.xy / res;
    fragColor = vec4(uv, 0.5 + 0.5 * sin(uTime.x), 1.0);
}"""

# Wire time uniform
glsl.par.vec0name = 'uTime'
glsl.par.vec0valuex.expr = "me.time.seconds"
```

### Feedback Loop
```python
root = op('/project1')
seed = root.create(noiseTOP, 'fb_seed')
seed.par.resolutionw = 960
seed.par.resolutionh = 540

feedback = root.create(feedbackTOP, 'fb_feedback')

transform = root.create(transformTOP, 'fb_transform')
transform.par.rotate.expr = "me.time.seconds * 2"
transform.par.sx = 0.99
transform.par.sy = 0.99
transform.inputConnectors[0].connect(feedback)

comp = root.create(compositeTOP, 'fb_comp')
comp.par.operand = 'screen'
comp.inputConnectors[0].connect(seed)
comp.inputConnectors[1].connect(transform)

out = root.create(nullTOP, 'fb_out')
out.inputConnectors[0].connect(comp)

# Close loop LAST
feedback.inputConnectors[0].connect(comp)
```

### 3D Render Pipeline
```python
root = op('/project1')
geo = root.create(geometryCOMP, 'geo1')
torus = geo.create(torusSOP, 'torus1')
out_sop = geo.create(outSOP, 'out1')
out_sop.inputConnectors[0].connect(torus)

cam = root.create(cameraCOMP, 'cam1')
cam.par.tz = 5
light = root.create(lightCOMP, 'light1')
mat = root.create(pbrMAT, 'mat1')
geo.par.material = 'mat1'

render = root.create(renderTOP, 'render1')
render.par.camera = 'cam1'
render.par.geometry = 'geo1'
render.par.lights = 'light1'
render.par.outputresolution = 'custom'
render.par.resmult = False
render.par.resolutionw = 1920
render.par.resolutionh = 1080
```

## Debugging

| Symptom | Likely Cause | Fix |
|---|---|---|
| Black screen | Shader error, missing connection | `inspect` on output chain — look for `errors` |
| Param didn't take | Wrong parameter name | `docs` to get correct name |
| Expression error | String assigned to numeric par | Use `.expr = "..."` |
| Feedback loop frozen | Loop not closed or no decay | Verify feedback input connected; scale < 1.0 |
| TOP stuck at 128x128 | Missing resolution override | Set `outputresolution='custom'`, `resmult=False`, explicit w/h |

## GLSL in TouchDesigner

- Creating `glslTOP` named `X` auto-creates `X_pixel` (pixel shader DAT)
- Color output: `out vec4 fragColor;`
- Built-in: `uTDOutputInfo.res.zw` (resolution), `gl_FragCoord.xy` (pixel coords)
- Standard UV: `vec2 uv = gl_FragCoord.xy / uTDOutputInfo.res.zw;`
- Uniforms wired via Vector page: `vec0name='uTime'`, `vec0valuex.expr = "me.time.seconds"`
- `#extension` directives go in Preprocess Directives param (`predat`), not in shader body

## Network Connectivity

The MCP server runs on port 9988 on the machine running TouchDesigner. For remote access (e.g. from a server):
- TD machine must have port 9988 accessible
- Use SSH tunnel or direct network access depending on setup
- MCP endpoint: `http://<td-machine-ip>:9988/mcp`
