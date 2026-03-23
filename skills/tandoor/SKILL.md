---
name: tandoor
description: Recipe manager (Tandoor) — search/manage recipes, meal planning, shopping lists, keyword lookup.
---

# Tandoor Recipe Manager

Search and manage recipes, plan meals, create shopping lists, and lookup recipe keywords in Tandoor recipe management system.

## When to Use

- Searching for recipes by name or ingredients
- Planning meals and meal schedules
- Creating and managing shopping lists
- Looking up recipe keywords and tags
- Finding recipes by dietary restrictions or cuisine type

## Tools

### tandoor_lookup

Search recipes by keyword, ingredient, or tag in the recipe database.

**Parameters:**

- `query` (required) — Search query for recipes
- `search_type` (optional) — Type of search: "keyword", "ingredient", "tag", "cuisine" (default: "keyword")
- `limit` (optional) — Maximum number of results to return (default: 10)
- `filters` (optional) — Additional filters like dietary restrictions or prep time

**Example:**

```json
{
  "query": "chicken",
  "search_type": "ingredient",
  "limit": 15,
  "filters": {
    "dietary": "vegetarian",
    "max_prep_time": 30
  }
}
```

### tandoor_shopping_list

Create, manage, and retrieve shopping lists based on recipes or manual entries.

**Parameters:**

- `operation` (required) — Operation type: "create", "add_recipe", "add_item", "get", "delete"
- `list_id` (optional) — Shopping list ID for get/add/delete operations
- `recipe_id` (optional) — Recipe ID to add ingredients from
- `item` (optional) — Item to add to shopping list
- `quantity` (optional) — Quantity of item

**Example:**

```json
{
  "operation": "add_recipe",
  "list_id": "list-123",
  "recipe_id": "recipe-456"
}
```

### tandoor_meal_plan

Create and manage meal plans with recipes for specific dates.

**Parameters:**

- `operation` (required) — Operation type: "create", "add_recipe", "get", "delete", "list"
- `plan_id` (optional) — Meal plan ID for operations
- `date` (optional) — Date for meal planning (YYYY-MM-DD format)
- `meal_type` (optional) — Type of meal: "breakfast", "lunch", "dinner", "snack"
- `recipe_id` (optional) — Recipe ID to add to meal plan

**Example:**

```json
{
  "operation": "add_recipe",
  "plan_id": "plan-789",
  "date": "2026-03-15",
  "meal_type": "dinner",
  "recipe_id": "recipe-456"
}
```

### tandoor_recipes

Retrieve detailed recipe information including ingredients, instructions, and metadata.

**Parameters:**

- `operation` (required) — Operation type: "get", "list", "search"
- `recipe_id` (optional) — Recipe ID for get operations
- `query` (optional) — Search query for list/search operations
- `include_nutrition` (optional) — Include nutritional information (default: false)
- `include_instructions` (optional) — Include cooking instructions (default: true)

**Example:**

```json
{
  "operation": "get",
  "recipe_id": "recipe-456",
  "include_nutrition": true,
  "include_instructions": true
}
```

## When NOT to Use

- Do not use for user account management or authentication
- Do not use for real-time inventory tracking
- Do not use for restaurant ordering or delivery
- Do not use for accessing other users' private recipes without permission
