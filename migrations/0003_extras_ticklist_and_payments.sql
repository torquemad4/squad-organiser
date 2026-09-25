-- Amount recorded when an admin ticks "paid", in minor units (cents). NULL means unpaid.
-- Storing the amount (not just a flag) lets the admin page spot totals that changed after payment.
ALTER TABLE applications ADD COLUMN paid_cents INTEGER;
ALTER TABLE applications ADD COLUMN paid_at TEXT;

-- World Cup extras become a priced tick-list (prices from nafwc.com/tickets, 25 Sep 2026).
UPDATE tournaments SET extra_fields = '[
  {"key": "extras", "label": "Extras", "type": "items", "required": false, "currency": "EUR",
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
  {"key": "allergens", "label": "Allergens", "type": "textarea", "required": true,
   "help": "List any food allergies or intolerances, or write \"None\"."}
]', dates = '16–19 September 2027', location = 'MFCC, Ta'' Qali, Malta'
WHERE slug = 'world-cup-2027';
