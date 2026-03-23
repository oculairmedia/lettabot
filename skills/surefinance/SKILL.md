---
name: surefinance
description: Load when user asks about bank accounts, transactions, budgets, spending, money transfers, balance history, or financial management. Use for personal finance tracking and family budget coordination.
---

# SureFinance

Personal finance management system for tracking bank accounts, transactions, budgets, categories, recurring payments, transfers, and balance history with family-scoped access.

## When to Use
- User asks about account balance or account details
- User wants to view or search transactions
- User needs to create or manage budgets
- User asks about spending by category
- User wants to set up recurring payments
- User needs to transfer money between accounts
- User asks about balance history or trends
- User wants to manage transaction rules
- User needs to attach documents to transactions
- User asks about asset tracking

## Tools

### list_accounts
List all bank accounts and their current balances.

**Parameters:**
- None

**Example:**
```json
{
  "operation": "list_accounts"
}
```

### show_accounts
Get detailed information about all accounts.

**Parameters:**
- None

**Example:**
```json
{
  "operation": "show_accounts"
}
```

### show_balance_history
Get balance history for an account over time.

**Parameters:**
- `account_id` (required) — ID of the account
- `start_date` (optional) — start date in YYYY-MM-DD format
- `end_date` (optional) — end date in YYYY-MM-DD format

**Example:**
```json
{
  "operation": "show_balance_history",
  "account_id": "acc_123",
  "start_date": "2026-01-01",
  "end_date": "2026-03-09"
}
```

### list_transactions
List transactions with optional filtering.

**Parameters:**
- `account_id` (optional) — filter by account ID
- `start_date` (optional) — start date in YYYY-MM-DD format
- `end_date` (optional) — end date in YYYY-MM-DD format
- `limit` (optional) — maximum number of transactions to return

**Example:**
```json
{
  "operation": "list_transactions",
  "account_id": "acc_123",
  "start_date": "2026-02-01",
  "limit": 50
}
```

### find_transactions
Search for transactions by amount, description, or category.

**Parameters:**
- `query` (required) — search term or amount
- `category` (optional) — filter by category
- `min_amount` (optional) — minimum transaction amount
- `max_amount` (optional) — maximum transaction amount

**Example:**
```json
{
  "operation": "find_transactions",
  "query": "grocery",
  "category": "food",
  "max_amount": 100
}
```

### list_categories
List all transaction categories.

**Parameters:**
- None

**Example:**
```json
{
  "operation": "list_categories"
}
```

### category_ops
Manage transaction categories (create, update, delete).

**Parameters:**
- `action` (required) — action to perform (create, update, delete)
- `category_name` (required) — name of the category
- `category_id` (optional) — ID for update/delete operations
- `description` (optional) — category description

**Example:**
```json
{
  "operation": "category_ops",
  "action": "create",
  "category_name": "Dining Out",
  "description": "Restaurant and cafe expenses"
}
```

### show_budgets
Display all budgets and their current status.

**Parameters:**
- None

**Example:**
```json
{
  "operation": "show_budgets"
}
```

### budget_ops
Create, update, or delete budgets.

**Parameters:**
- `action` (required) — action to perform (create, update, delete)
- `budget_name` (required) — name of the budget
- `amount` (required) — budget amount
- `category` (optional) — category the budget applies to
- `period` (optional) — budget period (monthly, yearly, etc.)
- `budget_id` (optional) — ID for update/delete operations

**Example:**
```json
{
  "operation": "budget_ops",
  "action": "create",
  "budget_name": "Groceries",
  "amount": 500,
  "category": "food",
  "period": "monthly"
}
```

### recurring_ops
Manage recurring payments and subscriptions.

**Parameters:**
- `action` (required) — action to perform (create, update, delete, list)
- `name` (required) — name of the recurring payment
- `amount` (required) — payment amount
- `frequency` (required) — frequency (daily, weekly, monthly, yearly)
- `account_id` (required) — account ID for the payment
- `recurring_id` (optional) — ID for update/delete operations

**Example:**
```json
{
  "operation": "recurring_ops",
  "action": "create",
  "name": "Netflix Subscription",
  "amount": 15.99,
  "frequency": "monthly",
  "account_id": "acc_123"
}
```

### transfer_ops
Transfer money between accounts.

**Parameters:**
- `from_account_id` (required) — source account ID
- `to_account_id` (required) — destination account ID
- `amount` (required) — amount to transfer
- `description` (optional) — transfer description

**Example:**
```json
{
  "operation": "transfer_ops",
  "from_account_id": "acc_123",
  "to_account_id": "acc_456",
  "amount": 500,
  "description": "Monthly savings transfer"
}
```

### transaction_ops
Create, update, or delete transactions.

**Parameters:**
- `action` (required) — action to perform (create, update, delete)
- `account_id` (required) — account ID for the transaction
- `amount` (required) — transaction amount
- `description` (required) — transaction description
- `category` (optional) — transaction category
- `date` (optional) — transaction date in YYYY-MM-DD format
- `transaction_id` (optional) — ID for update/delete operations

**Example:**
```json
{
  "operation": "transaction_ops",
  "action": "create",
  "account_id": "acc_123",
  "amount": 45.50,
  "description": "Grocery store",
  "category": "food",
  "date": "2026-03-09"
}
```

### rule_ops
Create and manage transaction rules for automatic categorization.

**Parameters:**
- `action` (required) — action to perform (create, update, delete)
- `rule_name` (required) — name of the rule
- `condition` (required) — condition to match (e.g., description contains)
- `category` (required) — category to assign when rule matches
- `rule_id` (optional) — ID for update/delete operations

**Example:**
```json
{
  "operation": "rule_ops",
  "action": "create",
  "rule_name": "Auto-categorize Amazon",
  "condition": "description contains Amazon",
  "category": "shopping"
}
```

### attachment_ops
Attach documents or receipts to transactions.

**Parameters:**
- `action` (required) — action to perform (attach, detach, list)
- `transaction_id` (required) — transaction ID
- `file_path` (optional) — path to file to attach
- `attachment_id` (optional) — ID for detach operations

**Example:**
```json
{
  "operation": "attachment_ops",
  "action": "attach",
  "transaction_id": "txn_789",
  "file_path": "/receipts/grocery_receipt.pdf"
}
```

### asset_ops
Manage assets and investments.

**Parameters:**
- `action` (required) — action to perform (create, update, delete, list)
- `asset_name` (required) — name of the asset
- `asset_type` (required) — type of asset (stock, bond, property, etc.)
- `value` (required) — current value of the asset
- `asset_id` (optional) — ID for update/delete operations

**Example:**
```json
{
  "operation": "asset_ops",
  "action": "create",
  "asset_name": "Tesla Stock",
  "asset_type": "stock",
  "value": 5000
}
```

## When NOT to Use
- User is asking about meal planning or recipes (use kitchen-orchestrator skill instead)
- User needs project management (use huly skill instead)
- User is asking about 3D modeling or VFX (use houdini skill instead)
- User needs knowledge graph or memory management (use graphiti skill instead)
