---
name: houdini
description: Load when user asks about 3D modeling, VFX, procedural generation, rendering, scene management, or Houdini workflows. Use for 3D procedural modeling, visual effects, and scene control.
---

# Houdini

Houdini 3D/VFX control system for scene management, node creation and editing, rendering, materials, viewport capture, and code execution.

## When to Use
- User wants to create or edit 3D nodes
- User needs to render scenes or set render parameters
- User asks about materials or shaders
- User wants to capture viewport screenshots
- User needs to manage Houdini scenes
- User asks about node networks or geometry
- User wants to execute Houdini code
- User needs to troubleshoot rendering or nodes

## Tools

### ping_houdini
Check if Houdini is running and connected.

**Parameters:**
- None

**Example:**
```json
{
  "operation": "ping_houdini"
}
```

### check_connection
Verify connection status to Houdini.

**Parameters:**
- None

**Example:**
```json
{
  "operation": "check_connection"
}
```

### new_scene
Create a new Houdini scene.

**Parameters:**
- `scene_name` (optional) — name for the new scene

**Example:**
```json
{
  "operation": "new_scene",
  "scene_name": "procedural_city"
}
```

### load_scene
Load an existing Houdini scene file.

**Parameters:**
- `file_path` (required) — path to the .hip or .hipnc file

**Example:**
```json
{
  "operation": "load_scene",
  "file_path": "/projects/scenes/character_rig.hip"
}
```

### save_scene
Save the current Houdini scene.

**Parameters:**
- `file_path` (optional) — path to save to (uses current if not specified)
- `backup` (optional) — create backup before saving (true/false)

**Example:**
```json
{
  "operation": "save_scene",
  "file_path": "/projects/scenes/character_rig.hip",
  "backup": true
}
```

### get_scene_info
Get information about the current scene.

**Parameters:**
- None

**Example:**
```json
{
  "operation": "get_scene_info"
}
```

### get_last_scene_diff
Get the differences from the last saved scene.

**Parameters:**
- None

**Example:**
```json
{
  "operation": "get_last_scene_diff"
}
```

### serialize_scene
Serialize the current scene to a data format.

**Parameters:**
- `format` (optional) — output format (json, xml, etc.)

**Example:**
```json
{
  "operation": "serialize_scene",
  "format": "json"
}
```

### create_node
Create a new node in the network.

**Parameters:**
- `node_type` (required) — type of node (geo, sop, vop, etc.)
- `node_name` (required) — name for the node
- `parent_path` (optional) — parent node path

**Example:**
```json
{
  "operation": "create_node",
  "node_type": "geo",
  "node_name": "geometry_container",
  "parent_path": "/obj"
}
```

### get_node_info
Get detailed information about a node.

**Parameters:**
- `node_path` (required) — path to the node

**Example:**
```json
{
  "operation": "get_node_info",
  "node_path": "/obj/geometry_container/file1"
}
```

### delete_node
Delete a node from the network.

**Parameters:**
- `node_path` (required) — path to the node to delete

**Example:**
```json
{
  "operation": "delete_node",
  "node_path": "/obj/geometry_container/old_node"
}
```

### find_nodes
Find nodes by name or type.

**Parameters:**
- `search_term` (required) — node name or pattern to search for
- `node_type` (optional) — filter by node type

**Example:**
```json
{
  "operation": "find_nodes",
  "search_term": "file*",
  "node_type": "sop"
}
```

### list_node_types
List all available node types.

**Parameters:**
- `category` (optional) — filter by category (sop, vop, dop, etc.)

**Example:**
```json
{
  "operation": "list_node_types",
  "category": "sop"
}
```

### list_children
List child nodes of a parent node.

**Parameters:**
- `parent_path` (required) — path to the parent node

**Example:**
```json
{
  "operation": "list_children",
  "parent_path": "/obj/geometry_container"
}
```

### layout_children
Auto-layout child nodes for better visualization.

**Parameters:**
- `parent_path` (required) — path to the parent node

**Example:**
```json
{
  "operation": "layout_children",
  "parent_path": "/obj/geometry_container"
}
```

### set_node_position
Set the position of a node in the network.

**Parameters:**
- `node_path` (required) — path to the node
- `x` (required) — x coordinate
- `y` (required) — y coordinate

**Example:**
```json
{
  "operation": "set_node_position",
  "node_path": "/obj/geometry_container/file1",
  "x": 100,
  "y": 200
}
```

### set_node_color
Set the display color of a node.

**Parameters:**
- `node_path` (required) — path to the node
- `color` (required) — color in hex format (e.g., #FF0000)

**Example:**
```json
{
  "operation": "set_node_color",
  "node_path": "/obj/geometry_container/file1",
  "color": "#FF0000"
}
```

### set_node_flags
Set node flags (display, render, bypass, etc.).

**Parameters:**
- `node_path` (required) — path to the node
- `flags` (required) — JSON object with flag settings

**Example:**
```json
{
  "operation": "set_node_flags",
  "node_path": "/obj/geometry_container/file1",
  "flags": {
    "display": true,
    "render": true,
    "bypass": false
  }
}
```

### connect_nodes
Connect two nodes together.

**Parameters:**
- `source_node` (required) — path to source node
- `target_node` (required) — path to target node
- `source_output` (optional) — output index of source (default 0)
- `target_input` (optional) — input index of target (default 0)

**Example:**
```json
{
  "operation": "connect_nodes",
  "source_node": "/obj/geometry_container/file1",
  "target_node": "/obj/geometry_container/transform1",
  "source_output": 0,
  "target_input": 0
}
```

### disconnect_node_input
Disconnect a node input.

**Parameters:**
- `node_path` (required) — path to the node
- `input_index` (required) — input index to disconnect

**Example:**
```json
{
  "operation": "disconnect_node_input",
  "node_path": "/obj/geometry_container/transform1",
  "input_index": 0
}
```

### reorder_inputs
Reorder the inputs of a node.

**Parameters:**
- `node_path` (required) — path to the node
- `input_order` (required) — array of input indices in new order

**Example:**
```json
{
  "operation": "reorder_inputs",
  "node_path": "/obj/geometry_container/merge1",
  "input_order": [1, 0, 2]
}
```

### set_parameter
Set a parameter value on a node.

**Parameters:**
- `node_path` (required) — path to the node
- `parameter_name` (required) — name of the parameter
- `value` (required) — value to set

**Example:**
```json
{
  "operation": "set_parameter",
  "node_path": "/obj/geometry_container/transform1",
  "parameter_name": "tx",
  "value": 5.0
}
```

### get_parameter_schema
Get the schema/definition of a node's parameters.

**Parameters:**
- `node_path` (required) — path to the node

**Example:**
```json
{
  "operation": "get_parameter_schema",
  "node_path": "/obj/geometry_container/transform1"
}
```

### create_network_box
Create a network box for organizing nodes.

**Parameters:**
- `parent_path` (required) — parent node path
- `box_name` (required) — name for the network box
- `x` (optional) — x coordinate
- `y` (optional) — y coordinate

**Example:**
```json
{
  "operation": "create_network_box",
  "parent_path": "/obj/geometry_container",
  "box_name": "Modeling",
  "x": 0,
  "y": 0
}
```

### get_geo_summary
Get a summary of geometry in a node.

**Parameters:**
- `node_path` (required) — path to the geometry node

**Example:**
```json
{
  "operation": "get_geo_summary",
  "node_path": "/obj/geometry_container/file1"
}
```

### create_material
Create a new material.

**Parameters:**
- `material_name` (required) — name for the material
- `material_type` (optional) — type of material (principled, vop, etc.)

**Example:**
```json
{
  "operation": "create_material",
  "material_name": "metal_material",
  "material_type": "principled"
}
```

### get_material_info
Get information about a material.

**Parameters:**
- `material_path` (required) — path to the material

**Example:**
```json
{
  "operation": "get_material_info",
  "material_path": "/shop/metal_material"
}
```

### assign_material
Assign a material to geometry.

**Parameters:**
- `geometry_path` (required) — path to the geometry node
- `material_path` (required) — path to the material

**Example:**
```json
{
  "operation": "assign_material",
  "geometry_path": "/obj/geometry_container/file1",
  "material_path": "/shop/metal_material"
}
```

### create_render_node
Create a render node for output.

**Parameters:**
- `render_type` (required) — type of render node (rop_geometry, rop_alembic, etc.)
- `node_name` (required) — name for the render node

**Example:**
```json
{
  "operation": "create_render_node",
  "render_type": "rop_geometry",
  "node_name": "geometry_export"
}
```

### list_render_nodes
List all render nodes in the scene.

**Parameters:**
- None

**Example:**
```json
{
  "operation": "list_render_nodes"
}
```

### get_render_settings
Get current render settings.

**Parameters:**
- None

**Example:**
```json
{
  "operation": "get_render_settings"
}
```

### set_render_settings
Set render parameters.

**Parameters:**
- `settings` (required) — JSON object with render settings

**Example:**
```json
{
  "operation": "set_render_settings",
  "settings": {
    "resolution": [1920, 1080],
    "samples": 64,
    "engine": "karma"
  }
}
```

### render_viewport
Render the viewport to an image.

**Parameters:**
- `output_path` (required) — path to save the rendered image
- `width` (optional) — image width in pixels
- `height` (optional) — image height in pixels

**Example:**
```json
{
  "operation": "render_viewport",
  "output_path": "/renders/viewport_render.png",
  "width": 1920,
  "height": 1080
}
```

### render_quad_view
Render all four viewport views.

**Parameters:**
- `output_path` (required) — path to save the quad view image

**Example:**
```json
{
  "operation": "render_quad_view",
  "output_path": "/renders/quad_view.png"
}
```

### render_node_network
Render a node network diagram.

**Parameters:**
- `parent_path` (required) — path to the parent node
- `output_path` (required) — path to save the diagram

**Example:**
```json
{
  "operation": "render_node_network",
  "parent_path": "/obj/geometry_container",
  "output_path": "/renders/network_diagram.png"
}
```

### capture_pane_screenshot
Capture a screenshot of a specific pane.

**Parameters:**
- `pane_name` (required) — name of the pane to capture
- `output_path` (required) — path to save the screenshot

**Example:**
```json
{
  "operation": "capture_pane_screenshot",
  "pane_name": "viewport",
  "output_path": "/screenshots/viewport.png"
}
```

### list_visible_panes
List all visible panes in the current layout.

**Parameters:**
- None

**Example:**
```json
{
  "operation": "list_visible_panes"
}
```

### capture_multiple_panes
Capture screenshots of multiple panes.

**Parameters:**
- `pane_names` (required) — array of pane names to capture
- `output_directory` (required) — directory to save screenshots

**Example:**
```json
{
  "operation": "capture_multiple_panes",
  "pane_names": ["viewport", "network", "parameters"],
  "output_directory": "/screenshots"
}
```

### find_error_nodes
Find nodes with errors or warnings.

**Parameters:**
- `parent_path` (optional) — search within a specific parent node

**Example:**
```json
{
  "operation": "find_error_nodes",
  "parent_path": "/obj/geometry_container"
}
```

### execute_code
Execute Houdini Python code.

**Parameters:**
- `code` (required) — Python code to execute
- `context` (optional) — execution context (obj, sop, etc.)

**Example:**
```json
{
  "operation": "execute_code",
  "code": "hou.node('/obj/geometry_container').setName('new_name')",
  "context": "obj"
}
```

### manage_cache
Manage Houdini cache and memory.

**Parameters:**
- `action` (required) — action to perform (clear, optimize, status)

**Example:**
```json
{
  "operation": "manage_cache",
  "action": "clear"
}
```

### get_summarization_status
Get status of scene summarization.

**Parameters:**
- None

**Example:**
```json
{
  "operation": "get_summarization_status"
}
```

### get_houdini_help
Get help documentation for Houdini nodes or functions.

**Parameters:**
- `topic` (required) — topic to get help for

**Example:**
```json
{
  "operation": "get_houdini_help",
  "topic": "transform_node"
}
```

### category_ops
Manage node categories and organization.

**Parameters:**
- `action` (required) — action to perform (list, create, delete)
- `category_name` (optional) — name of the category

**Example:**
```json
{
  "operation": "category_ops",
  "action": "list"
}
```

## When NOT to Use
- User is asking about kitchen/recipes (use kitchen-orchestrator skill instead)
- User needs financial tracking (use surefinance skill instead)
- User needs project management (use huly skill instead)
- User needs knowledge graph or memory management (use graphiti skill instead)
