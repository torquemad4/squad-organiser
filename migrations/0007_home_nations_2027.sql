-- Home Nations Open III (homenationsbloodbowl.com, checked 30 Sep 2026). Registration opens early
-- October 2026; ticket price not published yet, so no ticket charge until it is.
INSERT INTO tournaments (slug, name, location, dates, description, squad_size, extra_fields)
SELECT 'home-nations-2027', 'Home Nations 2027', 'Loughborough Students'' Union', '3–4 July 2027',
  'The Home Nations Open III, World Cup edition: squads of six. Sign up here and the captains will draft squads from the queue.',
  6,
  '[
    {"key": "allergens", "label": "Dietary restrictions", "type": "textarea", "required": true,
     "help": "List any dietary requirements, allergies or intolerances, or write \"None\"."}
  ]'
WHERE NOT EXISTS (SELECT 1 FROM tournaments WHERE slug = 'home-nations-2027');
