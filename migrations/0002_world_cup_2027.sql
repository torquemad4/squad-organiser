INSERT INTO tournaments (slug, name, location, dates, description, squad_size, extra_fields)
VALUES (
  'world-cup-2027',
  'Blood Bowl World Cup 2027',
  'Malta',
  '2027',
  'Squads of six. Sign up here and the captains will draft squads from the pool.',
  6,
  '[
    {"key": "extras", "label": "Optional extras purchase requests", "type": "textarea", "required": false,
     "help": "Anything extra you would like bought for you, e.g. event merch or dinner tickets. Leave blank if none."},
    {"key": "allergens", "label": "Allergens", "type": "textarea", "required": true,
     "help": "List any food allergies or intolerances, or write \"None\"."}
  ]'
);
