-- Whether the first admin automatically captains the first squad (1) or the tournament starts as a
-- plain player pool until someone is made captain from the Draft tab (0).
ALTER TABLE tournaments ADD COLUMN auto_captain INTEGER NOT NULL DEFAULT 1;
UPDATE tournaments SET auto_captain = 0 WHERE slug = 'home-nations-2027';

-- Home Nations stays a player pool for now: remove the squad Karl was given automatically.
DELETE FROM squad_members WHERE squad_id IN (
  SELECT s.id FROM squads s JOIN tournaments t ON t.id = s.tournament_id WHERE t.slug = 'home-nations-2027');
DELETE FROM squads WHERE tournament_id = (SELECT id FROM tournaments WHERE slug = 'home-nations-2027');
