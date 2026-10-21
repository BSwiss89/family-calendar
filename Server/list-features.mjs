// Offline category suggestions for Shopping and To-Do lists.
// Conservative by design: unmatched/ambiguous items are left in General.
// The category vocabulary lives in one module shared by the backend and UI.
export const DEFAULT_LIST_CATEGORY = 'General'

// Public category choices; free-form categories remain supported.
export const SUGGESTED_LIST_CATEGORIES = Object.freeze([
  'Produce', 'Bakery', 'Meat', 'Seafood', 'Deli', 'Dairy',
  'Frozen', 'Pantry', 'Snacks', 'Beverages', 'Household',
  'Personal Care', 'Pet Supplies', 'Baby', 'Health', 'Errands', 'Work',
])

const categoryRules = [
  ['Pet Supplies', ['dog food', 'cat food', 'pet food', 'dog treats', 'cat treats', 'cat litter', 'litter box', 'puppy pads', 'dog toys', 'cat toys', 'flea collar']],
  ['Baby', ['baby formula', 'baby food', 'diapers', 'nappies', 'baby wipes', 'baby lotion', 'baby shampoo', 'pacifier', 'pacifiers']],
  ['Household', ['paper towel', 'paper towels', 'toilet paper', 'trash bag', 'trash bags', 'garbage bag', 'garbage bags', 'dish soap', 'dishwasher detergent', 'laundry detergent', 'laundry pods', 'fabric softener', 'bleach', 'cleaning spray', 'cleaner', 'sponges', 'sponge', 'aluminum foil', 'cling wrap', 'plastic wrap', 'sandwich bags', 'ziplock bags', 'ziploc bags', 'batteries', 'light bulbs']],
  ['Personal Care', ['shampoo', 'conditioner', 'body wash', 'soap bars', 'hand soap', 'toothpaste', 'toothbrush', 'toothbrushes', 'deodorant', 'razors', 'shaving cream', 'face wash', 'face wipes', 'moisturizer', 'sunscreen', 'tampons', 'pads', 'floss']],
  ['Health', ['band aids', 'bandaids', 'first aid kit', 'vitamins', 'vitamin d', 'pain reliever', 'ibuprofen', 'acetaminophen', 'allergy medicine', 'cough drops', 'thermometer']],
  ['Frozen', ['frozen pizza', 'frozen peas', 'frozen vegetables', 'frozen veggie', 'frozen berries', 'frozen fruit', 'frozen chicken', 'frozen fries', 'ice cream', 'popsicles', 'frozen waffles', 'frozen dinners']],
  ['Dairy', ['milk', '2% milk', 'whole milk', 'skim milk', 'chocolate milk', 'almond milk', 'oat milk', 'soy milk', 'cheese', 'cheddar', 'mozzarella', 'parmesan', 'yogurt', 'greek yogurt', 'butter', 'sour cream', 'cream cheese', 'half and half', 'heavy cream', 'eggs', 'egg whites']],
  ['Seafood', ['salmon', 'shrimp', 'tilapia', 'cod fillets', 'catfish', 'tuna steaks', 'fish fillets', 'crab legs', 'scallops', 'lobster']],
  ['Meat', ['ground beef', 'ground turkey', 'ground chicken', 'chicken breast', 'chicken thighs', 'chicken wings', 'chicken drumsticks', 'pork chops', 'pork tenderloin', 'pork shoulder', 'steak', 'ribeye', 'sirloin', 'brisket', 'bacon', 'sausage', 'hot dogs', 'hamburger patties', 'beef roast', 'turkey breast']],
  ['Deli', ['rotisserie chicken', 'deli turkey', 'deli ham', 'sliced turkey', 'sliced ham', 'lunch meat', 'salami', 'prosciutto', 'hummus', 'prepared salad']],
  ['Produce', ['apples', 'apple', 'bananas', 'banana', 'oranges', 'orange', 'lemons', 'lemon', 'limes', 'lime', 'avocados', 'avocado', 'lettuce', 'spinach', 'kale', 'tomatoes', 'tomato', 'potatoes', 'potato', 'onions', 'onion', 'garlic', 'carrots', 'carrot', 'broccoli', 'cauliflower', 'cucumber', 'cucumbers', 'bell peppers', 'jalapenos', 'strawberries', 'strawberry', 'blueberries', 'blueberry', 'raspberries', 'grapes', 'grape', 'watermelon', 'pineapple', 'celery', 'mushrooms', 'mushroom', 'cilantro', 'parsley', 'zucchini', 'squash', 'sweet potato', 'sweet potatoes']],
  ['Bakery', ['bread', 'bagels', 'bagel', 'tortillas', 'tortilla', 'croissants', 'croissant', 'muffins', 'muffin', 'donuts', 'donut', 'buns', 'hamburger buns', 'hot dog buns', 'bakery cake', 'cupcakes', 'cupcake', 'dinner rolls']],
  ['Beverages', ['coke zero', 'diet coke', 'soda', 'soft drinks', 'sparkling water', 'bottled water', 'drinking water', 'energy drink', 'monster zero', 'gatorade', 'powerade', 'coffee', 'coffee beans', 'tea bags', 'orange juice', 'apple juice', 'lemonade']],
  ['Snacks', ['chips', 'potato chips', 'tortilla chips', 'pretzels', 'popcorn', 'crackers', 'granola bars', 'protein bars', 'cookies', 'candy', 'chocolate bars', 'trail mix', 'fruit snacks']],
  ['Pantry', ['rice', 'pasta', 'spaghetti', 'macaroni', 'flour', 'sugar', 'salt', 'black pepper', 'olive oil', 'vegetable oil', 'cooking oil', 'cereal', 'oatmeal', 'peanut butter', 'jelly', 'jam', 'ketchup', 'mustard', 'mayonnaise', 'mayo', 'hot sauce', 'pasta sauce', 'tomato sauce', 'canned beans', 'canned corn', 'canned soup', 'broth', 'stock', 'beans', 'canned tomatoes']],
  ['Errands', ['pick up prescription', 'mail package', 'post office', 'drop off package', 'return package', 'dry cleaning', 'car wash', 'oil change']],
  ['Work', ['work gloves', 'work boots', 'work uniform', 'printer paper', 'printer ink', 'pens', 'sticky notes']],
]

const normalized = (value) => value
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()
  .replace(/\s+/g, ' ')

// Match whole words/phrases, not substrings: "soap" must not match "soapstone".
export function suggestListCategory(value) {
  if (typeof value !== 'string') return null
  const item = normalized(value)
  if (!item) return null
  const haystack = ' ' + item + ' '
  for (const [category, names] of categoryRules) {
    if (names.some(name => haystack.includes(' ' + normalized(name) + ' '))) return category
  }
  return null
}

export function normalizeListCategory(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_LIST_CATEGORY
  if (typeof value !== 'string') throw new TypeError('Category must be text.')
  const category = value.trim()
  if (!category) return DEFAULT_LIST_CATEGORY
  if (category.length > 40) throw new RangeError('Category must be 40 characters or fewer.')
  return category
}

export function ensureListItemCategories(database) {
  const columns = database.prepare('PRAGMA table_info(list_items)').all()
  if (!columns.some(column => column.name === 'category')) {
    // Additive migration: keeps every existing list item and marks it General.
    database.exec("ALTER TABLE list_items ADD COLUMN category TEXT NOT NULL DEFAULT 'General'")
  }
}

// Organize only still-General items for one selected list. Never mutate item text,
// completion, sort_order, or user-selected non-General category.
export function organizeExistingListItems(database, listId) {
  const existing = database.prepare('SELECT id FROM lists WHERE id = ?').get(listId)
  if (!existing) return null
  const rows = database.prepare(
    "SELECT id, text FROM list_items WHERE list_id = ? AND category = 'General' ORDER BY id"
  ).all(listId)
  let categorized = 0
  database.exec('BEGIN IMMEDIATE')
  try {
    const update = database.prepare(
      "UPDATE list_items SET category = ? WHERE id = ? AND list_id = ? AND category = 'General'"
    )
    for (const item of rows) {
      const category = suggestListCategory(item.text)
      if (category) categorized += update.run(category, item.id, listId).changes
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
  return { categorized, remainingGeneral: rows.length - categorized }
}
