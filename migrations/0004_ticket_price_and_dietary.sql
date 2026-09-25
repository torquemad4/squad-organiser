-- The per-coach ticket price counts towards each person's total (minor units; NULL = no ticket charge).
ALTER TABLE tournaments ADD COLUMN ticket_price_cents INTEGER;
-- What the ticket includes, shown next to the price.
ALTER TABLE tournaments ADD COLUMN ticket_includes TEXT;

UPDATE tournaments SET
  ticket_price_cents = 19500,
  ticket_includes = 'Event entry, lunch, dice, pitch, opening party and coin',
  extra_fields = '[
  {"key": "extras", "label": "Extras", "type": "items", "required": false, "currency": "EUR",
   "link": {"href": "https://nafwc.com/tickets/", "label": "See what the ticket and each extra includes on the official tickets page"},
   "help": "Tick anything you would like bought for you with the squad tickets.",
   "items": [
     {"key": "coin", "label": "Tournament Coin", "price": 1500},
     {"key": "dice_bone", "label": "Dice set in Tin (Bone Colour)", "price": 2000},
     {"key": "dice_red_white", "label": "Dice set in Tin (Red & White)", "price": 2000},
     {"key": "dice_blue", "label": "Dice set in Tin (Blue)", "price": 2000},
     {"key": "dice_red_black", "label": "Dice set in Tin (Red & Black)", "price": 2000},
     {"key": "knight_reroll_coin", "label": "Knight Re-Roll Breakaway Coin", "price": 2800},
     {"key": "status_markers_coin", "label": "Status Markers Breakaway Coin", "price": 2800},
     {"key": "pitch", "label": "World Cup 2027 Neoprene Pitch", "price": 4000},
     {"key": "warboys", "label": "Da Warboys of Melitar", "price": 7000},
     {"key": "pack_of_legends", "label": "Pack of Legends", "price": 17500}
   ]},
  {"key": "allergens", "label": "Dietary restrictions", "type": "textarea", "required": true,
   "help": "List any dietary requirements, allergies or intolerances, or write \"None\"."}
]'
WHERE slug = 'world-cup-2027';
