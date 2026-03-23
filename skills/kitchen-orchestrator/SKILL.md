---
name: kitchen-orchestrator
description: Load when user asks about meal planning, recipes, pantry inventory, shopping lists, nutrition analysis, barcode scanning, or kitchen management. Use to coordinate cooking, grocery shopping, and food inventory.
---

# Kitchen Orchestrator

Full kitchen management system integrating meal planning, pantry tracking (Grocy), recipe search (Tandoor), shopping lists, nutrition analysis, barcode scanning, and deal finding.

## When to Use
- User asks "what can I cook with these ingredients"
- User wants to plan weekly meals
- User needs a shopping list for a recipe
- User asks about pantry inventory or expiring items
- User wants nutrition analysis of meals
- User scans a barcode or adds products
- User searches for recipes or recipe details
- User wants to find deals on groceries
- User asks about ingredient substitutions
- User wants to optimize shopping or track consumed items

## Tools

### check_pantry
Check current pantry inventory and available ingredients.

**Parameters:**
- None

**Example:**
```json
{
  "operation": "check_pantry"
}
```

### check_expiring_items
Get list of items expiring soon in the pantry.

**Parameters:**
- None

**Example:**
```json
{
  "operation": "check_expiring_items"
}
```

### search_recipes
Search for recipes by name, ingredients, or cuisine type.

**Parameters:**
- `query` (required) — recipe name, ingredient, or cuisine to search for
- `limit` (optional) — maximum number of results to return

**Example:**
```json
{
  "operation": "search_recipes",
  "query": "chicken pasta",
  "limit": 10
}
```

### get_recipe_details
Get full details of a specific recipe including ingredients and instructions.

**Parameters:**
- `recipe_id` (required) — ID of the recipe to retrieve

**Example:**
```json
{
  "operation": "get_recipe_details",
  "recipe_id": "recipe_123"
}
```

### what_can_i_cook
Suggest recipes based on available pantry ingredients.

**Parameters:**
- None

**Example:**
```json
{
  "operation": "what_can_i_cook"
}
```

### plan_weekly_meals
Generate a weekly meal plan based on preferences and available ingredients.

**Parameters:**
- `days` (optional) — number of days to plan for (default 7)
- `dietary_restrictions` (optional) — comma-separated dietary restrictions

**Example:**
```json
{
  "operation": "plan_weekly_meals",
  "days": 7,
  "dietary_restrictions": "vegetarian"
}
```

### get_shopping_list
Get the current shopping list.

**Parameters:**
- None

**Example:**
```json
{
  "operation": "get_shopping_list"
}
```

### generate_shopping_list_for_recipe
Create a shopping list for a specific recipe.

**Parameters:**
- `recipe_id` (required) — ID of the recipe
- `servings` (optional) — number of servings to scale for

**Example:**
```json
{
  "operation": "generate_shopping_list_for_recipe",
  "recipe_id": "recipe_123",
  "servings": 4
}
```

### optimize_shopping_list
Optimize shopping list by finding deals and suggesting alternatives.

**Parameters:**
- None

**Example:**
```json
{
  "operation": "optimize_shopping_list"
}
```

### search_deals
Search for current deals on grocery items.

**Parameters:**
- `item` (required) — item to search deals for
- `store` (optional) — specific store to search in

**Example:**
```json
{
  "operation": "search_deals",
  "item": "chicken breast",
  "store": "whole_foods"
}
```

### scan_barcode
Scan a product barcode to add to inventory.

**Parameters:**
- `barcode` (required) — barcode number to scan
- `quantity` (optional) — quantity of items (default 1)

**Example:**
```json
{
  "operation": "scan_barcode",
  "barcode": "012345678901",
  "quantity": 2
}
```

### add_scanned_product_to_inventory
Add a scanned product to the pantry inventory.

**Parameters:**
- `product_id` (required) — ID of the scanned product
- `quantity` (required) — quantity to add
- `expiration_date` (optional) — expiration date in YYYY-MM-DD format

**Example:**
```json
{
  "operation": "add_scanned_product_to_inventory",
  "product_id": "prod_456",
  "quantity": 1,
  "expiration_date": "2026-04-09"
}
```

### search_product_nutrition
Search for nutrition information of a product.

**Parameters:**
- `product_name` (required) — name of the product
- `serving_size` (optional) — serving size for nutrition data

**Example:**
```json
{
  "operation": "search_product_nutrition",
  "product_name": "chicken breast",
  "serving_size": "100g"
}
```

### analyze_pantry_nutrition
Analyze nutritional content of current pantry inventory.

**Parameters:**
- None

**Example:**
```json
{
  "operation": "analyze_pantry_nutrition"
}
```

### find_healthier_alternatives
Find healthier alternatives to a food item.

**Parameters:**
- `item` (required) — food item to find alternatives for
- `dietary_goal` (optional) — health goal (e.g., low-carb, high-protein)

**Example:**
```json
{
  "operation": "find_healthier_alternatives",
  "item": "white bread",
  "dietary_goal": "high-fiber"
}
```

### suggest_ingredient_substitution
Suggest substitutes for an ingredient in a recipe.

**Parameters:**
- `ingredient` (required) — ingredient to substitute
- `reason` (optional) — reason for substitution (e.g., allergy, unavailable)

**Example:**
```json
{
  "operation": "suggest_ingredient_substitution",
  "ingredient": "butter",
  "reason": "dairy-free"
}
```

### scale_recipe
Scale a recipe to a different number of servings.

**Parameters:**
- `recipe_id` (required) — ID of the recipe to scale
- `servings` (required) — target number of servings

**Example:**
```json
{
  "operation": "scale_recipe",
  "recipe_id": "recipe_123",
  "servings": 6
}
```

### use_expiring_items
Get recipe suggestions using items that are expiring soon.

**Parameters:**
- None

**Example:**
```json
{
  "operation": "use_expiring_items"
}
```

### track_consumed_item
Log consumption of a pantry item.

**Parameters:**
- `item_id` (required) — ID of the item consumed
- `quantity` (required) — quantity consumed

**Example:**
```json
{
  "operation": "track_consumed_item",
  "item_id": "item_789",
  "quantity": 1
}
```

### get_price_history
Get historical price data for a product.

**Parameters:**
- `product_id` (required) — ID of the product
- `days` (optional) — number of days of history to retrieve

**Example:**
```json
{
  "operation": "get_price_history",
  "product_id": "prod_456",
  "days": 30
}
```

### get_meal_prep_plan
Generate a meal prep plan for the week.

**Parameters:**
- `servings` (optional) — number of servings per meal
- `prep_time` (optional) — maximum prep time in minutes

**Example:**
```json
{
  "operation": "get_meal_prep_plan",
  "servings": 4,
  "prep_time": 120
}
```

### sync_grocy_to_tandoor
Synchronize Grocy pantry inventory with Tandoor recipe system.

**Parameters:**
- None

**Example:**
```json
{
  "operation": "sync_grocy_to_tandoor"
}
```

## When NOT to Use
- User is asking about non-food topics
- User needs financial tracking (use surefinance skill instead)
- User is asking about project management (use huly skill instead)
- User needs 3D modeling or VFX work (use houdini skill instead)
